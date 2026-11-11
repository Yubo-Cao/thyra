// Drag a pane by its header onto another pane of the same tab. A mouse or
// pen drags after a small movement, a finger after a long press (see
// paneDragGesture.ts), so plain clicks and taps still focus and copy. Escape,
// a second finger, or a cancelled pointer abandons it.
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { PaneDragGesture, setPaneDragHeld } from "../paneDragGesture";
import { type PaneDropTarget, paneDropTarget } from "../paneDrop";
import { store } from "../store";
import type { PaneLayout } from "../types";

const PANE_HEADER = ".terminal-pane-head";
/** Header controls keep their own pointer behaviour. */
const HEADER_CONTROL = "button, a, input, textarea, select, [contenteditable]";

export type PaneDragState = {
  sourcePaneId: string;
  /** False while a long-pressed finger holds the pane but has not moved. */
  moving: boolean;
  target: PaneDropTarget | null;
};

/** Swallow the click a browser fires after a drag ends over the header. */
function suppressNextClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

export function usePaneDrag(
  layout: PaneLayout | null,
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [drag, setDrag] = useState<PaneDragState | null>(null);
  const layoutRef = useRef(layout);
  const endRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  useEffect(() => {
    if (!enabled) endRef.current?.();
  }, [enabled]);
  useEffect(() => () => endRef.current?.(), []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0 || !event.isPrimary) return;
      const element = event.target;
      if (!(element instanceof Element)) return;
      const header = element.closest<HTMLElement>(PANE_HEADER);
      if (!header || element.closest(HEADER_CONTROL)) return;
      const sourcePaneId =
        header.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
      if (!sourcePaneId) return;
      endRef.current?.();

      const { pointerId } = event;
      const body = document.body.style;
      const previousCursor = body.cursor;
      const previousUserSelect = body.userSelect;
      let target: PaneDropTarget | null = null;

      // The header keeps the pointer even when the finger or mouse leaves it.
      const hold = () => {
        setPaneDragHeld(true);
        try {
          header.setPointerCapture(pointerId);
        } catch {
          // The pointer is already gone; its up or cancel ends the drag.
        }
        body.userSelect = "none";
      };
      const gesture = new PaneDragGesture(
        { x: event.clientX, y: event.clientY },
        event.pointerType === "touch",
        () => {
          hold();
          navigator.vibrate?.(10);
          setDrag({ sourcePaneId, moving: false, target: null });
        },
      );

      const layoutPoint = (e: PointerEvent) => {
        const current = layoutRef.current;
        const container = containerRef.current;
        if (!current || !container) return null;
        const bounds = container.getBoundingClientRect();
        const { area } = current;
        return {
          x:
            area.x +
            ((e.clientX - bounds.left) / Math.max(1, bounds.width)) *
              Math.max(1, area.width),
          y:
            area.y +
            ((e.clientY - bounds.top) / Math.max(1, bounds.height)) *
              Math.max(1, area.height),
        };
      };
      const move = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        const before = gesture.phase;
        const phase = gesture.move({ x: e.clientX, y: e.clientY });
        if (phase === "abandoned") return end();
        if (phase !== "dragging") return;
        if (before === "pending") hold();
        if (before !== "dragging") body.cursor = "grabbing";
        e.preventDefault();
        const point = layoutPoint(e);
        target =
          point && layoutRef.current
            ? paneDropTarget(point, layoutRef.current.panes, sourcePaneId)
            : null;
        setDrag({ sourcePaneId, moving: true, target });
      };
      const end = () => {
        const held = gesture.holding;
        gesture.abandon();
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", cancel, true);
        window.removeEventListener("pointerdown", otherPointer, true);
        window.removeEventListener("contextmenu", menu, true);
        window.removeEventListener("touchmove", touchMove, true);
        window.removeEventListener("keydown", key, true);
        window.removeEventListener("blur", end);
        if (held) {
          setPaneDragHeld(false);
          body.cursor = previousCursor;
          body.userSelect = previousUserSelect;
          if (header.hasPointerCapture?.(pointerId))
            header.releasePointerCapture(pointerId);
        }
        if (endRef.current === end) endRef.current = null;
        setDrag(null);
      };
      // iOS cancels the pointer when it takes the gesture over.
      const cancel = (e: PointerEvent) => {
        if (e.pointerId === pointerId) end();
      };
      // A second finger makes this a multi-touch gesture, not a pane drag.
      const otherPointer = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) end();
      };
      const up = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        const dropped = gesture.phase === "dragging" ? target : null;
        const held = gesture.holding;
        end();
        if (!held) return;
        suppressNextClick();
        const tabId = layoutRef.current?.tab_id;
        if (dropped && tabId)
          void store.rearrangePane(sourcePaneId, dropped, tabId);
      };
      // The long press would otherwise open the context menu or the iOS
      // callout; a held drag also keeps the page from scrolling.
      const menu = (e: Event) => {
        if (gesture.touch || gesture.holding) e.preventDefault();
      };
      const touchMove = (e: TouchEvent) => {
        if (gesture.holding && e.cancelable) e.preventDefault();
      };
      const key = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        if (gesture.holding) {
          e.preventDefault();
          e.stopPropagation();
        }
        end();
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", cancel, true);
      window.addEventListener("pointerdown", otherPointer, true);
      window.addEventListener("contextmenu", menu, true);
      window.addEventListener("touchmove", touchMove, {
        capture: true,
        passive: false,
      });
      window.addEventListener("keydown", key, true);
      window.addEventListener("blur", end);
      endRef.current = end;
    },
    [enabled, containerRef],
  );

  return { drag, onPointerDown };
}
