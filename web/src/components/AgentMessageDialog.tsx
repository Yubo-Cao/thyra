import { useRef } from "react";
import { t } from "../i18n";
import {
  AgentMessageActions,
  AgentMessageBody,
  AgentMessageMeta,
  agentMessageTitle,
  useAgentMessageViewMode,
  type AgentMessage,
} from "./AgentMessageContent";
import { Dialog } from "./ui/Dialog";
import "./AgentMessageDialog.css";

export function AgentMessageDialog({
  message,
  onClose,
}: {
  message: AgentMessage | null;
  onClose: () => void;
}) {
  // Keep the last message so the dialog's exit animation still shows it.
  const lastMessageRef = useRef(message);
  if (message) lastMessageRef.current = message;
  const shown = lastMessageRef.current;
  if (!shown) return null;
  return <MessageDialog message={shown} open={!!message} onClose={onClose} />;
}

function MessageDialog({
  message,
  open,
  onClose,
}: {
  message: AgentMessage;
  open: boolean;
  onClose: () => void;
}) {
  const [viewMode, toggleViewMode] = useAgentMessageViewMode(message);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={agentMessageTitle(message)}
      description={<AgentMessageMeta message={message} />}
      headerActions={
        <AgentMessageActions
          message={message}
          viewMode={viewMode}
          onToggleViewMode={toggleViewMode}
        />
      }
      closeLabel={t("Close message")}
      size="lg"
      className="agent-message-dialog"
      bodyClassName="agent-message-dialog-body"
    >
      <AgentMessageBody message={message} viewMode={viewMode} />
    </Dialog>
  );
}
