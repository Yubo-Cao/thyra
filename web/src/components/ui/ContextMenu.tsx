import { Suspense, useRef } from "react";
import { LazyMenuPopover, useOpenedOnce } from "./lazyOverlays";
import type { MenuHeader } from "./Menu";
import type { MenuEntry } from "./menuModel";

export type ContextMenuPosition = { x: number; y: number };

export type ContextMenuProps = {
  /** Viewport point to open at (event.clientX/Y); null closes the menu. */
  position: ContextMenuPosition | null;
  /** Called on Escape, outside press, scroll-away, or after an item runs. */
  onClose: () => void;
  items: readonly MenuEntry[];
  "aria-label": string;
  header?: MenuHeader;
  onAction?: (id: string) => void;
  /** Focus the first item on open; default true for keyboard-opened menus. */
  autoFocusFirst?: boolean;
};

/**
 * The Menu opened at a pointer position (right-click, long-press, or the
 * Menu key). The popover flips and shifts to stay inside the viewport and
 * returns focus to the element focused before it opened.
 */
export function ContextMenu({
  position,
  onClose,
  items,
  "aria-label": ariaLabel,
  header,
  onAction,
  autoFocusFirst = true,
}: ContextMenuProps) {
  const lastPosition = useRef<ContextMenuPosition>({ x: 0, y: 0 });
  if (position) lastPosition.current = position;
  const open = position !== null;
  const mounted = useOpenedOnce(open);
  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <LazyMenuPopover
        anchor={{ point: lastPosition.current }}
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        items={items}
        aria-label={ariaLabel}
        header={header}
        placement="bottom start"
        focusTarget={autoFocusFirst ? "first" : "menu"}
        onAction={onAction}
      />
    </Suspense>
  );
}
