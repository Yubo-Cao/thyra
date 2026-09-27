import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./GlobalTooltip.css";

type TooltipPlacement = "top" | "bottom";

type TooltipState = {
  text: string;
  left: number;
  top: number;
  placement: TooltipPlacement;
};

const TOOLTIP_DELAY_MS = 260;
const VIEWPORT_PADDING = 12;
const ARROW_EDGE_INSET = 10;

// Components in components/ui (IconButton) set data-tooltip, which needs no
// title juggling; plain elements may still use a title attribute.
function tooltipText(element: HTMLElement) {
  return (element.dataset.tooltip ?? element.getAttribute("title"))?.trim();
}

function tooltipTarget(start: EventTarget | null): HTMLElement | null {
  if (!(start instanceof Element)) return null;
  const target = start.closest<HTMLElement>("[data-tooltip], [title]");
  return target && tooltipText(target) ? target : null;
}

// matches() throws a SyntaxError for :focus-visible on browsers without the
// pseudo-class (e.g. Safari < 15.4); this runs inside a document-level focus
// listener, so translate that failure into "not keyboard focus" and skip the
// focus tooltip instead of throwing on every focus event.
function matchesFocusVisible(target: HTMLElement) {
  try {
    return target.matches(":focus-visible");
  } catch {
    return false;
  }
}

// Anchor the tooltip centered on the element; the rendered size is clamped
// to the viewport after layout (see clampToViewport).
function tooltipPosition(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const scale =
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"),
    ) || 1;
  const placement: TooltipPlacement = rect.top > 52 ? "top" : "bottom";
  return {
    left: (rect.left + rect.width / 2) / scale,
    top: (placement === "top" ? rect.top - 9 : rect.bottom + 9) / scale,
    placement,
  };
}

/**
 * Shift a rendered tooltip horizontally so it stays inside the viewport,
 * keeping the arrow on the anchor. Measures the real box, so any script and
 * font width works; one read and one write, before paint.
 */
function clampToViewport(tooltip: HTMLElement, left: number) {
  tooltip.style.left = `${left}px`;
  tooltip.style.removeProperty("--tooltip-arrow-shift");
  const rect = tooltip.getBoundingClientRect();
  // Client rects and style px differ under the root CSS zoom (UI scale).
  const ratio = tooltip.offsetWidth > 0 ? rect.width / tooltip.offsetWidth : 1;
  let shift = 0;
  const maxRight = window.innerWidth - VIEWPORT_PADDING;
  if (rect.right > maxRight) shift = maxRight - rect.right;
  if (rect.left + shift < VIEWPORT_PADDING)
    shift = VIEWPORT_PADDING - rect.left;
  if (shift === 0) return;
  const styleShift = shift / ratio;
  const arrowLimit = Math.max(0, tooltip.offsetWidth / 2 - ARROW_EDGE_INSET);
  const arrowShift = Math.max(-arrowLimit, Math.min(arrowLimit, -styleShift));
  tooltip.style.left = `${left + styleShift}px`;
  tooltip.style.setProperty("--tooltip-arrow-shift", `${arrowShift}px`);
}

export function GlobalTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const activeElementRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (tooltip && tooltipRef.current)
      clampToViewport(tooltipRef.current, tooltip.left);
  }, [tooltip]);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current === null) return;
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };

    const restoreTitle = (element: HTMLElement | null) => {
      if (!element) return;
      const title = element.dataset.herdrTooltipTitle;
      if (title === undefined) return;
      element.setAttribute("title", title);
      delete element.dataset.herdrTooltipTitle;
    };

    const hide = () => {
      clearTimer();
      restoreTitle(activeElementRef.current);
      activeElementRef.current = null;
      setTooltip(null);
    };

    const dispose = () => {
      clearTimer();
      restoreTitle(activeElementRef.current);
      activeElementRef.current = null;
    };

    const showFor = (element: HTMLElement) => {
      if (activeElementRef.current === element) return;
      hide();
      const text = tooltipText(element);
      if (!text) return;
      activeElementRef.current = element;
      if (element.dataset.tooltip === undefined) {
        element.dataset.herdrTooltipTitle = text;
        element.removeAttribute("title");
      }
      timerRef.current = window.setTimeout(() => {
        if (activeElementRef.current !== element) return;
        setTooltip({ text, ...tooltipPosition(element) });
      }, TOOLTIP_DELAY_MS);
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = tooltipTarget(event.target);
      if (target) showFor(target);
    };
    const onPointerOut = (event: PointerEvent) => {
      const active = activeElementRef.current;
      if (!active) return;
      const related = event.relatedTarget;
      if (related instanceof Node && active.contains(related)) return;
      hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTarget(event.target);
      // Only keyboard-driven focus deserves a tooltip. Touch taps also focus
      // buttons on some mobile browsers, and a tooltip shown then lingers
      // until the next tap blurs the button. Browsers exclude exactly that
      // case from :focus-visible while keeping keyboard navigation focused.
      if (!target || !matchesFocusVisible(target)) return;
      showFor(target);
    };
    const onFocusOut = () => hide();
    const onPointerDown = () => hide();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKeyDown, true);
      dispose();
    };
  }, []);

  if (!tooltip) return null;

  return (
    <div
      ref={tooltipRef}
      className={`global-tooltip global-tooltip-${tooltip.placement}`}
      style={{ left: tooltip.left, top: tooltip.top }}
      role="tooltip"
    >
      {tooltip.text}
    </div>
  );
}
