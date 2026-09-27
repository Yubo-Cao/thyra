import {
  Suspense,
  cloneElement,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { LazyPopover, preloadOverlays, useOpenedOnce } from "./lazyOverlays";
import { chainHandlers, mergeRefs } from "./mergeRefs";

export type PopoverPlacement =
  | "bottom start"
  | "bottom"
  | "bottom end"
  | "top start"
  | "top"
  | "top end"
  | "left"
  | "right";

type TriggerProps = {
  ref?: Ref<HTMLElement>;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  "aria-haspopup"?: "dialog";
  "aria-expanded"?: boolean;
};

export type PopoverProps = {
  /** A Button or IconButton (any element forwarding ref and DOM props). */
  trigger: ReactElement;
  /** Panel content; a function receives `close`. */
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Accessible name of the panel (it has role="dialog"). */
  "aria-label": string;
  placement?: PopoverPlacement;
  /** Control the open state; omit both for an uncontrolled popover. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

/**
 * Anchored, non-modal panel for small forms and pickers (React Aria Popover
 * + Dialog): Escape and outside presses close it and focus returns to the
 * trigger. Loads with the overlay chunk, prefetched on trigger hover/focus.
 */
export function Popover({
  trigger,
  children,
  "aria-label": ariaLabel,
  placement = "bottom start",
  open: controlledOpen,
  onOpenChange,
  className,
}: PopoverProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
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
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    onPointerEnter: chainHandlers(props.onPointerEnter, preloadOverlays),
    onFocus: chainHandlers(props.onFocus, preloadOverlays),
    onClick: chainHandlers(props.onClick, (event) => {
      if (!event.defaultPrevented) setOpen(!open);
    }),
  });
  return (
    <>
      {element}
      {mounted ? (
        <Suspense fallback={null}>
          <LazyPopover
            triggerRef={triggerRef}
            open={open}
            onOpenChange={setOpen}
            aria-label={ariaLabel}
            placement={placement}
            className={className}
          >
            {typeof children === "function"
              ? children(() => setOpen(false))
              : children}
          </LazyPopover>
        </Suspense>
      ) : null}
    </>
  );
}
