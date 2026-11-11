import { GitBranch, Pencil, Undo2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { UserItem } from "../../agentSession/editPrompt";
import { t } from "../../i18n";
import { ContextMenu, type ContextMenuPosition } from "../ui/ContextMenu";
import { IconButton } from "../ui/IconButton";
import type { MenuItem } from "../ui/menuModel";
import { useLongPress } from "../useLongPress";

/** What a prompt's actions do; absent where the viewer cannot act. */
export type PromptActionHandlers = {
  /** Why the actions wait, while the session cannot take them now. */
  blocked: string | null;
  /** Go back to before the prompt and put it in the box to be changed. */
  onEdit(item: UserItem): void;
  /** Go back to before the prompt. */
  onRewind(item: UserItem): void;
  /** Continue a copy of the conversation from before it, in a new pane. */
  onBranch(item: UserItem): void;
};

/**
 * A sent prompt with what can be done from it: a toolbar on hover or focus,
 * and the same choices in a menu on a long press, where nothing hovers.
 */
export function AgentPromptActions({
  item,
  actions,
  children,
}: {
  item: UserItem;
  actions: PromptActionHandlers;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null);
  const longPress = useLongPress((x, y) => setMenu({ x, y }));
  const disabled = actions.blocked !== null;
  const choices: MenuItem[] = [
    {
      id: "edit",
      label: t("Edit this prompt"),
      icon: <Pencil size={14} />,
      disabled,
      onAction: () => actions.onEdit(item),
    },
    {
      id: "rewind",
      label: t("Rewind to before this prompt"),
      icon: <Undo2 size={14} />,
      disabled,
      onAction: () => actions.onRewind(item),
    },
    {
      id: "branch",
      label: t("Branch from before this prompt"),
      icon: <GitBranch size={14} />,
      disabled,
      onAction: () => actions.onBranch(item),
    },
  ];
  return (
    <div
      className="agent-prompt"
      {...longPress.handlers}
      onClickCapture={(event) => longPress.consumeClick(event)}
    >
      {children}
      <div
        className="agent-prompt-actions"
        role="toolbar"
        aria-label={t("Prompt actions")}
      >
        {choices.map((choice) => (
          <IconButton
            key={choice.id}
            label={choice.label}
            tooltip={actions.blocked ?? choice.label}
            icon={choice.icon}
            disabled={disabled}
            onClick={choice.onAction}
          />
        ))}
      </div>
      <ContextMenu
        position={menu}
        onClose={() => setMenu(null)}
        aria-label={t("Prompt actions")}
        header={actions.blocked ? { title: actions.blocked } : undefined}
        items={choices}
      />
    </div>
  );
}
