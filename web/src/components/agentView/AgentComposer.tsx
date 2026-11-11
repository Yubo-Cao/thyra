import { ArrowUp, ImagePlus, Mic, MicOff, Square } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
  AGENT_PROMPT_IMAGE_LIMIT,
  type AgentPromptImage,
  type AgentSessionInfo,
} from "../../../../shared/agentSession";
import { promptForSend } from "../../agentSession/promptImages";
import { useKeyboardKind } from "../../hardwareKeyboard";
import { t } from "../../i18n";
import { useLayoutPreferences } from "../../layoutPreferences";
import {
  coarsePrimaryPointer,
  programmaticFocusAllowed,
} from "../../localEditorPolicy";
import { promptEditorKeyAction } from "../../promptEditorKeys";
import { getShortcutSnapshot } from "../../shortcutPreferences";
import { store } from "../../store";
import {
  beginTerminalComposerSubmission,
  clearTerminalComposerDraft,
  commitTextComposition,
  finishTerminalComposerSubmission,
  readComposerImages,
  readTerminalComposerDraft,
  readTerminalComposerSelection,
  replaceTerminalComposerDraftRange,
  terminalComposerImageFiles,
  writeTerminalComposerDraft,
} from "../../terminalComposer";
import { isEditableElement } from "../../utils";
import { useVoiceDictation } from "../../voice/useVoiceDictation";
import { ComposerImages } from "../ComposerImages";
import { PromptSurface, usePromptDraft } from "../promptEditor/promptDraft";
import type { PromptEditorSurfaceProps } from "../promptEditor/surface";
import { IconButton } from "../ui/IconButton";
import { keepFocus } from "../ui/keepFocus";
import { keyboardOverlayOpen } from "../ui/overlayState";
import { Select } from "../ui/Select";
import { Token } from "../ui/Token";

const compact = (count: number) =>
  count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);

/** How the session runs: its mode (a choice when it offers several), model, and context use. */
export function AgentMeta({
  info,
  onSetMode,
}: {
  info: AgentSessionInfo;
  /** Absent for viewers and ended sessions: the mode is shown, not chosen. */
  onSetMode?: (mode: string) => void;
}) {
  const usage = info.usage;
  const used = usage?.context_tokens;
  const modes = info.modes ?? [];
  const mode = modes.find((item) => item.id === info.mode);
  return (
    <div className="agent-meta">
      {onSetMode && modes.length > 0 ? (
        <Select
          variant="ghost"
          aria-label={t("Mode")}
          value={info.mode ?? ""}
          placeholder={info.mode ?? t("Mode")}
          options={modes.map((item) => ({
            value: item.id,
            label: item.label,
          }))}
          onChange={onSetMode}
        />
      ) : info.mode ? (
        <Token>{mode?.label ?? info.mode}</Token>
      ) : null}
      {info.model ? (
        <Token code className="agent-meta-model" title={info.model}>
          {info.model}
        </Token>
      ) : null}
      {used === undefined ? null : usage?.context_window ? (
        <Token
          title={t("{used} of {window} context tokens used", {
            used: used.toLocaleString(),
            window: usage.context_window.toLocaleString(),
          })}
        >
          {t("{percent}% context", {
            percent: Math.round((used / usage.context_window) * 100),
          })}
        </Token>
      ) : (
        <Token>{t("{count} tokens", { count: compact(used) })}</Token>
      )}
    </div>
  );
}

const notifyError = (message: string, detail: string) =>
  store.notify({ kind: "error", message, detail });

/**
 * The prompt box: the prompt editor's surfaces (a plain field at once, then
 * the live Markdown preview) over a draft kept per pane, with images
 * attached as `[Image #N]` placeholders. Enter sends and Shift+Enter or
 * Alt+Enter break the line; with an on-screen keyboard Return breaks the
 * line and the button sends. A prompt sent while a turn runs steers or
 * queues, as the agent decides.
 */
export function AgentComposer({
  draftKey,
  info,
  active,
  epoch,
  imageUrl,
  onSend,
  onInterrupt,
  onSetMode,
  onPage,
  onUploadImage,
}: {
  /** The pane's draft in the composer store (agentComposerDraftKey). */
  draftKey: string;
  info: AgentSessionInfo;
  /** The pane is the active one: the box may take focus. */
  active: boolean;
  /** The session's transcript epoch: a resumed conversation refocuses the box. */
  epoch: number;
  /** Where images the draft names by path load from. */
  imageUrl: (source: string) => string | null;
  /** `images` are the ones the text's placeholders name, in their order. */
  onSend: (text: string, images: AgentPromptImage[]) => Promise<unknown>;
  onInterrupt: () => void;
  onSetMode: (mode: string) => void;
  onPage: (direction: "up" | "down") => void;
  /** Prepares and uploads an image; resolves to its path on the host. */
  onUploadImage: (file: File) => Promise<string>;
}) {
  const draft = usePromptDraft({
    draftKey,
    imageUrl,
    // Numbered within the prompt: its images go with it, not into the pane,
    // and show in the box as the attachments they are.
    paneHistory: false,
    imageAtoms: true,
    onUploadImage,
    onError: (detail) => notifyError(t("Could not attach the image"), detail),
  });
  const { text, uploadCount, surfaceRef, composingRef } = draft;
  const sending = draft.submissionPending;
  const root = useRef<HTMLDivElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const [coarse] = useState(coarsePrimaryPointer);
  const keyboard = useKeyboardKind();
  const { mobile } = useLayoutPreferences();
  const exited = info.status === "exited";
  const busy = info.status === "running" || info.status === "awaiting_approval";
  const uploading = uploadCount > 0;
  const ready = !exited && info.status !== "starting" && !sending && !uploading;

  // Selecting the pane, or resuming a conversation in it (the list that was
  // focused is gone), puts the caret here, unless that would raise an
  // on-screen keyboard or take focus from another field.
  const focusAllowed = programmaticFocusAllowed(coarse, keyboard);
  useEffect(() => {
    void epoch;
    if (
      active &&
      focusAllowed &&
      !keyboardOverlayOpen() &&
      !isEditableElement(document.activeElement)
    )
      surfaceRef.current?.focus();
  }, [active, focusAllowed, epoch, surfaceRef]);

  const voice = useVoiceDictation({
    // At the caret, and without focusing: that would raise a phone's
    // keyboard in the middle of a dictation.
    onText: (spoken, join) => {
      const current = readTerminalComposerDraft(draftKey);
      const selection =
        surfaceRef.current?.selection() ??
        readTerminalComposerSelection(draftKey);
      const start = Math.min(
        selection?.start ?? current.length,
        current.length,
      );
      const end = Math.max(
        start,
        Math.min(selection?.end ?? start, current.length),
      );
      const insertion = join(current.slice(0, start), spoken);
      if (insertion)
        replaceTerminalComposerDraftRange(draftKey, start, end, insertion);
    },
    onError: (message) => notifyError(t("Voice typing"), message),
  });

  const submit = async (fromButton: boolean) => {
    if (!ready) return;
    if (composingRef.current) {
      // The IME owns Enter while it composes; the button makes it commit.
      const field = root.current?.querySelector<HTMLElement>(
        "textarea, [contenteditable]",
      );
      if (!fromButton || !field) return;
      await commitTextComposition(field, () => composingRef.current);
      composingRef.current = false;
    }
    // Read from the surface: a commit may not have been reported yet.
    const typed =
      surfaceRef.current?.text() ?? readTerminalComposerDraft(draftKey);
    if (!typed.trim()) return;
    writeTerminalComposerDraft(draftKey, typed);
    const prompt = promptForSend(typed, readComposerImages(draftKey));
    if (prompt.images.length > AGENT_PROMPT_IMAGE_LIMIT) {
      notifyError(
        t("Could not send the prompt"),
        t("A prompt takes at most {count} images.", {
          count: AGENT_PROMPT_IMAGE_LIMIT,
        }),
      );
      return;
    }
    if (!beginTerminalComposerSubmission(draftKey)) return;
    try {
      await onSend(prompt.text, prompt.images);
      clearTerminalComposerDraft(draftKey);
    } catch {
      // Reported by the caller; the draft and its images stay to be sent again.
    } finally {
      finishTerminalComposerSubmission(draftKey);
      if (fromButton) surfaceRef.current?.focus();
    }
  };

  const onKey = (event: KeyboardEvent, empty: boolean) => {
    const action = promptEditorKeyAction(event, {
      empty,
      applicationCursor: false,
      bindings: getShortcutSnapshot().preset.bindings,
      // An on-screen keyboard's Return has no Shift: it breaks the line.
      enterSends: !coarse || keyboard === "hardware",
    });
    if (!action) return false;
    if (action.type === "send") void submit(false);
    else if (action.type === "newline") surfaceRef.current?.insertText("\n");
    else if (action.type === "page") onPage(action.direction);
    // Keys the terminal prompt editor hands to the agent. Here an empty
    // box's Enter does nothing, its Escape stops the turn, and the others
    // stay the editor's own.
    else if (action.data === "\x1b" && busy) onInterrupt();
    else if (action.data !== "\r") return false;
    return true;
  };

  // The transcript's type, not the terminal grid's; 16px keeps iOS Safari
  // from zooming in on focus.
  const font = mobile
    ? { family: "inherit", size: 16, lineHeight: 24 }
    : { family: "inherit", size: 14, lineHeight: 21 };
  const surfaceProps: PromptEditorSurfaceProps = {
    ...draft.surface,
    placeholder: exited
      ? t("This session has ended")
      : info.status === "starting"
        ? t("The agent is starting")
        : busy
          ? t("Add to the running turn")
          : t("Ask the agent"),
    label: t("Prompt"),
    readOnly: sending || exited,
    prose: true,
    // On to an open request's answers, say, instead of indenting nothing.
    emptyTabMovesFocus: true,
    font,
    onKey,
    // An ended session takes no more images; the paste is the surface's.
    onPasteFiles: (data) => !exited && draft.surface.onPasteFiles(data),
    onContentHeight: setContentHeight,
  };

  const attach = (files: readonly (File | null)[]) => {
    if (!exited) draft.attach(terminalComposerImageFiles(files));
  };
  const dragsFiles = (event: React.DragEvent) =>
    event.dataTransfer.types.includes("Files");

  return (
    <div
      ref={root}
      className="agent-composer"
      // Before the editor, which would insert a dropped file's bytes as text.
      onDragOverCapture={(event) => {
        if (!dragsFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = exited ? "none" : "copy";
      }}
      onDropCapture={(event) => {
        if (!dragsFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        attach([...event.dataTransfer.files]);
      }}
    >
      <div
        className="agent-composer-editor"
        data-disabled={exited || undefined}
        style={
          {
            // The rich surface sizes itself; the plain one is measured.
            height: draft.rich ? undefined : contentHeight,
            fontSize: font.size,
            "--prompt-editor-row": `${font.lineHeight}px`,
          } as CSSProperties
        }
      >
        <PromptSurface rich={draft.rich} {...surfaceProps} />
      </div>
      <ComposerImages images={draft.strip} />
      <div className="agent-composer-foot">
        <AgentMeta info={info} onSetMode={exited ? undefined : onSetMode} />
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            attach([...(event.target.files ?? [])]);
            // The same file can be chosen again.
            event.target.value = "";
          }}
        />
        <IconButton
          size="md"
          label={t("Add an image")}
          icon={<ImagePlus size={15} />}
          disabled={exited || sending}
          onMouseDown={keepFocus}
          onClick={() => picker.current?.click()}
        />
        <IconButton
          size="md"
          label={voice.active ? t("Stop voice input") : t("Start voice input")}
          icon={voice.active ? <MicOff size={15} /> : <Mic size={15} />}
          aria-pressed={voice.active}
          disabled={
            exited ||
            voice.state.phase === "stopping" ||
            voice.state.phase === "tidying"
          }
          onMouseDown={keepFocus}
          onClick={voice.toggle}
        />
        {busy ? (
          <IconButton
            size="md"
            variant="danger-soft"
            label={t("Stop the agent")}
            icon={<Square size={12} fill="currentColor" />}
            onMouseDown={keepFocus}
            onClick={onInterrupt}
          />
        ) : null}
        <IconButton
          size="md"
          variant="primary"
          label={uploading ? t("Uploading image…") : t("Send")}
          icon={<ArrowUp size={16} />}
          disabled={!ready || !text.trim()}
          onMouseDown={keepFocus}
          onClick={() => void submit(true)}
        />
      </div>
    </div>
  );
}
