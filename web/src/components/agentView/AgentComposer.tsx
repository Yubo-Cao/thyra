import { ArrowUp, Mic, MicOff, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentSessionInfo } from "../../../../shared/agentSession";
import { useKeyboardKind } from "../../hardwareKeyboard";
import { t } from "../../i18n";
import {
  coarsePrimaryPointer,
  programmaticFocusAllowed,
} from "../../localEditorPolicy";
import { PASSWORD_MANAGER_IGNORE } from "../../passwordManagerIgnore";
import { promptEditorKeyAction } from "../../promptEditorKeys";
import { getShortcutSnapshot } from "../../shortcutPreferences";
import { store } from "../../store";
import { commitTextComposition } from "../../terminalComposer";
import { isEditableElement } from "../../utils";
import { useVoiceDictation } from "../../voice/useVoiceDictation";
import { IconButton } from "../ui/IconButton";
import { keepFocus } from "../ui/keepFocus";
import { keyboardOverlayOpen } from "../ui/overlayState";
import { Select } from "../ui/Select";
import { TextArea } from "../ui/TextArea";
import { Token } from "../ui/Token";

/** Unsent prompts by pane, kept while the pane is not on screen. */
const drafts = new Map<string, string>();

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
  const mode = info.modes.find((item) => item.id === info.mode);
  return (
    <div className="agent-meta">
      {onSetMode && info.modes.length > 0 ? (
        <Select
          variant="ghost"
          aria-label={t("Mode")}
          value={info.mode ?? ""}
          placeholder={info.mode ?? t("Mode")}
          options={info.modes.map((item) => ({
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

/**
 * The prompt box. Enter sends and Shift+Enter or Alt+Enter break the line;
 * with an on-screen keyboard Return breaks the line and the button sends.
 * A prompt sent while a turn runs steers or queues, as the agent decides.
 */
export function AgentComposer({
  draftKey,
  info,
  active,
  onSend,
  onInterrupt,
  onSetMode,
  onPage,
}: {
  draftKey: string;
  info: AgentSessionInfo;
  /** The pane is the active one: the box may take focus. */
  active: boolean;
  onSend: (text: string) => Promise<unknown>;
  onInterrupt: () => void;
  onSetMode: (mode: string) => void;
  onPage: (direction: "up" | "down") => void;
}) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const [coarse] = useState(coarsePrimaryPointer);
  const keyboard = useKeyboardKind();
  const exited = info.status === "exited";
  const busy = info.status === "running" || info.status === "awaiting_approval";
  const ready = !exited && info.status !== "starting" && !sending;

  const update = (value: string) => {
    setText(value);
    if (value) drafts.set(draftKey, value);
    else drafts.delete(draftKey);
  };

  // Grow with the draft up to the CSS max-height; measure a shrink only
  // when the text got shorter. The box keeps its height while the field is
  // collapsed to measure, so the transcript above does not move.
  const measured = useRef(0);
  useEffect(() => {
    const element = field.current;
    const box = element?.closest<HTMLElement>(".agent-composer");
    if (!element || !box) return;
    const shrank = text.length < measured.current;
    measured.current = text.length;
    if (shrank) {
      box.style.minHeight = `${box.offsetHeight}px`;
      element.style.height = "0px";
    } else if (element.scrollHeight <= element.clientHeight) return;
    element.style.height = `${element.scrollHeight}px`;
    box.style.minHeight = "";
  }, [text]);

  // Selecting the pane puts the caret here, unless that would raise an
  // on-screen keyboard or take focus from another field.
  const focusAllowed = programmaticFocusAllowed(coarse, keyboard);
  useEffect(() => {
    if (
      active &&
      focusAllowed &&
      !keyboardOverlayOpen() &&
      !isEditableElement(document.activeElement)
    )
      field.current?.focus({ preventScroll: true });
  }, [active, focusAllowed]);

  const voice = useVoiceDictation({
    onText: (spoken, join) => {
      const draft = field.current?.value ?? "";
      update(draft + join(draft, spoken));
    },
    onError: (message) =>
      store.notify({
        kind: "error",
        message: t("Voice typing"),
        detail: message,
      }),
  });

  const submit = async (fromButton: boolean) => {
    const element = field.current;
    if (!element || !ready) return;
    if (fromButton && composing.current) {
      // The button was pressed mid-composition: let the IME commit first.
      await commitTextComposition(element, () => composing.current);
      composing.current = false;
    }
    const draft = element.value;
    if (!draft.trim()) return;
    setSending(true);
    try {
      await onSend(draft);
      update("");
    } catch {
      // Reported by the caller; the draft stays to be sent again.
    } finally {
      setSending(false);
      if (fromButton) element.focus({ preventScroll: true });
    }
  };

  return (
    <div className="agent-composer">
      <TextArea
        ref={field}
        fullWidth
        rows={1}
        textareaClassName="agent-composer-input"
        value={text}
        readOnly={sending}
        disabled={exited}
        placeholder={
          exited
            ? t("This session has ended")
            : info.status === "starting"
              ? t("The agent is starting")
              : busy
                ? t("Add to the running turn")
                : t("Ask the agent")
        }
        aria-label={t("Prompt")}
        autoComplete="off"
        {...PASSWORD_MANAGER_IGNORE}
        onValueChange={update}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          const action = promptEditorKeyAction(event.nativeEvent, {
            empty: text === "",
            applicationCursor: false,
            bindings: getShortcutSnapshot().preset.bindings,
            // An on-screen keyboard's Return has no Shift: it breaks the line.
            enterSends: !coarse || keyboard === "hardware",
          });
          if (action?.type === "send") {
            event.preventDefault();
            void submit(false);
          } else if (action?.type === "newline") {
            event.preventDefault();
            // Keeps the edit on the field's undo stack.
            if (!document.execCommand("insertText", false, "\n")) {
              const element = event.currentTarget;
              element.setRangeText(
                "\n",
                element.selectionStart,
                element.selectionEnd,
                "end",
              );
              update(element.value);
            }
          } else if (action?.type === "page") {
            event.preventDefault();
            onPage(action.direction);
          } else if (action?.type === "forward") {
            // Keys the terminal prompt editor hands to the agent: here an
            // empty box's Escape stops the turn and its Enter does nothing.
            if (action.data === "\r") event.preventDefault();
            if (action.data === "\x1b" && busy) {
              event.preventDefault();
              onInterrupt();
            }
          }
        }}
      />
      <div className="agent-composer-foot">
        <AgentMeta info={info} onSetMode={exited ? undefined : onSetMode} />
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
          label={t("Send")}
          icon={<ArrowUp size={16} />}
          disabled={!ready || !text.trim()}
          onMouseDown={keepFocus}
          onClick={() => void submit(true)}
        />
      </div>
    </div>
  );
}
