import { Clock, Pencil, X } from "lucide-react";
import type { AgentQueuedPrompt } from "../../../../shared/agentSession";
import { t } from "../../i18n";
import { IconButton } from "../ui/IconButton";

/**
 * Prompts waiting for the running turn to end, in the order they go. Those
 * who may act take one back into the box, or drop it.
 */
export function AgentQueue({
  queued,
  onEdit,
  onRemove,
}: {
  queued: AgentQueuedPrompt[];
  onEdit?: (prompt: AgentQueuedPrompt) => void;
  onRemove?: (prompt: AgentQueuedPrompt) => void;
}) {
  if (queued.length === 0) return null;
  return (
    <ul className="agent-queue" aria-label={t("Queued prompts")}>
      {queued.map((prompt) => {
        const images = prompt.images?.length ?? 0;
        return (
          <li key={prompt.id} className="agent-queued">
            <Clock size={13} aria-hidden />
            <span className="agent-queued-text" title={prompt.text}>
              {prompt.text.trim() ||
                t("{count} images", { count: String(images) })}
            </span>
            {onEdit ? (
              <IconButton
                size="sm"
                label={
                  images
                    ? t("A prompt with images cannot be edited")
                    : t("Edit before it is sent")
                }
                icon={<Pencil size={13} />}
                disabled={images > 0}
                onClick={() => onEdit(prompt)}
              />
            ) : null}
            {onRemove ? (
              <IconButton
                size="sm"
                tone="danger"
                label={t("Remove from the queue")}
                icon={<X size={14} />}
                onClick={() => onRemove(prompt)}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
