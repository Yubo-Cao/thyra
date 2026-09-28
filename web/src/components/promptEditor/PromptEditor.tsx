import type { ITheme, Terminal } from "@xterm/xterm";
import { Eye, PenLine, X } from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { AgentKind } from "../../agentKind";
import { t } from "../../i18n";
import { idlePrefetchAllowed } from "../../idlePrefetch";
import { lazyPanel } from "../../lazyWithReload";
import {
  type PromptEditorPlacement,
  promptEditorFrame,
  promptEditorPlacement,
  scanPromptBox,
  agentInputHasText,
} from "../../promptBoxDetect";
import { promptEditorKeyAction } from "../../promptEditorKeys";
import {
  getShortcutSnapshot,
  shortcutLabel,
  shortcutMatches,
  shortcutTitle,
} from "../../shortcutPreferences";
import { useStartupSettled } from "../../startupGate";
import {
  clipboardImageFiles,
  insertIntoTerminalComposerDraft,
  readTerminalComposerDraft,
  readTerminalComposerSelection,
  submitTerminalComposerDraft,
  uploadTerminalComposerImages,
  writeTerminalComposerDraft,
  writeTerminalComposerSelection,
} from "../../terminalComposer";
import { useTerminalComposerDraft } from "../../useTerminalComposerDraft";
import { useDocumentTheme } from "../documentTheme";
import { LazyBoundary } from "../LazyBoundary";
import { IconButton } from "../ui/IconButton";
import { PromptTextarea } from "./PromptTextarea";
import type {
  PromptEditorFont,
  PromptEditorSurface,
  PromptEditorSurfaceProps,
} from "./surface";
import "./PromptEditor.css";

const promptMonacoPanel = lazyPanel("prompt-editor-monaco", () =>
  import("./PromptMonaco").then((module) => module.PromptMonaco),
);
const markdownPreviewPanel = lazyPanel("prompt-editor-preview", () =>
  import("../markdown").then((module) => module.MarkdownPreview),
);
const PromptMonaco = promptMonacoPanel.Component;
const MarkdownPreview = markdownPreviewPanel.Component;

// Frames can arrive at display rate; the agent's box moves far less often.
const SCAN_INTERVAL_MS = 100;
// Text the agent shows in its own box must stay this long to take over, and
// a send (whose paste passes through the box) holds that off for a while.
const AGENT_TEXT_SETTLE_MS = 250;
const SEND_GRACE_MS = 1500;
// The agent's own prompt glyph in the gutter, where it drew it.
const PROMPT_MARKERS: Partial<Record<AgentKind, string>> = {
  claude: "❯",
  codex: "›",
};

/** How TerminalView reaches the editor of its pane. */
export type PromptEditorControl = {
  /** Focuses the editor; false while it is hidden. */
  focus(): boolean;
  hasFocus(): boolean;
  /** Shown over the pane (not hidden for an agent menu). */
  visible(): boolean;
};

export type PromptEditorProps = {
  draftKey: string;
  agent: AgentKind;
  term: Terminal;
  terminalTheme: ITheme;
  /** The pane is the selected one; only it takes focus. */
  active: boolean;
  /** The pane shows a text preview instead of the screen: dock at the bottom. */
  dockOnly: boolean;
  controlRef: RefObject<PromptEditorControl | null>;
  onSubmit: (text: string) => Promise<void>;
  onForward: (data: string) => void;
  onPage: (direction: "up" | "down") => void;
  onUploadImage: (file: File) => Promise<string>;
  onError: (message: string) => void;
  onClose: () => void;
  onFocusTerminal: () => void;
};

type TerminalMetrics = {
  left: number;
  top: number;
  width: number;
  rows: number;
  rowHeight: number;
  cellWidth: number;
  fontSize: number;
};

function visibleRows(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let row = 0; row < term.rows; row++)
    rows.push(
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
    );
  return rows;
}

/** Rows `from`..`to` with dim cells (agent placeholder hints) blanked. */
function undimmedRows(term: Terminal, from: number, to: number): string[] {
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  const rows: string[] = [];
  for (let row = from; row <= to; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    let text = "";
    for (let col = 0; line && col < line.length; col++) {
      line.getCell(col, cell);
      if (cell.getWidth() === 0) continue;
      text += cell.isDim() ? " " : cell.getChars() || " ";
    }
    rows[row] = text;
  }
  return rows;
}

/** The terminal grid in the editor's coordinates (CSS zoom and follow scale included). */
function measureTerminal(
  term: Terminal,
  host: HTMLElement | null,
): TerminalMetrics | null {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!host || !screen || !screen.offsetHeight || !term.rows || !term.cols)
    return null;
  const bounds = screen.getBoundingClientRect();
  const origin = host.getBoundingClientRect();
  const scale = bounds.height / screen.offsetHeight;
  return {
    left: bounds.left - origin.left,
    top: bounds.top - origin.top,
    width: bounds.width,
    rows: term.rows,
    rowHeight: bounds.height / term.rows,
    cellWidth: bounds.width / term.cols,
    fontSize: (term.options.fontSize ?? 13) * scale,
  };
}

function samePlacement(a: PromptEditorPlacement, b: PromptEditorPlacement) {
  if (a.mode !== b.mode) return false;
  if (a.mode !== "overlay" || b.mode !== "overlay") return true;
  return a.region.top === b.region.top && a.region.bottom === b.region.bottom;
}

function sameMetrics(a: TerminalMetrics | null, b: TerminalMetrics | null) {
  if (!a || !b) return a === b;
  return (Object.keys(a) as (keyof TerminalMetrics)[]).every(
    (key) => Math.abs(a[key] - b[key]) < 0.01,
  );
}

/** Loads Monaco once startup has settled, unless the link is metered or 2G. */
function useRichSurface() {
  const settled = useStartupSettled();
  const [ready, setReady] = useState(promptMonacoPanel.isLoaded);
  useEffect(() => {
    if (!settled || ready || !idlePrefetchAllowed()) return;
    let cancelled = false;
    const load = () =>
      void promptMonacoPanel.preload().then(() => {
        if (!cancelled && promptMonacoPanel.isLoaded()) setReady(true);
      });
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(load, { timeout: 3000 })
      : window.setTimeout(load, 250);
    return () => {
      cancelled = true;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  }, [ready, settled]);
  return ready;
}

/** "Ctrl+↵" or "⌘↵" for the composer send shortcut. */
function sendKeys() {
  const keys = shortcutLabel("composer.send").split(" / ")[0];
  return keys.replace(/Enter/g, "↵").replace(/^Cmd\+/, "⌘");
}

/**
 * A local prompt editor laid over a coding agent's own input box. Typing is
 * instant because nothing reaches the pane until the draft is sent: on slow
 * links every keystroke into the agent's box would wait for a round trip and
 * a repaint. The terminal grid is scanned as frames arrive to find the box;
 * the editor covers it in the terminal's font and colours, grows upward with
 * the draft, hides while the agent shows a menu or dialog (so keys reach it),
 * and docks at the bottom for agents without a detector.
 */
export function PromptEditor({
  draftKey,
  agent,
  term,
  terminalTheme,
  active,
  dockOnly,
  controlRef,
  onSubmit,
  onForward,
  onPage,
  onUploadImage,
  onError,
  onClose,
  onFocusTerminal,
}: PromptEditorProps) {
  const { text, submissionPending, uploadCount } =
    useTerminalComposerDraft(draftKey);
  const theme = useDocumentTheme();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<PromptEditorSurface | null>(null);
  const [placement, setPlacement] = useState<PromptEditorPlacement>({
    mode: "hidden",
  });
  const [metrics, setMetrics] = useState<TerminalMetrics | null>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const [preview, setPreview] = useState(false);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const boxSeen = useRef(false);
  const sentAt = useRef(Number.NEGATIVE_INFINITY);

  // Scan the grid for the agent's box as frames land, and follow resizes.
  useEffect(() => {
    let timer: number | null = null;
    let last = 0;
    let agentTextSince: number | null = null;
    const scan = () => {
      timer = null;
      const now = performance.now();
      last = now;
      const result = dockOnly
        ? ({ state: "unsupported" } as const)
        : scanPromptBox(agent, visibleRows(term), term.cols);
      // Text in the agent's own box yields to it once it has stayed a
      // moment, and never right after a send, whose paste briefly shows there.
      let agentText = false;
      if (result.state === "box") {
        boxSeen.current = true;
        const { inputTop, inputBottom } = result.region;
        agentText = agentInputHasText(
          undimmedRows(term, inputTop, inputBottom),
          result.region,
        );
      }
      agentTextSince = agentText ? (agentTextSince ?? now) : null;
      const settleAt =
        agentTextSince === null
          ? now
          : Math.max(
              agentTextSince + AGENT_TEXT_SETTLE_MS,
              sentAt.current + SEND_GRACE_MS,
            );
      if (settleAt > now) schedule(settleAt - now);
      const next = promptEditorPlacement(
        result,
        boxSeen.current,
        agentText && settleAt <= now,
      );
      setPlacement((current) =>
        samePlacement(current, next) ? current : next,
      );
      const measured = measureTerminal(
        term,
        rootRef.current?.parentElement ?? null,
      );
      setMetrics((current) =>
        sameMetrics(current, measured) ? current : measured,
      );
    };
    const schedule = (
      delay = SCAN_INTERVAL_MS - (performance.now() - last),
    ) => {
      if (timer !== null) return;
      timer = window.setTimeout(scan, Math.max(0, delay));
    };
    scan();
    const parsed = term.onWriteParsed(() => schedule());
    const resized = term.onResize(() => schedule());
    const observer = new ResizeObserver(() => schedule());
    if (term.element) observer.observe(term.element);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      parsed.dispose();
      resized.dispose();
      observer.disconnect();
    };
  }, [agent, dockOnly, term]);

  const hidden = placement.mode === "hidden";
  const frame =
    metrics &&
    promptEditorFrame(
      placement,
      metrics.rows,
      Math.max(1, Math.ceil(contentHeight / metrics.rowHeight - 0.01)),
    );

  // A menu took the agent's box: hand its keys to the terminal, and take
  // them back when the box returns if the terminal still has them.
  const handedToTerminal = useRef(false);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (hidden) {
      if (root?.contains(document.activeElement)) {
        handedToTerminal.current = true;
        onFocusTerminal();
      }
      return;
    }
    if (!handedToTerminal.current) return;
    handedToTerminal.current = false;
    const focused = document.activeElement;
    if (
      !focused ||
      focused === document.body ||
      term.element?.contains(focused)
    )
      surfaceRef.current?.focus();
  }, [hidden, onFocusTerminal, term]);

  // The active pane's editor takes over from the terminal once it first shows.
  const visible = !hidden && !!metrics;
  const shown = useRef(false);
  useLayoutEffect(() => {
    if (!visible || !active || shown.current) return;
    shown.current = true;
    const focused = document.activeElement;
    if (
      !focused ||
      focused === document.body ||
      term.element?.contains(focused)
    )
      surfaceRef.current?.focus();
  }, [active, term, visible]);

  useLayoutEffect(() => {
    controlRef.current = {
      focus: () => {
        if (hidden || !surfaceRef.current) return false;
        setPreview(false);
        surfaceRef.current.focus();
        return true;
      },
      hasFocus: () => !!rootRef.current?.contains(document.activeElement),
      visible: () => !hidden,
    };
  });
  useEffect(
    () => () => {
      controlRef.current = null;
    },
    [controlRef],
  );

  // Outside changes to the draft (a send clearing it, a failed send or an
  // upload restoring text) reach the surface; local typing is already there.
  useEffect(() => {
    surfaceRef.current?.setText(
      text,
      readTerminalComposerSelection(draftKey)?.end,
    );
  }, [draftKey, text]);

  // Swap the textarea for Monaco when it arrives, never mid-composition.
  const richReady = useRichSurface();
  const [rich, setRich] = useState(richReady);
  const focusRich = useRef(false);
  useEffect(() => {
    if (!richReady || rich || composing) return;
    focusRich.current = !!surfaceRef.current?.hasFocus();
    setRich(true);
  }, [composing, rich, richReady]);

  const send = async () => {
    if (composingRef.current) return;
    try {
      await submitTerminalComposerDraft(
        draftKey,
        readTerminalComposerDraft(draftKey),
        (draft) => {
          sentAt.current = performance.now();
          return onSubmit(draft);
        },
      );
    } catch (error) {
      onError(
        error instanceof Error ? error.message : t("Failed to send input"),
      );
    }
  };
  const togglePreview = () => {
    setPreview((open) => {
      if (open) requestAnimationFrame(() => surfaceRef.current?.focus());
      else requestAnimationFrame(() => rootRef.current?.focus());
      return !open;
    });
  };
  const onKey = (event: KeyboardEvent, empty: boolean) => {
    if (shortcutMatches(event, "composer.preview")) {
      togglePreview();
      return true;
    }
    const action = promptEditorKeyAction(event, {
      empty,
      applicationCursor: term.modes.applicationCursorKeysMode,
      bindings: getShortcutSnapshot().preset.bindings,
    });
    if (!action) return false;
    if (action.type === "send") void send();
    else if (action.type === "newline") surfaceRef.current?.insertText("\n");
    else if (action.type === "forward") onForward(action.data);
    else onPage(action.direction);
    return true;
  };
  const onPasteFiles = (data: DataTransfer | null) => {
    const images = clipboardImageFiles(data);
    if (images.length === 0) return false;
    void uploadTerminalComposerImages(
      draftKey,
      images,
      onUploadImage,
      (key, path) => {
        const selection =
          key === draftKey ? surfaceRef.current?.selection() : null;
        insertIntoTerminalComposerDraft(
          key,
          path,
          selection?.start,
          selection?.end,
        );
      },
    ).catch((error) =>
      onError(
        error instanceof Error ? error.message : t("Image upload failed"),
      ),
    );
    return true;
  };

  const font: PromptEditorFont = {
    family: term.options.fontFamily ?? "monospace",
    size: metrics?.fontSize ?? term.options.fontSize ?? 13,
    lineHeight: metrics?.rowHeight ?? 17,
  };
  const surfaceProps: PromptEditorSurfaceProps = {
    surfaceRef,
    initialText: readTerminalComposerDraft(draftKey),
    initialSelection: readTerminalComposerSelection(draftKey),
    focus: focusRich.current,
    placeholder: t("Write a prompt for the agent"),
    label: t("Prompt editor"),
    font,
    onChange: (next, start, end) => {
      writeTerminalComposerDraft(draftKey, next);
      writeTerminalComposerSelection(draftKey, start, end);
    },
    onKey,
    onPasteFiles,
    // A hidden surface (under the preview) measures at zero width: keep the
    // height it had.
    onContentHeight: (height) => {
      if (!previewRef.current) setContentHeight(height);
    },
    onCompositionChange: (active) => {
      composingRef.current = active;
      setComposing(active);
    },
  };

  const style =
    metrics && frame
      ? ({
          left: metrics.left,
          top: metrics.top + frame.top * metrics.rowHeight,
          width: metrics.width,
          height: frame.rows * metrics.rowHeight,
          "--prompt-editor-row": `${metrics.rowHeight}px`,
          "--prompt-editor-cell": `${metrics.cellWidth}px`,
          "--prompt-editor-pad-top": `${frame.padTop * metrics.rowHeight}px`,
          "--prompt-editor-pad-bottom": `${frame.padBottom * metrics.rowHeight}px`,
          "--prompt-editor-font-size": `${font.size}px`,
          "--prompt-editor-bg": terminalTheme.background,
          "--prompt-editor-fg": terminalTheme.foreground,
          "--prompt-editor-caret": terminalTheme.cursor,
          "--prompt-editor-selection": terminalTheme.selectionBackground,
          fontFamily: font.family,
        } as CSSProperties)
      : undefined;
  const busy = uploadCount > 0 || submissionPending;
  const status =
    uploadCount > 0
      ? t("Uploading image…")
      : submissionPending
        ? t("Sending…")
        : `${sendKeys()} ${t("Send")}`;
  const marker = PROMPT_MARKERS[agent] ?? ">";

  return (
    <div
      ref={rootRef}
      className="prompt-editor"
      role="group"
      aria-label={t("Prompt editor")}
      data-mode={placement.mode}
      data-preview={preview || undefined}
      hidden={!visible}
      style={style}
      tabIndex={-1}
      onKeyDown={(event) => {
        // Keys that reach the frame itself come from the Markdown preview.
        if (event.target !== event.currentTarget) return;
        if (
          shortcutMatches(event.nativeEvent, "composer.preview") ||
          event.key === "Escape"
        ) {
          event.preventDefault();
          togglePreview();
        }
      }}
    >
      <span className="prompt-editor-marker" aria-hidden="true">
        {marker}
      </span>
      <div className="prompt-editor-body" hidden={preview}>
        {rich ? (
          <LazyBoundary>
            <PromptMonaco {...surfaceProps} theme={theme} />
          </LazyBoundary>
        ) : (
          <PromptTextarea {...surfaceProps} />
        )}
      </div>
      {preview ? (
        <div className="prompt-editor-preview">
          <LazyBoundary>
            <MarkdownPreview text={text || t("Nothing to preview")} breaks />
          </LazyBoundary>
        </div>
      ) : null}
      <div className="prompt-editor-actions">
        <span
          className="prompt-editor-hint"
          aria-live="polite"
          data-busy={busy || undefined}
        >
          {status}
        </span>
        <IconButton
          className="prompt-editor-action"
          label={shortcutTitle(
            preview ? t("Edit the prompt") : t("Preview Markdown"),
            "composer.preview",
          )}
          tooltip={false}
          aria-pressed={preview}
          icon={preview ? <PenLine size={12} /> : <Eye size={12} />}
          onPointerDown={(event) => event.preventDefault()}
          onClick={togglePreview}
        />
        <IconButton
          className="prompt-editor-action"
          label={shortcutTitle(t("Hide prompt editor"), "promptEditor.toggle")}
          tooltip={false}
          icon={<X size={12} />}
          onPointerDown={(event) => event.preventDefault()}
          onClick={onClose}
        />
      </div>
    </div>
  );
}
