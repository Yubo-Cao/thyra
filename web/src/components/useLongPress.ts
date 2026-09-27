import { type MouseEvent, type PointerEvent, useEffect, useRef } from "react";

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;

/**
 * Touch and pen long-press that opens the same menu as a desktop right-click.
 * Spread `handlers` on the target; `consumeClick` swallows the click that
 * ends a long-press and reports whether it did.
 */
export function useLongPress(onLongPress: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const triggered = useRef(false);
  const clearTimer = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clearTimer, []);
  const end = () => {
    clearTimer();
    start.current = null;
  };
  return {
    consumeClick(e: MouseEvent) {
      if (!triggered.current) return false;
      triggered.current = false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
    handlers: {
      onPointerDown(e: PointerEvent) {
        if (e.pointerType === "mouse") return;
        triggered.current = false;
        start.current = { x: e.clientX, y: e.clientY };
        clearTimer();
        timer.current = setTimeout(() => {
          triggered.current = true;
          onLongPress(e.clientX, e.clientY);
        }, LONG_PRESS_MS);
      },
      onPointerMove(e: PointerEvent) {
        const origin = start.current;
        if (!origin) return;
        const dx = Math.abs(e.clientX - origin.x);
        const dy = Math.abs(e.clientY - origin.y);
        if (dx > LONG_PRESS_MOVE_PX || dy > LONG_PRESS_MOVE_PX) end();
      },
      onPointerUp: end,
      onPointerCancel: end,
      onPointerLeave: end,
    },
  };
}
