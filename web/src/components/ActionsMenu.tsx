import { useMemo } from "react";
import { t } from "../i18n";
import { ContextMenu } from "./ui/ContextMenu";
import type { MenuSection } from "./ui/Menu";

export type ActionsMenuItem = {
  key: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  detail?: string;
  action: () => void;
};

export type ActionsMenuGroup = {
  label: string;
  items: ActionsMenuItem[];
  danger?: boolean;
};

/**
 * Grouped action menu at a point (right-click, long-press, keyboard, or a
 * toolbar button's corner), rendered by the shared ui/ ContextMenu: Escape,
 * outside presses, arrows, typeahead, viewport flipping, and focus return
 * come from React Aria. Mount it while open; `onClose` unmounts it.
 */
export function ActionsMenu({
  x,
  y,
  header,
  groups,
  onClose,
}: {
  x: number;
  y: number;
  header?: { title: string; subtitle?: string };
  groups: ActionsMenuGroup[];
  onClose: () => void;
}) {
  const position = useMemo(() => ({ x, y }), [x, y]);
  const sections = useMemo<MenuSection[]>(
    () =>
      groups.map((group) => ({
        id: group.label,
        // A single group needs no heading, as before.
        title: groups.length > 1 ? group.label : undefined,
        danger: group.danger,
        items: group.items.map((item) => ({
          id: item.key,
          label: item.label,
          description: item.detail,
          danger: item.danger,
          disabled: item.disabled,
          onAction: item.action,
        })),
      })),
    [groups],
  );
  return (
    <ContextMenu
      position={position}
      onClose={onClose}
      items={sections}
      aria-label={header?.title ?? t("Actions")}
      header={header}
    />
  );
}
