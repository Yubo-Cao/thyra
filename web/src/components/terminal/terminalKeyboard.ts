import { t } from "../../i18n";
import {
  getShortcutSnapshot,
  shortcutMatches,
} from "../../shortcutPreferences";
import { copyTextFromUserGesture } from "../../terminalClipboard";
import { terminalSelectionContent } from "../../terminalRichCopy";
import { terminalClipboardRoot } from "./terminalSession";
import { uploadTerminalImage } from "../../terminalImageUpload";
import {
  isTerminalImeCommittedInputType,
  TerminalImeCommitGuard,
  TerminalImeFallbackTracker,
  TerminalImeKeyEventTracker,
  TerminalImeTextareaFallbackTracker,
  terminalImeEventTime,
  terminalImeFallbackText,
  terminalImeTextareaDelta,
} from "../../terminalIme";
import { terminalShortcutSequence } from "../../terminalKeys";
import {
  createTerminalPasteRunner,
  type TerminalPasteTextareaSnapshot,
  terminalPasteInputText,
  terminalPasteRequest,
} from "../../terminalPaste";
import {
  cancelEvent,
  sendTerminalBytes,
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

/** Keyboard input, shortcuts, IME recovery and paste for a session. */
export function installTerminalKeyboard(session: TerminalSession): () => void {
  const { client, refs, ui, container, term } = session;
  const { desiredTerminal } = refs;
  const { signal, applePlatform, presentation, history } = session;
  const { acceptsInput, applyModifiers } = session;
  const imeFallback = new TerminalImeFallbackTracker();
  const imeKeyEvent = new TerminalImeKeyEventTracker();
  const imeTextareaFallback = new TerminalImeTextareaFallbackTracker();
  const imeCommitGuard = new TerminalImeCommitGuard();
  const readTerminalTextareaSnapshot = (): TerminalPasteTextareaSnapshot => {
    const textarea = term.textarea;
    const value = textarea?.value ?? "";
    const selectionStart = textarea?.selectionStart ?? value.length;
    return {
      value,
      selectionStart,
      selectionEnd: textarea?.selectionEnd ?? selectionStart,
    };
  };
  let imeTextareaTimer: number | null = null;
  let terminalCompositionActive = false;
  let compositionSettleTimer: number | null = null;
  let compositionStartTextareaValue = "";
  let nativePasteFallbackTimer: number | null = null;
  let pasteTextareaClearTimer: number | null = null;
  let pasteTextareaBeforeInput: TerminalPasteTextareaSnapshot | null = null;
  let pastePaneIdBeforeInput: string | null = null;
  let lastTerminalTextareaSnapshot = readTerminalTextareaSnapshot();

  term.onData((data) => {
    session.invalidateLinks();
    if (session.replayingWheel && session.acceptsEndpointInput()) {
      sendTerminalBytes(
        client,
        new TextEncoder().encode(data),
        desiredTerminal.current!,
      );
      return;
    }
    // Replaying a delayed local selection must never synthesize pane input.
    if (!acceptsInput() || session.replayingSelection) return;
    if (history.active) {
      history.reset();
      term.clearSelection();
      presentation.cancelSelection();
    }
    const unsuppressedData = imeTextareaFallback.recordXtermData(data);
    if (!unsuppressedData) return;
    const dataAt = performance.now();
    if (!imeCommitGuard.filterXtermData(unsuppressedData, dataAt)) {
      return;
    }
    const shouldSend = imeFallback.recordXtermData(unsuppressedData, dataAt);
    if (!shouldSend) return;
    const terminalId = desiredTerminal.current;
    if (!terminalId) return;
    imeKeyEvent.recordXtermData(unsuppressedData);
    const bytes = new TextEncoder().encode(applyModifiers(unsuppressedData));
    sendTerminalBytes(client, bytes, terminalId);
  });

  const sendText = (text: string) => {
    if (!acceptsInput()) return;
    const terminalId = desiredTerminal.current;
    if (!terminalId) return;
    const bytes = new TextEncoder().encode(applyModifiers(text));
    sendTerminalBytes(client, bytes, terminalId);
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
    imeCommitGuard.beginIndependentInput();
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
  const sendMissingImeText = (
    text: string,
    eventTime: number,
    observedAt: number,
  ) => {
    if (imeCommitGuard.consumeSuppressedDuplicate(text, observedAt)) return;
    const shouldSend = imeFallback.recordInput(text, eventTime, observedAt);
    if (!shouldSend) return;
    sendText(text);
  };
  const cancelImeTextareaFallback = () => {
    if (imeTextareaTimer !== null) {
      window.clearTimeout(imeTextareaTimer);
      imeTextareaTimer = null;
    }
    imeTextareaFallback.cancel();
    imeCommitGuard.completeRecoveryCycle();
  };
  const cancelCompositionSettle = () => {
    if (compositionSettleTimer === null) return;
    window.clearTimeout(compositionSettleTimer);
    compositionSettleTimer = null;
  };
  const cancelNativePasteFallback = () => {
    if (nativePasteFallbackTimer === null) return;
    window.clearTimeout(nativePasteFallbackTimer);
    nativePasteFallbackTimer = null;
  };
  const cancelPasteTextareaClear = () => {
    if (pasteTextareaClearTimer === null) return;
    window.clearTimeout(pasteTextareaClearTimer);
    pasteTextareaClearTimer = null;
  };
  const cancelPasteRecovery = () => {
    cancelNativePasteFallback();
    cancelPasteTextareaClear();
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
  const shouldRecoverCommittedImeInput = (input: InputEvent) =>
    applePlatform &&
    !terminalCompositionActive &&
    isTerminalImeCommittedInputType(input.inputType);

  // The platform's own copy/paste chord: Cmd on Apple, Ctrl elsewhere.
  const isNativeChord = (e: KeyboardEvent, key: "c" | "v") =>
    !e.altKey &&
    !e.shiftKey &&
    (e.key.toLowerCase() === key || e.code === `Key${key.toUpperCase()}`) &&
    (applePlatform ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

  term.attachCustomKeyEventHandler((e) => {
    if (!acceptsInput()) {
      cancelEvent(e);
      return false;
    }
    // xterm's capture listener runs before our textarea keydown listener.
    // Its custom handler is the boundary before any synchronous onData.
    if (e.type === "keydown") {
      imeCommitGuard.beginIndependentInput();
      if (applePlatform) imeKeyEvent.begin();
    }
    if (e.type === "keydown" && e.keyCode !== 229) {
      imeTextareaFallback.cancelPending();
    }
    const sequence = terminalShortcutSequence(
      e,
      getShortcutSnapshot().preset.bindings,
    );
    if (sequence) {
      cancelEvent(e);
      sendText(sequence);
      return false;
    }
    if (e.type === "keydown" && shortcutMatches(e, "terminal.copy")) {
      // Keep native copy on the terminal textarea so Safari's IME focus is
      // not interrupted by the clipboard fallback's temporary readonly input.
      if (isNativeChord(e, "c")) return false;
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
      return false;
    }
    if (e.type === "keydown" && shortcutMatches(e, "terminal.paste")) {
      // Native paste events carry clipboard payloads even on insecure LAN URLs.
      // Keep the platform's native gesture; custom combinations use the API.
      if (isNativeChord(e, "v")) return false;
      cancelEvent(e);
      pasteFromBrowserClipboard().catch((err) => {
        ui.setUploadError(
          t("Paste failed: {error}", { error: (err as Error).message }),
        );
      });
      return false;
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
        return false;
      }
    }

    return true;
  });

  const flushTextareaImeFallback = (
    event: Event,
    final = false,
  ): "pending" | "unhandled" | "handled" => {
    const result = imeTextareaFallback.flush(term.textarea?.value ?? "", final);
    if (result.status === "handled" && result.text) {
      const observedAt = performance.now();
      const eventAt = terminalImeEventTime(event, observedAt);
      sendMissingImeText(result.text, eventAt, observedAt);
    }
    if (result.status === "handled") {
      imeCommitGuard.completeRecoveryCycle();
    }
    return result.status;
  };
  const scheduleImeTextareaFinal = (event: Event) => {
    if (imeTextareaTimer !== null) window.clearTimeout(imeTextareaTimer);
    imeTextareaTimer = window.setTimeout(() => {
      imeTextareaTimer = null;
      flushTextareaImeFallback(event, true);
      imeTextareaFallback.complete();
      imeCommitGuard.completeRecoveryCycle();
    }, 0);
  };
  const onTerminalKeyDown = (event: KeyboardEvent) => {
    lastTerminalTextareaSnapshot = readTerminalTextareaSnapshot();
    if (!applePlatform || event.keyCode !== 229 || terminalCompositionActive) {
      return;
    }
    // Do not trust event.isComposing here. Third-party iOS keyboards can set
    // it without dispatching a real composition lifecycle.
    imeTextareaFallback.begin(lastTerminalTextareaSnapshot.value);
  };
  const onTerminalKeyUp = (event: KeyboardEvent) => {
    imeKeyEvent.end();
    if (!applePlatform || !imeTextareaFallback.hasPending()) return;

    // A keydown reported as 229 can have a keyup reported as 0 or as the
    // concrete key code. Flush the pending cycle regardless of keyup code.
    // If the value is not visible yet, keep it for one final task, matching
    // xterm's upstream fallback.
    flushTextareaImeFallback(event);
    scheduleImeTextareaFinal(event);
  };
  // A composition start or a blur ends the current IME and paste cycle.
  const restartImeCycle = (compositionActive: boolean) => {
    imeCommitGuard.beginIndependentInput();
    imeKeyEvent.end();
    cancelCompositionSettle();
    terminalCompositionActive = compositionActive;
    cancelPasteRecovery();
    lastTerminalTextareaSnapshot = readTerminalTextareaSnapshot();
  };
  const onTerminalCompositionStart = () => {
    restartImeCycle(true);
    compositionStartTextareaValue = lastTerminalTextareaSnapshot.value;
    cancelImeTextareaFallback();
  };
  const onTerminalCompositionEnd = () => {
    lastTerminalTextareaSnapshot = readTerminalTextareaSnapshot();
    // Only arm the guard when the composition actually committed text. A
    // canceled composition leaves no delta, so a stray emission right
    // after Escape can never be captured as a commit.
    imeCommitGuard.endComposition(
      performance.now(),
      terminalImeTextareaDelta(
        compositionStartTextareaValue,
        lastTerminalTextareaSnapshot.value,
      ),
    );
    cancelImeTextareaFallback();
    cancelCompositionSettle();
    // This listener runs after xterm's compositionend listener. Keep fallback
    // disabled until xterm's queued composition finalization has completed.
    compositionSettleTimer = window.setTimeout(() => {
      compositionSettleTimer = null;
      terminalCompositionActive = false;
    }, 0);
  };
  const onTerminalBlur = () => {
    // Desktop window blur retains activeElement for native focus restoration.
    // Explicitly blurring it would discard that target when switching apps.
    session.closeTerminalInput(shouldAvoidVirtualKeyboard());
    restartImeCycle(false);
    cancelImeTextareaFallback();
  };
  const onTerminalBeforeInput = (e: Event) => {
    if (!acceptsInput()) {
      swallowEvent(e);
      return;
    }
    // A new native mutation cannot recover the preceding input's duplicate.
    // Do not disarm commit capture: OS replay can also have beforeinput.
    imeCommitGuard.completeRecoveryCycle();
    const input = e as InputEvent;
    if (input.inputType === "insertFromPaste" && !input.isComposing) {
      imeCommitGuard.beginIndependentInput();
      if (!pasteTextareaBeforeInput) {
        pasteTextareaBeforeInput = readTerminalTextareaSnapshot();
        pastePaneIdBeforeInput = refs.paneId.current ?? null;
      }
      return;
    }
    if (shouldRecoverCommittedImeInput(input)) {
      // Some third-party keyboards emit beforeinput/input without a preceding
      // keydown, or emit input before keydown 229. Capture the pre-mutation
      // value here so the input/keyup path can recover arbitrary committed
      // text rather than punctuation only.
      imeTextareaFallback.begin(readTerminalTextareaSnapshot().value);
      scheduleImeTextareaFinal(input);
      return;
    }

    const fallbackText = terminalCompositionActive
      ? null
      : terminalImeFallbackText(input);
    if (!fallbackText || !input.cancelable) return;
    const observedAt = performance.now();
    const eventAt = terminalImeEventTime(input, observedAt);

    // xterm reads IME textarea mutations from a timer. Sending the committed
    // punctuation before that mutation keeps rapid input ordered and avoids
    // relying on the bridge round trip before the next key is processed.
    cancelEvent(input);
    sendMissingImeText(fallbackText, eventAt, observedAt);
  };
  const handleTerminalTextInput = (e: Event) => {
    const input = e as InputEvent;
    const xtermHandledCurrentInput = imeKeyEvent.consumeInput(input);
    const textareaSnapshot = readTerminalTextareaSnapshot();
    const textareaBeforeInput = lastTerminalTextareaSnapshot;
    const hadPasteSnapshot = pasteTextareaBeforeInput !== null;
    const beforePaste = pasteTextareaBeforeInput ?? textareaBeforeInput;
    const destinationPaneId = hadPasteSnapshot
      ? pastePaneIdBeforeInput
      : (refs.paneId.current ?? null);
    const pastedText = terminalPasteInputText(
      input,
      beforePaste,
      textareaSnapshot.value,
    );
    if (pastedText !== null) {
      cancelImeTextareaFallback();
      cancelPasteRecovery();
      const textarea = term.textarea;
      if (textarea) {
        // Restore xterm's keydown baseline until its queued 229 timer runs.
        // Clearing immediately makes xterm emit a spurious DEL.
        textarea.value = beforePaste.value;
        textarea.setSelectionRange(
          beforePaste.selectionStart,
          beforePaste.selectionEnd,
        );
        lastTerminalTextareaSnapshot = beforePaste;
        pasteTextareaClearTimer = window.setTimeout(() => {
          pasteTextareaClearTimer = null;
          if (
            term.textarea === textarea &&
            textarea.value === beforePaste.value
          ) {
            textarea.value = "";
            lastTerminalTextareaSnapshot = {
              value: "",
              selectionStart: 0,
              selectionEnd: 0,
            };
          }
        }, 0);
      }
      input.stopPropagation();
      void runPasteOperation(() =>
        pasteText(pastedText, destinationPaneId),
      ).catch(reportTextPasteError);
      return;
    }

    lastTerminalTextareaSnapshot = textareaSnapshot;
    if (input.inputType === "insertFromPaste") {
      input.stopPropagation();
      if (nativePasteFallbackTimer === null) {
        pasteTextareaBeforeInput = null;
        pastePaneIdBeforeInput = null;
      }
      return;
    }
    cancelPasteRecovery();

    if (xtermHandledCurrentInput) {
      // Safari still mutates the helper textarea after xterm handles some
      // printable keys in keypress. Do not replay that same committed text.
      imeTextareaFallback.cancelPending();
      return;
    }

    if (shouldRecoverCommittedImeInput(input)) {
      // beforeinput is not guaranteed on every WebKit keyboard. The previous
      // observed textarea value is the best safe append-only baseline when it
      // is absent; begin() preserves an earlier keydown/beforeinput baseline.
      imeTextareaFallback.begin(textareaBeforeInput.value);
      const flushStatus = flushTextareaImeFallback(input);
      scheduleImeTextareaFinal(input);
      if (flushStatus === "handled") return;
    }

    const fallbackText = terminalCompositionActive
      ? null
      : terminalImeFallbackText(input);
    if (!fallbackText) return;
    const observedAt = performance.now();
    const eventAt = terminalImeEventTime(input, observedAt);
    sendMissingImeText(fallbackText, eventAt, observedAt);
  };
  const onTerminalTextInput = (e: Event) => {
    if (!acceptsInput()) {
      e.stopImmediatePropagation();
      return;
    }
    try {
      handleTerminalTextInput(e);
    } finally {
      // Without beforeinput, xterm has already emitted before this listener.
      // Keep its tombstone through recovery, but never into the next input.
      if (!imeTextareaFallback.hasPending()) {
        imeCommitGuard.completeRecoveryCycle();
      }
    }
  };
  const capture = { capture: true, signal };
  const textarea = term.textarea;
  textarea?.addEventListener("keydown", onTerminalKeyDown, capture);
  textarea?.addEventListener("keyup", onTerminalKeyUp, capture);
  textarea?.addEventListener(
    "compositionstart",
    onTerminalCompositionStart,
    capture,
  );
  textarea?.addEventListener("compositionend", onTerminalCompositionEnd, {
    signal,
  });
  textarea?.addEventListener("blur", onTerminalBlur, capture);
  textarea?.addEventListener("beforeinput", onTerminalBeforeInput, capture);
  textarea?.addEventListener("input", onTerminalTextInput, capture);

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
    imeCommitGuard.beginIndependentInput();
    const destinationPaneId = refs.paneId.current ?? null;
    if (!img && appleTouchPlatform && isTerminalPaste) {
      cancelImeTextareaFallback();
      cancelNativePasteFallback();
      cancelPasteTextareaClear();
      const beforePaste = readTerminalTextareaSnapshot();
      pasteTextareaBeforeInput = beforePaste;
      pastePaneIdBeforeInput = destinationPaneId;
      lastTerminalTextareaSnapshot = beforePaste;

      // Keep WebKit's native insertion so insertFromPaste can expose the full
      // text, but stop xterm's target listener from consuming truncated
      // ClipboardEvent data and clearing the textarea first.
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
    cancelImeTextareaFallback();
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
    cancelImeTextareaFallback();
    cancelCompositionSettle();
    cancelNativePasteFallback();
    cancelPasteTextareaClear();
    disposePasteOperations();
    imeFallback.dispose();
    imeCommitGuard.dispose();
  };
}
