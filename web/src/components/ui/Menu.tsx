import {
  Suspense,
  cloneElement,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type Ref,
} from "react";
import {
  LazyMenuPopover,
  preloadOverlays,
  useOpenedOnce,
} from "./lazyOverlays";
import type { MenuEntry } from "./menuModel";
import { chainHandlers, mergeRefs } from "./mergeRefs";

export type { MenuEntry, MenuItem, MenuSection } from "./menuModel";

export type MenuPlacement =
  | "bottom start"
  | "bottom end"
  | "top start"
  | "top end"
  | "right top"
  | "left top";

/** Optional title block above the items, e.g. the workspace a menu acts on. */
export type MenuHeader = { title: string; subtitle?: string };

export type MenuFocusTarget = "menu" | "first" | "last";

type TriggerProps = {
  ref?: Ref<HTMLElement>;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  "aria-haspopup"?: "menu";
  "aria-expanded"?: boolean;
};

export type MenuProps = {
  /** A Button or IconButton (any element forwarding ref and DOM props). */
  trigger: ReactElement;
  /** Items and sections; see MenuItem for icon, shortcut, danger, checked, disabled. */
  items: readonly MenuEntry[];
  "aria-label": string;
  header?: MenuHeader;
  placement?: MenuPlacement;
  /** Called with the item id after the item's own onAction. */
  onAction?: (id: string) => void;
  /** Control the open state; omit both for an uncontrolled menu. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * Dropdown menu (React Aria Menu with HeroUI styling) opened from a trigger
 * button: click/Enter/Space/ArrowDown open it, arrows and typeahead move,
 * Escape and outside presses close it, focus returns to the trigger. The
 * trigger stays a plain Button; the menu loads with the overlay chunk
 * (prefetched on trigger hover/focus).
 */
export function Menu({
  trigger,
  items,
  "aria-label": ariaLabel,
  header,
  placement = "bottom start",
  onAction,
  open: controlledOpen,
  onOpenChange,
}: MenuProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [focusTarget, setFocusTarget] = useState<MenuFocusTarget>("menu");
  const open = controlledOpen ?? uncontrolledOpen;
  const mounted = useOpenedOnce(open);
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const props = (trigger as ReactElement<TriggerProps>).props;
  const childRef = props.ref;
  const ref = useMemo(() => mergeRefs(triggerRef, childRef), [childRef]);
  const element = cloneElement(trigger as ReactElement<TriggerProps>, {
    ref,
    "aria-haspopup": "menu",
    "aria-expanded": open,
    onPointerEnter: chainHandlers(props.onPointerEnter, preloadOverlays),
    onFocus: chainHandlers(props.onFocus, preloadOverlays),
    onClick: chainHandlers(props.onClick, (event) => {
      if (event.defaultPrevented) return;
      // detail 0: activated from the keyboard (Enter/Space).
      setFocusTarget(event.detail === 0 ? "first" : "menu");
      setOpen(!open);
    }),
    onKeyDown: chainHandlers(props.onKeyDown, (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      setFocusTarget(event.key === "ArrowDown" ? "first" : "last");
      setOpen(true);
    }),
  });

  return (
    <>
      {element}
      {mounted ? (
        <Suspense fallback={null}>
          <LazyMenuPopover
            anchor={{ triggerRef }}
            open={open}
            onOpenChange={setOpen}
            items={items}
            aria-label={ariaLabel}
            header={header}
            placement={placement}
            focusTarget={focusTarget}
            onAction={onAction}
          />
        </Suspense>
      ) : null}
    </>
  );
}

/** Alias: the menu attached to a trigger button. */
export const DropdownMenu = Menu;
