import { useCallback, useEffect, useRef } from "react";
import { thyraLocalStorage } from "../browserStorage";

/**
 * The phone layout's floating controls (the workspaces shortcut, the tools
 * strip with its toggle, the view switcher) can be dragged out of the way.
 * They move as one: an offset from where the layout puts them, kept in two
 * custom properties on `.app` that their `translate` reads (mobile-nav.css).
 */

/** Pixels from the controls' place in the layout; never right of or below it. */
export type ControlsOffset = { x: number; y: number };
export type ControlsBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const STORAGE_KEY = "mobileControlsOffset";
const HOME: ControlsOffset = { x: 0, y: 0 };
/** A press that moves less than this is a tap on the button under it. */
const DRAG_START_PX = 8;
/** Dropped this close to their place in the layout, the controls return to it. */
const HOME_SNAP_PX = 14;
const EDGE_MARGIN_PX = 6;
/** The pieces that move together; the strip is the one a collapse leaves. */
const STRIP = "mobile-terminal-controls";
const PIECES = `.mobile-workspace-shortcut, .${STRIP}, .mobile-nav:not(.mobile-terminal-tools)`;

/**
 * The offset nearest to `offset` that keeps `home` (the controls' box at no
 * offset) on screen: right of `left` and below `top`. The layout's own
 * corner is the limit on the right and at the bottom.
 */
export function clampControlsOffset(
  offset: ControlsOffset,
  home: ControlsBox | null,
  limit: { left: number; top: number } = { left: 0, top: 0 },
): ControlsOffset {
  if (!home) return HOME;
  const within = (value: number, start: number, edge: number) =>
    Math.round(
      Math.min(0, Math.max(value, Math.min(0, edge + EDGE_MARGIN_PX - start))),
    );
  return {
    x: within(offset.x, home.left, limit.left),
    y: within(offset.y, home.top, limit.top),
  };
}

/** A stored offset, or the layout's place for anything else. */
export function parseControlsOffset(stored: string | null): ControlsOffset {
  if (!stored) return HOME;
  try {
    const value: unknown = JSON.parse(stored);
    if (value && typeof value === "object") {
      const { x, y } = value as { x?: unknown; y?: unknown };
      if (
        typeof x === "number" &&
        typeof y === "number" &&
        Number.isFinite(x) &&
        Number.isFinite(y)
      )
        return { x: Math.min(0, x), y: Math.min(0, y) };
    }
  } catch {
    // Not ours, or damaged: the controls start in their place.
  }
  return HOME;
}

/**
 * The box of the showing pieces at no offset, in the frame's coordinates.
 * Read from the layout (anchors and sizes), not from where the pieces are
 * painted, which their show and hide transforms move.
 */
function measureHome(
  frame: HTMLElement,
  collapsed: boolean,
): ControlsBox | null {
  let box: ControlsBox | null = null;
  for (const piece of frame.querySelectorAll<HTMLElement>(PIECES)) {
    if (collapsed && !piece.classList.contains(STRIP)) continue;
    const style = getComputedStyle(piece);
    const right = frame.clientWidth - Number.parseFloat(style.right);
    const bottom = frame.clientHeight - Number.parseFloat(style.bottom);
    if (
      style.display === "none" ||
      !Number.isFinite(right) ||
      !Number.isFinite(bottom)
    )
      continue;
    const left = right - piece.offsetWidth;
    const top = bottom - piece.offsetHeight;
    box = box
      ? {
          left: Math.min(box.left, left),
          top: Math.min(box.top, top),
          right: Math.max(box.right, right),
          bottom: Math.max(box.bottom, bottom),
        }
      : { left, top, right, bottom };
  }
  return box;
}

/**
 * Drag handlers for the floating controls: spread them on each piece. The
 * place is remembered on this device and stays on screen when the screen,
 * or the set of showing pieces, changes.
 */
export function useMobileControlsDrag(enabled: boolean, collapsed: boolean) {
  /** Where the user left the controls; what shows is this, kept on screen. */
  const wanted = useRef<ControlsOffset | null>(null);
  const shown = useRef<ControlsOffset>(HOME);
  /** The press became a drag: the click that ends it is not a tap. */
  const dragged = useRef(false);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  const place = useCallback((offset?: ControlsOffset) => {
    const frame = document.querySelector<HTMLElement>(".app");
    if (!frame) return;
    wanted.current ??= parseControlsOffset(
      thyraLocalStorage.getItem(STORAGE_KEY),
    );
    // The top bar is drawn over the controls: they stay below it.
    const bar = frame.querySelector<HTMLElement>(".topbar");
    const next = clampControlsOffset(
      offset ?? wanted.current,
      measureHome(frame, collapsedRef.current),
      { left: 0, top: bar ? bar.offsetTop + bar.offsetHeight : 0 },
    );
    shown.current = next;
    frame.style.setProperty("--mobile-controls-dx", `${next.x}px`);
    frame.style.setProperty("--mobile-controls-dy", `${next.y}px`);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // Also runs when the controls collapse or open: fewer or more pieces
    // have to fit.
    void collapsed;
    place();
    const frame = document.querySelector<HTMLElement>(".app");
    const again = () => place();
    const sizes = new ResizeObserver(again);
    if (frame) {
      sizes.observe(frame);
      for (const piece of frame.querySelectorAll(PIECES)) sizes.observe(piece);
    }
    window.addEventListener("resize", again);
    return () => {
      sizes.disconnect();
      window.removeEventListener("resize", again);
    };
  }, [enabled, collapsed, place]);

  useEffect(() => {
    if (enabled) return;
    const frame = document.querySelector<HTMLElement>(".app");
    frame?.style.removeProperty("--mobile-controls-dx");
    frame?.style.removeProperty("--mobile-controls-dy");
  }, [enabled]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      dragged.current = false;
      if (!enabled || (event.pointerType === "mouse" && event.button !== 0))
        return;
      const piece = event.currentTarget;
      const pointer = event.pointerId;
      const from = { x: event.clientX, y: event.clientY };
      const origin = shown.current;
      // A drag whose touches the page has taken is not also a fling to the
      // browser, which would swallow a tap that follows a quick one.
      const take = (touch: TouchEvent) => {
        if (dragged.current && touch.cancelable) touch.preventDefault();
      };
      const move = (moved: PointerEvent) => {
        if (moved.pointerId !== pointer) return;
        const x = moved.clientX - from.x;
        const y = moved.clientY - from.y;
        if (!dragged.current) {
          if (Math.hypot(x, y) < DRAG_START_PX) return;
          dragged.current = true;
          try {
            // Keeps the drag off whatever the controls pass over.
            piece.setPointerCapture(pointer);
          } catch {
            // The pointer is already gone; its end follows.
          }
        }
        place({ x: origin.x + x, y: origin.y + y });
      };
      const end = (ended: PointerEvent) => {
        if (ended.pointerId !== pointer) return;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("touchmove", take);
        if (!dragged.current) return;
        const dropped = shown.current;
        wanted.current =
          Math.hypot(dropped.x, dropped.y) < HOME_SNAP_PX ? HOME : dropped;
        thyraLocalStorage.setItem(STORAGE_KEY, JSON.stringify(wanted.current));
        place();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      window.addEventListener("touchmove", take, { passive: false });
    },
    [enabled, place],
  );

  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!dragged.current) return;
    dragged.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { onPointerDown, onClickCapture };
}

export type MobileControlsDrag = ReturnType<typeof useMobileControlsDrag>;
