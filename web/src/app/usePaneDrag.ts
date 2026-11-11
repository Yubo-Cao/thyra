// Drag a pane by its header onto another pane of the same tab. The drag
// starts after a small movement so plain clicks still focus and copy, and
// Escape or a cancelled pointer abandons it.
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type PaneDropTarget, paneDropTarget } from "../paneDrop";
import { store } from "../store";
import type { PaneLayout } from "../types";

const DRAG_THRESHOLD_PX = 5;
const PANE_HEADER = ".terminal-pane-head";
/** Header controls keep their own pointer behaviour. */
const HEADER_CONTROL = "button, a, input, textarea, select, [contenteditable]";

export type PaneDragState = {
  sourcePaneId: string;
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
      if (!enabled || event.button !== 0 || event.pointerType === "touch")
        return;
      const element = event.target;
      if (!(element instanceof Element)) return;
      const header = element.closest(PANE_HEADER);
      if (!header || element.closest(HEADER_CONTROL)) return;
      const sourcePaneId =
        header.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
      if (!sourcePaneId) return;
      endRef.current?.();

      const { pointerId, clientX: startX, clientY: startY } = event;
      const body = document.body.style;
      const previousCursor = body.cursor;
      const previousUserSelect = body.userSelect;
      let dragging = false;
      let target: PaneDropTarget | null = null;

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
        if (!dragging) {
          if (
            Math.hypot(e.clientX - startX, e.clientY - startY) <
            DRAG_THRESHOLD_PX
          )
            return;
          dragging = true;
          body.cursor = "grabbing";
          body.userSelect = "none";
        }
        e.preventDefault();
        const point = layoutPoint(e);
        target =
          point && layoutRef.current
            ? paneDropTarget(point, layoutRef.current.panes, sourcePaneId)
            : null;
        setDrag({ sourcePaneId, target });
      };
      const end = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", cancel, true);
        window.removeEventListener("keydown", key, true);
        window.removeEventListener("blur", end);
        if (dragging) {
          body.cursor = previousCursor;
          body.userSelect = previousUserSelect;
        }
        if (endRef.current === end) endRef.current = null;
        setDrag(null);
      };
      const cancel = (e: PointerEvent) => {
        if (e.pointerId === pointerId) end();
      };
      const up = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        const dropped = dragging ? target : null;
        const wasDragging = dragging;
        end();
        if (!wasDragging) return;
        suppressNextClick();
        const tabId = layoutRef.current?.tab_id;
        if (dropped && tabId)
          void store.rearrangePane(sourcePaneId, dropped, tabId);
      };
      const key = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        if (dragging) {
          e.preventDefault();
          e.stopPropagation();
        }
        end();
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", cancel, true);
      window.addEventListener("keydown", key, true);
      window.addEventListener("blur", end);
      endRef.current = end;
    },
    [enabled, containerRef],
  );

  return { drag, onPointerDown };
}
