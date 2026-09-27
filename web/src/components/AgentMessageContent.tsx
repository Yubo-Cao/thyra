import { useState } from "react";
import { Copy } from "lucide-react";
import { t } from "../i18n";
import { formatUiDateTime } from "../uiLocale";
import { copyTextWithFeedback } from "../copyText";
import { MarkdownPreview } from "./markdown";
import { Button } from "./ui/Button";
import { CloseButton } from "./ui/CloseButton";
import { IconButton } from "./ui/IconButton";
import "./AgentMessageContent.css";

export type AgentMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  kind?: "message" | "tool_call" | "tool_result" | "error";
  tool_name?: string;
  source_call_id?: string;
  is_error?: boolean;
  text: string;
  sent_at: string;
  text_bytes?: number;
};

type ViewMode = "rendered" | "raw";

export function agentMessageRoleLabel(message: AgentMessage) {
  if (message.role !== "tool")
    return message.role === "assistant" ? t("Assistant") : t("User");
  const tool = message.tool_name ?? t("tool");
  return message.kind === "tool_call"
    ? t("Tool arguments: {tool}", { tool })
    : message.is_error
      ? t("Tool error: {tool}", { tool })
      : t("Tool output: {tool}", { tool });
}

export function agentMessageTitle(message: AgentMessage) {
  return t("{role} Message", { role: agentMessageRoleLabel(message) });
}

// Redacted tool entry whose on-demand content has not arrived (yet).
function contentPending(message: AgentMessage) {
  return (
    message.role === "tool" &&
    message.text.length === 0 &&
    (message.text_bytes ?? 0) > 0
  );
}

function defaultViewMode(message: AgentMessage): ViewMode {
  return message.role === "assistant" ? "rendered" : "raw";
}

/** Rendered/raw choice for one message, reset when another entry opens. */
export function useAgentMessageViewMode(message: AgentMessage) {
  const [viewMode, setViewMode] = useState(() => defaultViewMode(message));
  const [viewModeMessageId, setViewModeMessageId] = useState(message.id);
  if (message.id !== viewModeMessageId) {
    // A refreshed snapshot replaces objects, not the user's selected message.
    // Reset only when switching to another entry.
    setViewModeMessageId(message.id);
    setViewMode(defaultViewMode(message));
  }
  const toggle = () =>
    setViewMode((mode) => (mode === "rendered" ? "raw" : "rendered"));
  return [viewMode, toggle] as const;
}

/** Time and call ID under the message title. */
export function AgentMessageMeta({ message }: { message: AgentMessage }) {
  return (
    <>
      <time dateTime={message.sent_at}>
        {formatUiDateTime(message.sent_at)}
      </time>
      {message.source_call_id ? (
        <span className="agent-message-call-id">
          {t("Call ID: {id}", { id: message.source_call_id })}
        </span>
      ) : null}
    </>
  );
}

/** Rendered/raw toggle and copy, shared by the dialog and the inline reader. */
export function AgentMessageActions({
  message,
  viewMode,
  onToggleViewMode,
}: {
  message: AgentMessage;
  viewMode: ViewMode;
  onToggleViewMode: () => void;
}) {
  return (
    <>
      {message.role !== "tool" ? (
        <Button
          onClick={onToggleViewMode}
          aria-label={
            viewMode === "rendered"
              ? t("Show raw markdown")
              : t("Show rendered markdown")
          }
          data-tooltip={
            viewMode === "rendered" ? t("Show raw") : t("Show rendered")
          }
        >
          {viewMode === "rendered" ? t("Raw") : t("Rendered")}
        </Button>
      ) : null}
      {!contentPending(message) ? (
        <IconButton
          label={t("Copy message")}
          tooltip={t("Copy")}
          icon={<Copy size={15} />}
          onClick={() => void copyTextWithFeedback(message.text)}
        />
      ) : null}
    </>
  );
}

export function AgentMessageBody({
  message,
  viewMode,
}: {
  message: AgentMessage;
  viewMode: ViewMode;
}) {
  if (contentPending(message)) {
    return (
      <pre className="agent-message-modal-content">
        {t("Loading tool content…")}
      </pre>
    );
  }
  if (message.role !== "tool" && viewMode === "rendered") {
    return (
      <div className="agent-message-modal-content is-rendered">
        <MarkdownPreview
          text={message.text}
          className="agent-message-markdown"
          breaks
        />
      </div>
    );
  }
  return <pre className="agent-message-modal-content">{message.text}</pre>;
}

// The inline History reader: the message with its own header bar.
export function AgentMessageContent({
  message,
  onClose,
}: {
  message: AgentMessage;
  onClose: () => void;
}) {
  const [viewMode, toggleViewMode] = useAgentMessageViewMode(message);
  return (
    <>
      <div className="agent-message-modal-head">
        <div>
          <h3>{agentMessageTitle(message)}</h3>
          <AgentMessageMeta message={message} />
        </div>
        <div className="agent-message-modal-actions">
          <AgentMessageActions
            message={message}
            viewMode={viewMode}
            onToggleViewMode={toggleViewMode}
          />
          <CloseButton
            label={t("Close message detail")}
            tooltip={t("Close detail")}
            onClick={onClose}
          />
        </div>
      </div>
      <AgentMessageBody message={message} viewMode={viewMode} />
    </>
  );
}
