import type {
  ClipboardSelectionType,
  IClipboardProvider,
} from "@xterm/addon-clipboard";
import { t } from "./i18n";

type ClipboardWriter = Pick<Clipboard, "writeText"> &
  Partial<Pick<Clipboard, "write">>;
export type ClipboardContent = { text: string; html?: string };
export const MAX_TERMINAL_CLIPBOARD_CHARS = 100_000;
export const MAX_TERMINAL_CLIPBOARD_BASE64_CHARS = 256 * 1024;
const STANDARD_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Remove visual cell padding while preserving the selected line structure. */
export function normalizeTerminalSelection(text: string): string {
  return text.replace(/[ \t]+(?=\r?\n|$)/g, "");
}

interface TerminalClipboardProviderOptions {
  clipboard?: ClipboardWriter | null;
  fallback?: (text: string) => boolean;
  canWrite?: () => boolean;
  onWriteStart?: () => void;
  onWriteError?: (error: Error, retryText: string | null) => void;
  format?: (text: string) => Promise<ClipboardContent>;
}

function clipboardError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(
        typeof error === "string" ? error : t("clipboard access failed"),
      );
}

function copyWithDocument(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;

  const previousFocus = document.activeElement;
  const selection = document.getSelection();
  const range = selection?.rangeCount
    ? selection.getRangeAt(0).cloneRange()
    : null;
  const backwards =
    selection?.anchorNode === range?.endContainer &&
    selection?.anchorOffset === range?.endOffset;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  Object.assign(textarea.style, {
    position: "fixed",
    inset: "0 auto auto -10000px",
    opacity: "0",
  });
  document.body.appendChild(textarea);

  let copied: boolean;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    // iOS ignores select() on a read-only field; an explicit range selects it.
    textarea.setSelectionRange(0, text.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus({ preventScroll: true });
    }
    if (range?.startContainer.isConnected && range.endContainer.isConnected) {
      selection?.setBaseAndExtent(
        backwards ? range.endContainer : range.startContainer,
        backwards ? range.endOffset : range.startOffset,
        backwards ? range.startContainer : range.endContainer,
        backwards ? range.startOffset : range.endOffset,
      );
    }
  }
  return copied;
}

/** Safely decodes Herdr's dedicated base64 clipboard payload as UTF-8 text. */
export function decodeTerminalClipboard(data: string): string | null {
  if (
    !data ||
    data.length > MAX_TERMINAL_CLIPBOARD_BASE64_CHARS ||
    !STANDARD_BASE64_RE.test(data)
  ) {
    return null;
  }
  try {
    const binary = atob(data);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function writeClipboardText(
  text: string,
  clipboard: ClipboardWriter | null,
  fallback: (text: string) => boolean,
): Promise<void> {
  let failure: unknown;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch (error) {
      failure = error;
    }
  }

  try {
    if (fallback(text)) return;
  } catch (error) {
    failure ??= error;
  }

  throw clipboardError(failure ?? t("browser clipboard access is unavailable"));
}

/** Copy from a real button click or terminal keyboard shortcut. */
export async function copyTextFromUserGesture(
  text: string,
  options: Pick<TerminalClipboardProviderOptions, "clipboard" | "fallback"> & {
    html?: string;
  } = {},
): Promise<void> {
  const fallback = options.fallback ?? copyWithDocument;
  const clipboard =
    options.clipboard === undefined
      ? typeof navigator !== "undefined"
        ? navigator.clipboard
        : null
      : options.clipboard;
  // The Clipboard API call starts synchronously inside the gesture, which is
  // what WebKit requires. iOS execCommand("copy") can report success without
  // copying, so it is only the fallback (insecure origins, older browsers).
  if (
    options.html &&
    clipboard?.write &&
    typeof ClipboardItem !== "undefined"
  ) {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([options.html], { type: "text/html" }),
        }),
      ]);
      return;
    } catch {
      // Older browsers may expose write() but reject HTML. Keep plain copy.
    }
  }
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch (error) {
      if (fallback(text)) return;
      throw clipboardError(error);
    }
  }
  if (fallback(text)) return;
  throw new Error(t("browser clipboard access is unavailable"));
}

export interface PendingClipboardWrite {
  resolve(text: string): Promise<void>;
  cancel(): void;
}

/**
 * Reserve a clipboard write inside a user gesture for text that arrives later
 * (a terminal app copying via OSC 52 after a drag). WebKit rejects writes
 * made outside the gesture, but accepts a ClipboardItem whose content is a
 * promise created during it. Returns null where that is unsupported.
 */
export function reserveClipboardWrite(
  timeoutMs = 4000,
  format?: (text: string) => Promise<ClipboardContent>,
): PendingClipboardWrite | null {
  if (
    typeof window === "undefined" ||
    !window.isSecureContext ||
    typeof ClipboardItem === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.clipboard?.write
  )
    return null;
  let settle!: (text: string | null) => void;
  const content = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(() => settle(null), timeoutMs);
  const formatted = content.then(async (text): Promise<ClipboardContent> => {
    if (text === null) throw new Error(t("no terminal clipboard arrived"));
    return format ? format(text) : { text };
  });
  const written = navigator.clipboard
    .write([
      new ClipboardItem({
        "text/plain": formatted.then(({ text }) => {
          return new Blob([text], { type: "text/plain" });
        }),
        ...(format
          ? {
              "text/html": formatted.then(
                ({ html }) => new Blob([html ?? ""], { type: "text/html" }),
              ),
            }
          : {}),
      }),
    ])
    .finally(() => clearTimeout(timer));
  // An unused reservation rejects quietly.
  written.catch(() => {});
  return {
    resolve(text) {
      settle(text);
      return written;
    },
    cancel() {
      settle(null);
    },
  };
}

/** Allow OSC 52 writes while deliberately refusing terminal clipboard reads. */
export function createTerminalClipboardProvider(
  options: TerminalClipboardProviderOptions = {},
): IClipboardProvider {
  const clipboard =
    options.clipboard === undefined
      ? typeof navigator !== "undefined"
        ? navigator.clipboard
        : null
      : options.clipboard;
  const fallback = options.fallback ?? copyWithDocument;
  let writeSequence = 0;

  return {
    // A remote terminal must never be able to exfiltrate the browser clipboard.
    readText() {
      return "";
    },
    writeText(selection: ClipboardSelectionType, text: string) {
      if (selection !== "c" || !text || options.canWrite?.() === false) return;
      const sequence = ++writeSequence;
      options.onWriteStart?.();
      if (text.length > MAX_TERMINAL_CLIPBOARD_CHARS) {
        options.onWriteError?.(
          new Error(
            t("terminal clipboard payload exceeds the 100,000 character limit"),
          ),
          null,
        );
        return;
      }

      // Clipboard permissions may wait on browser UI. Keep that promise out of
      // xterm's OSC handler so terminal output parsing can never stall behind it.
      const write =
        options.format &&
        clipboard?.write &&
        typeof ClipboardItem !== "undefined"
          ? options.format(text).then((content) => {
              if (sequence !== writeSequence || options.canWrite?.() === false)
                return;
              return copyTextFromUserGesture(content.text, {
                clipboard,
                fallback,
                html: content.html,
              });
            })
          : writeClipboardText(text, clipboard, fallback);
      void write.catch((error) => {
        if (sequence !== writeSequence) return;
        options.onWriteError?.(clipboardError(error), text);
      });
    },
  };
}
