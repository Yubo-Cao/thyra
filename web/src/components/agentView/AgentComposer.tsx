import {
  ArrowUp,
  ChevronDown,
  FoldVertical,
  ImagePlus,
  Mic,
  MicOff,
  Square,
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
  AGENT_PROMPT_IMAGE_LIMIT,
  type AgentPromptDelivery,
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
  commitTextComposition,
  readComposerImages,
  readTerminalComposerDraft,
  readTerminalComposerSelection,
  replaceTerminalComposerDraftRange,
  submitComposerDraft,
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
import { Menu } from "../ui/Menu";
import { keyboardOverlayOpen } from "../ui/overlayState";
import { Select } from "../ui/Select";
import { Token } from "../ui/Token";
import { agentModeText } from "./agentModes";

const compact = (count: number) =>
  count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);

/** Session settings a page may change; absent for viewers and ended sessions. */
export type AgentMetaActions = {
  onSetMode: (mode: string) => void;
  onSetModel: (model: string) => void;
  onSetEffort: (effort: string) => void;
  onCompact: () => void;
};

/**
 * How the session runs: its mode, model and reasoning effort (choices when
 * the agent offers them), and context use, with a button that compacts the
 * conversation.
 */
export function AgentMeta({
  info,
  actions,
}: {
  info: AgentSessionInfo;
  actions?: AgentMetaActions;
}) {
  const usage = info.usage;
  const used = usage?.context_tokens;
  const modes = info.modes ?? [];
  const mode = modes.find((item) => item.id === info.mode);
  const modeText = mode && agentModeText(info.kind, mode);
  const models = info.can_set_model ? (info.models ?? []) : [];
  const model = models.find((item) => item.id === info.model);
  const efforts = info.can_set_model ? (info.efforts ?? []) : [];
  return (
    <div className="agent-meta">
      {actions && modes.length > 0 ? (
        <Select
          variant="ghost"
          aria-label={t("Mode")}
          value={info.mode ?? ""}
          placeholder={info.mode ?? t("Mode")}
          options={modes.map((item) => ({
            value: item.id,
            ...agentModeText(info.kind, item),
          }))}
          onChange={actions.onSetMode}
        />
      ) : info.mode ? (
        <Token title={modeText?.description}>
          {modeText?.label ?? info.mode}
        </Token>
      ) : null}
      {actions && models.length > 0 ? (
        <Select
          variant="ghost"
          className="agent-meta-model"
          aria-label={t("Model")}
          title={info.model}
          value={info.model ?? ""}
          placeholder={info.model ?? t("Model")}
          options={models.map((item) => ({
            value: item.id,
            label: item.label,
            description: item.description,
          }))}
          onChange={actions.onSetModel}
        />
      ) : info.model ? (
        <Token code className="agent-meta-model" title={info.model}>
          {model?.label ?? info.model}
        </Token>
      ) : null}
      {actions && efforts.length > 0 ? (
        <Select
          variant="ghost"
          aria-label={t("Reasoning effort")}
          title={t("Reasoning effort")}
          value={info.effort ?? ""}
          placeholder={info.effort ?? t("Effort")}
          options={efforts.map((effort) => ({ value: effort, label: effort }))}
          onChange={actions.onSetEffort}
        />
      ) : info.effort ? (
        <Token title={t("Reasoning effort")}>{info.effort}</Token>
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
      {actions && info.can_compact ? (
        <IconButton
          size="sm"
          label={t("Compact the conversation")}
          icon={<FoldVertical size={14} />}
          disabled={info.status !== "idle"}
          onMouseDown={keepFocus}
          onClick={actions.onCompact}
        />
      ) : null}
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
 * line and the button sends. While a turn runs, a prompt waits for it to
 * end; the menu beside the button sends it into the turn, or stops the turn
 * and sends it, and Escape stops the turn.
 */
export function AgentComposer({
  draftKey,
  info,
  active,
  epoch,
  imageUrl,
  onSend,
  onInterrupt,
  meta,
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
  onSend: (
    text: string,
    images: AgentPromptImage[],
    delivery?: AgentPromptDelivery,
  ) => Promise<unknown>;
  onInterrupt: () => void;
  meta: AgentMetaActions;
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
  // Hosts from before the queue give every prompt to the running turn.
  const queues = busy && info.can_queue === true;
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

  const submit = async (
    fromButton: boolean,
    delivery: AgentPromptDelivery | undefined = queues ? "queue" : undefined,
  ) => {
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
    // The box empties at once and stays editable, so what is typed while the
    // prompt travels is the next prompt and not lost keystrokes.
    try {
      await submitComposerDraft(draftKey, typed, () =>
        onSend(prompt.text, prompt.images, delivery),
      );
    } catch {
      // Reported by the caller; the draft and its images are back in the box.
    } finally {
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
    // Escape stops a running turn, with a draft too, as in Claude Code; the
    // editor still sees it (Escape then Tab leaves the box).
    if (busy && !empty && event.key === "Escape" && !event.isComposing) {
      onInterrupt();
      return false;
    }
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
        : queues
          ? t("Queue a prompt for after this turn")
          : busy
            ? t("Add to the running turn")
            : t("Ask the agent"),
    label: t("Prompt"),
    readOnly: exited,
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
        <AgentMeta info={info} actions={exited ? undefined : meta} />
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
          disabled={exited}
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
          label={
            uploading
              ? t("Uploading image…")
              : queues
                ? t("Send when the turn ends")
                : t("Send")
          }
          icon={<ArrowUp size={16} />}
          disabled={!ready || !text.trim()}
          onMouseDown={keepFocus}
          onClick={() => void submit(true)}
        />
        {queues ? (
          <Menu
            aria-label={t("Send now")}
            placement="top end"
            items={[
              {
                id: "steer",
                label: t("Send into the running turn"),
                onAction: () => void submit(true, "steer"),
              },
              {
                id: "interrupt",
                label: t("Stop the turn and send"),
                onAction: () => void submit(true, "interrupt"),
              },
            ]}
            trigger={
              <IconButton
                size="md"
                label={t("Send now")}
                icon={<ChevronDown size={14} />}
                disabled={!ready || !text.trim()}
              />
            }
          />
        ) : null}
      </div>
    </div>
  );
}
