import {
  Children,
  Suspense,
  cloneElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "../../utils";
import { LazyTooltipPopup, useOpenedOnce } from "./lazyOverlays";
import { chainHandlers, mergeRefs } from "./mergeRefs";
import { tooltipTiming } from "./tooltipTiming";

export type TooltipPlacement =
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top start"
  | "top end"
  | "bottom start"
  | "bottom end";

type TriggerProps = {
  ref?: Ref<HTMLElement>;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  "aria-describedby"?: string;
};

export type TooltipProps = {
  /** Tooltip text, already translated. */
  content: ReactNode;
  /** One element that forwards its ref and DOM event props (Button, IconButton, a native element). */
  children: ReactElement;
  placement?: TooltipPlacement;
  disabled?: boolean;
  /** Link the tooltip with aria-describedby; turn off when it repeats the accessible name. */
  describe?: boolean;
};

function isKeyboardFocus(element: Element) {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * Hover (after a shared delay) or keyboard-focus tooltip. Touch input never
 * opens it. The trigger logic is tiny and eager; the positioned popup
 * (React Aria Tooltip) loads with the overlay chunk on first use.
 */
export function Tooltip({
  content,
  children,
  placement = "top",
  disabled = false,
  describe = true,
}: TooltipProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const mounted = useOpenedOnce(open);
  const id = useId();
  const active = open && !disabled && content != null && content !== "";

  useEffect(() => {
    if (!active) return;
    tooltipTiming.opened();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      tooltipTiming.closed(performance.now());
    };
  }, [active]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const child = Children.only(children) as ReactElement<TriggerProps>;
  const childProps = child.props;
  const childRef = childProps.ref;
  const ref = useMemo(() => mergeRefs(triggerRef, childRef), [childRef]);

  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };
  const trigger = cloneElement(child, {
    ref,
    onPointerEnter: chainHandlers(childProps.onPointerEnter, (event) => {
      if (event.pointerType === "touch" || disabled) return;
      window.clearTimeout(timer.current);
      const delay = tooltipTiming.showDelay(performance.now());
      if (delay === 0) setOpen(true);
      else timer.current = window.setTimeout(() => setOpen(true), delay);
    }),
    onPointerLeave: chainHandlers(childProps.onPointerLeave, hide),
    onPointerDown: chainHandlers(childProps.onPointerDown, hide),
    onFocus: chainHandlers(childProps.onFocus, (event) => {
      if (!disabled && isKeyboardFocus(event.currentTarget)) setOpen(true);
    }),
    onBlur: chainHandlers(childProps.onBlur, hide),
    "aria-describedby":
      active && describe
        ? cn(childProps["aria-describedby"], id)
        : childProps["aria-describedby"],
  });

  return (
    <>
      {trigger}
      {mounted && !disabled ? (
        <Suspense fallback={null}>
          <LazyTooltipPopup
            id={id}
            triggerRef={triggerRef}
            open={active}
            onOpenChange={setOpen}
            placement={placement}
          >
            {content}
          </LazyTooltipPopup>
        </Suspense>
      ) : null}
    </>
  );
}
