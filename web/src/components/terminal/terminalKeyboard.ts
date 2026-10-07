import { t } from "../../i18n";
import {
  getShortcutSnapshot,
  shortcutMatches,
} from "../../shortcutPreferences";
import { copyTextFromUserGesture } from "../../terminalClipboard";
import { terminalSelectionContent } from "../../terminalRichCopy";
import { terminalClipboardRoot } from "./terminalSession";
import { uploadTerminalImage } from "../../terminalImageUpload";
import { terminalShortcutKey } from "../../terminalKeys";
import type { TerminalKey } from "../../../../shared/terminalKey";
import type { TerminalModifiedInput } from "../../terminalModifiers";
import { installTerminalKeyEvents } from "./terminalKeyEvents";
import {
  createTerminalPasteRunner,
  type TerminalPasteTextareaSnapshot,
  terminalPasteInputText,
  terminalPasteRequest,
} from "../../terminalPaste";
import {
  cancelEvent,
  sendTerminalBytes,
  sendTerminalKeys,
  shouldAvoidVirtualKeyboard,
  swallowEvent,
  type TerminalSession,
} from "./terminalSession";
import { isEditableElement } from "../../utils";

const CLIPBOARD_READ_TIMEOUT_MS = 2000;

function withClipboardTimeout<T>(promise: Promise<T>, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(message)),
      CLIPBOARD_READ_TIMEOUT_MS,
    );
    const settle = () => window.clearTimeout(timer);
    promise.then(
      (value) => (settle(), resolve(value)),
      (err) => (settle(), reject(err)),
    );
  });
}

/**
 * Keyboard shortcuts and paste for a session. The engine encodes keys, IME
 * composition and mouse reports itself; everything it sends passes through
 * `onData`, where input is gated, modified and forwarded to the pane.
 */
export function installTerminalKeyboard(session: TerminalSession): () => void {
  const { client, refs, ui, container, term } = session;
  const { desiredTerminal } = refs;
  const { signal, applePlatform, presentation, history } = session;
  const { acceptsInput, applyModifiers, applyKeyModifiers } = session;
  const readTerminalTextareaSnapshot = (): TerminalPasteTextareaSnapshot => {
    const { textarea } = term;
    const value = textarea.value;
    const selectionStart = textarea.selectionStart ?? value.length;
    return {
      value,
      selectionStart,
      selectionEnd: textarea.selectionEnd ?? selectionStart,
    };
  };
  let nativePasteFallbackTimer: number | null = null;
  let pasteTextareaBeforeInput: TerminalPasteTextareaSnapshot | null = null;
  let pastePaneIdBeforeInput: string | null = null;

  const data = term.onData((data) => {
    session.invalidateLinks();
    if (session.replayingWheel && session.acceptsEndpointInput()) {
      sendTerminalBytes(
        client,
        new TextEncoder().encode(data),
        desiredTerminal.current!,
      );
      return;
    }
    if (!acceptsInput()) return;
    if (history.active) {
      history.reset();
      term.clearSelection();
      presentation.cancelSelection();
    }
    const terminalId = desiredTerminal.current;
    if (!terminalId) return;
    sendInput(applyModifiers(data), terminalId);
  });

  const sendInput = (input: TerminalModifiedInput, terminalId: string) => {
    if ("key" in input) sendTerminalKeys(client, [input.key], terminalId);
    else
      sendTerminalBytes(
        client,
        new TextEncoder().encode(input.bytes),
        terminalId,
      );
  };
  const sendText = (text: string) => {
    if (!acceptsInput()) return;
    const terminalId = desiredTerminal.current;
    if (!terminalId) return;
    sendInput(applyModifiers(text), terminalId);
  };
  const sendKey = (key: TerminalKey) => {
    const terminalId = desiredTerminal.current;
    if (!terminalId) return;
    session.invalidateLinks();
    if (key.kind !== "release" && history.active) {
      history.reset();
      term.clearSelection();
      presentation.cancelSelection();
    }
    sendTerminalKeys(client, [applyKeyModifiers(key)], terminalId);
  };
  const pasteText = async (
    text: string,
    destinationPaneId: string | null = refs.paneId.current ?? null,
    inputSession = refs.inputSession.current,
  ) => {
    if (
      !text ||
      !acceptsInput() ||
      inputSession !== refs.inputSession.current ||
      destinationPaneId !== (refs.paneId.current ?? null)
    )
      return;
    if (destinationPaneId) {
      const request = terminalPasteRequest(destinationPaneId, text);
      await client.call(request.method, request.params);
      return;
    }
    const activeTerm = refs.term.current;
    if (activeTerm) {
      activeTerm.paste(text);
      return;
    }
    sendText(text);
  };
  const reportTextPasteError = (error: unknown) =>
    ui.setUploadError(
      t("Text paste failed: {error}", { error: (error as Error).message }),
    );
  const cancelNativePasteFallback = () => {
    if (nativePasteFallbackTimer === null) return;
    window.clearTimeout(nativePasteFallbackTimer);
    nativePasteFallbackTimer = null;
  };
  const cancelPasteRecovery = () => {
    cancelNativePasteFallback();
    pasteTextareaBeforeInput = null;
    pastePaneIdBeforeInput = null;
  };
  const { run: runPasteOperation, dispose: disposePasteOperations } =
    createTerminalPasteRunner(() => client.isCurrent(), ui.setPasteLoading);
  const pasteImage = async (
    blob: Blob,
    destinationPaneId: string | null,
    inputSession = refs.inputSession.current,
  ) => {
    session.assertInputAllowed();
    const file =
      blob instanceof File
        ? blob
        : new File([blob], "clipboard-image.png", {
            type: blob.type || "image/png",
          });
    const path = await uploadTerminalImage(client, file);
    await pasteText(path, destinationPaneId, inputSession);
  };
  let clipboardPasteInFlight = false;
  const pasteFromBrowserClipboard = async () => {
    if (!acceptsInput() || clipboardPasteInFlight) return;
    const inputSession = refs.inputSession.current;
    clipboardPasteInFlight = true;
    const destinationPaneId = refs.paneId.current ?? null;
    try {
      await runPasteOperation(async () => {
        if (!navigator.clipboard) {
          throw new Error(t("browser clipboard API is unavailable"));
        }
        if (navigator.clipboard.read) {
          const items = await withClipboardTimeout(
            navigator.clipboard.read(),
            t("Clipboard read timed out"),
          );
          for (const item of items) {
            const imageType = item.types.find((type) =>
              type.startsWith("image/"),
            );
            if (imageType) {
              const blob = await withClipboardTimeout(
                item.getType(imageType),
                t("Clipboard image read timed out"),
              );
              await pasteImage(blob, destinationPaneId, inputSession);
              return;
            }
          }
          for (const item of items) {
            if (item.types.includes("text/plain")) {
              const blob = await withClipboardTimeout(
                item.getType("text/plain"),
                t("Clipboard text read timed out"),
              );
              const text = await withClipboardTimeout(
                blob.text(),
                t("Clipboard text read timed out"),
              );
              await pasteText(text, destinationPaneId, inputSession);
              return;
            }
          }
          return;
        }
        const text = await withClipboardTimeout(
          navigator.clipboard.readText(),
          t("Clipboard text read timed out"),
        );
        await pasteText(text, destinationPaneId, inputSession);
      });
    } finally {
      clipboardPasteInFlight = false;
    }
  };
  const appleTouchPlatform = applePlatform && navigator.maxTouchPoints > 0;

  // The platform's own copy/paste chord: Cmd on Apple, Ctrl elsewhere.
  const isNativeChord = (e: KeyboardEvent, key: "c" | "v") =>
    !e.altKey &&
    !e.shiftKey &&
    (e.key.toLowerCase() === key || e.code === `Key${key.toUpperCase()}`) &&
    (applePlatform ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

  // Thyra's own terminal shortcuts. True when the key was handled here; the
  // native copy and paste chords keep their default action.
  const handleShortcut = (e: KeyboardEvent): boolean => {
    const key = terminalShortcutKey(e, getShortcutSnapshot().preset.bindings);
    if (key) {
      cancelEvent(e);
      sendKey(key);
      return true;
    }
    if (e.type === "keydown" && shortcutMatches(e, "terminal.copy")) {
      // Keep native copy on the terminal textarea so Safari's IME focus is
      // not interrupted by the clipboard fallback's temporary readonly input;
      // the copy listener (terminalGestures) writes the rich content.
      if (isNativeChord(e, "c")) return true;
      cancelEvent(e);
      const copied = terminalSelectionContent(
        history.text ?? term.getSelection(),
        term,
        terminalClipboardRoot(refs),
      );
      if (copied.text) {
        void copyTextFromUserGesture(copied.text, { html: copied.html }).catch(
          (error) => {
            ui.setUploadError(
              t("Copy failed: {error}", { error: (error as Error).message }),
            );
          },
        );
      }
      return true;
    }
    if (e.type === "keydown" && shortcutMatches(e, "terminal.paste")) {
      // Native paste events carry clipboard payloads even on insecure LAN URLs.
      // Keep the platform's native gesture; custom combinations use the API.
      if (isNativeChord(e, "v")) return true;
      cancelEvent(e);
      pasteFromBrowserClipboard().catch((err) => {
        ui.setUploadError(
          t("Paste failed: {error}", { error: (err as Error).message }),
        );
      });
      return true;
    }
    if (e.type === "keydown") {
      for (const [id, direction, amount] of [
        ["terminal.pageUp", "up", "full"],
        ["terminal.pageDown", "down", "full"],
        ["terminal.halfPageUp", "up", "half"],
        ["terminal.halfPageDown", "down", "half"],
      ] as const) {
        if (!shortcutMatches(e, id)) continue;
        cancelEvent(e);
        session.scrollPage(direction, amount);
        return true;
      }
    }
    return false;
  };
  // Hardware keys go to Herdr as semantic keys before the engine sees them.
  installTerminalKeyEvents(container, {
    apple: applePlatform,
    signal,
    accepts: acceptsInput,
    shortcut: handleShortcut,
    send: sendKey,
  });

  // What the engine still receives: IME, dead keys and on-screen keyboards.
  term.attachCustomKeyEventHandler((e) => {
    if (!acceptsInput()) {
      cancelEvent(e);
      return false;
    }
    return !handleShortcut(e);
  });

  const onTerminalBlur = () => {
    // Desktop window blur retains activeElement for native focus restoration.
    // Explicitly blurring it would discard that target when switching apps.
    session.closeTerminalInput(shouldAvoidVirtualKeyboard());
    cancelPasteRecovery();
  };
  // Capture listeners on the input run before the engine's own; stopping
  // them there keeps it from also inserting what Thyra pastes.
  const onTerminalBeforeInput = (e: Event) => {
    if (!acceptsInput()) {
      swallowEvent(e);
      return;
    }
    const input = e as InputEvent;
    if (input.inputType === "insertFromPaste" && !input.isComposing) {
      e.stopImmediatePropagation();
      if (!pasteTextareaBeforeInput) {
        pasteTextareaBeforeInput = readTerminalTextareaSnapshot();
        pastePaneIdBeforeInput = refs.paneId.current ?? null;
      }
    }
  };
  const onTerminalTextInput = (e: Event) => {
    if (!acceptsInput()) {
      e.stopImmediatePropagation();
      return;
    }
    const input = e as InputEvent;
    if (input.inputType !== "insertFromPaste") return;
    e.stopImmediatePropagation();
    const before = pasteTextareaBeforeInput;
    const destinationPaneId = before
      ? pastePaneIdBeforeInput
      : (refs.paneId.current ?? null);
    const pastedText = before
      ? terminalPasteInputText(input, before, term.textarea.value)
      : null;
    term.textarea.value = "";
    if (pastedText === null) {
      // The native insertion exposed nothing; the clipboard event's text
      // follows from its fallback timer.
      if (nativePasteFallbackTimer === null) cancelPasteRecovery();
      return;
    }
    cancelPasteRecovery();
    void runPasteOperation(() =>
      pasteText(pastedText, destinationPaneId),
    ).catch(reportTextPasteError);
  };
  const capture = { capture: true, signal };
  const { textarea } = term;
  textarea.addEventListener("blur", onTerminalBlur, capture);
  textarea.addEventListener("beforeinput", onTerminalBeforeInput, capture);
  textarea.addEventListener("input", onTerminalTextInput, capture);

  const onPaste = async (e: ClipboardEvent) => {
    if (!acceptsInput()) {
      if (container.contains(e.target as Node | null)) {
        cancelEvent(e);
      }
      return;
    }
    const items = Array.from(e.clipboardData?.items ?? []);
    const img = items.find((it) => it.type.startsWith("image/"))?.getAsFile();
    const text = img ? "" : (e.clipboardData?.getData("text/plain") ?? "");
    const active = document.activeElement;
    const target = e.target;
    const isTerminalPaste =
      target === document ||
      container.contains(target as Node | null) ||
      (active ? container.contains(active) : false);
    if (!isTerminalPaste && isEditableElement(target)) return;
    const destinationPaneId = refs.paneId.current ?? null;
    if (!img && appleTouchPlatform && isTerminalPaste) {
      cancelNativePasteFallback();
      const beforePaste = readTerminalTextareaSnapshot();
      pasteTextareaBeforeInput = beforePaste;
      pastePaneIdBeforeInput = destinationPaneId;

      // Keep WebKit's native insertion so insertFromPaste can expose the full
      // text, but stop the engine's listener from consuming truncated
      // ClipboardEvent data and clearing the input first.
      e.stopPropagation();
      if (text) {
        nativePasteFallbackTimer = window.setTimeout(() => {
          nativePasteFallbackTimer = null;
          if (pasteTextareaBeforeInput !== beforePaste) return;
          pasteTextareaBeforeInput = null;
          pastePaneIdBeforeInput = null;
          void runPasteOperation(() =>
            pasteText(text, destinationPaneId),
          ).catch(reportTextPasteError);
        }, 0);
      }
      return;
    }
    if (!img && !text) return;
    cancelPasteRecovery();
    cancelEvent(e);
    try {
      await runPasteOperation(() =>
        img
          ? pasteImage(img, destinationPaneId)
          : pasteText(text, destinationPaneId),
      );
    } catch (err) {
      if (!img) reportTextPasteError(err);
      else
        ui.setUploadError(
          t("Image upload failed: {error}", { error: (err as Error).message }),
        );
    }
  };
  container.addEventListener("paste", onPaste, { signal });
  document.addEventListener("paste", onPaste, capture);

  return () => {
    data.dispose();
    cancelNativePasteFallback();
    disposePasteOperations();
  };
}
