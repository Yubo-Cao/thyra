import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  calculateOverlayThumb,
  createRefreshQueue,
  createWheelTargetCache,
  overlayScrollbarExcludedElement,
  type OverlayThumbGeometry,
} from "./overlayScrollbar";
import "./OverlayScrollbarLayer.css";

type Axis = "vertical" | "horizontal";

type ThumbLayout = OverlayThumbGeometry & {
  top: number;
  left: number;
  width: number;
  height: number;
};

type ScrollbarLayout = {
  vertical: ThumbLayout | null;
  horizontal: ThumbLayout | null;
};

type DragState = {
  axis: Axis;
  pointerId: number;
  pointerStart: number;
  scrollStart: number;
  maxScroll: number;
  travel: number;
  target: HTMLElement;
};

const THUMB_SIZE = 7;
const TRACK_INSET = 3;
const HIDE_DELAY_MS = 900;
const FADE_DURATION_MS = 160;

function hasScrollableOverflow(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  const canScrollY = /^(auto|scroll|overlay)$/.test(style.overflowY);
  const canScrollX = /^(auto|scroll|overlay)$/.test(style.overflowX);
  return (
    (canScrollY && element.scrollHeight > element.clientHeight + 1) ||
    (canScrollX && element.scrollWidth > element.clientWidth + 1)
  );
}

function findScrollableElement(target: EventTarget | null) {
  let element = target instanceof HTMLElement ? target : null;
  if (element && overlayScrollbarExcludedElement(element)) return null;
  while (element && element !== document.documentElement) {
    if (hasScrollableOverflow(element)) return element;
    element = element.parentElement;
  }
  return null;
}

function measureScrollbars(
  target: HTMLElement,
  /** The fixed, viewport-sized layer's box; it moves only when resized. */
  layerRect: DOMRect,
): ScrollbarLayout | null {
  if (!target.isConnected) return null;
  const rect = target.getBoundingClientRect();
  if (!layerRect.width || !layerRect.height) return null;
  const top = Math.max(layerRect.top, rect.top);
  const right = Math.min(layerRect.right, rect.right);
  const bottom = Math.min(layerRect.bottom, rect.bottom);
  const left = Math.max(layerRect.left, rect.left);
  const visibleWidth = Math.max(0, right - left);
  const visibleHeight = Math.max(0, bottom - top);

  const verticalGeometry = calculateOverlayThumb({
    viewportStart: top,
    viewportSize: visibleHeight,
    clientSize: target.clientHeight,
    scrollSize: target.scrollHeight,
    scrollOffset: target.scrollTop,
    inset: TRACK_INSET,
  });
  const horizontalGeometry = calculateOverlayThumb({
    viewportStart: left,
    viewportSize: visibleWidth,
    clientSize: target.clientWidth,
    scrollSize: target.scrollWidth,
    scrollOffset: target.scrollLeft,
    inset: TRACK_INSET,
  });

  const vertical = verticalGeometry
    ? {
        ...verticalGeometry,
        top: verticalGeometry.start - layerRect.top,
        left: right - TRACK_INSET - THUMB_SIZE - layerRect.left,
        width: THUMB_SIZE,
        height: verticalGeometry.size,
      }
    : null;
  const horizontal = horizontalGeometry
    ? {
        ...horizontalGeometry,
        top: bottom - TRACK_INSET - THUMB_SIZE - layerRect.top,
        left: horizontalGeometry.start - layerRect.left,
        width: horizontalGeometry.size,
        height: THUMB_SIZE,
      }
    : null;

  return vertical || horizontal ? { vertical, horizontal } : null;
}

function sameThumb(a: ThumbLayout | null, b: ThumbLayout | null) {
  if (!a || !b) return a === b;
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height &&
    a.trackLength === b.trackLength &&
    a.maxScroll === b.maxScroll
  );
}

function sameLayout(a: ScrollbarLayout | null, b: ScrollbarLayout | null) {
  return (
    a === b ||
    (!!a &&
      !!b &&
      sameThumb(a.vertical, b.vertical) &&
      sameThumb(a.horizontal, b.horizontal))
  );
}

export function OverlayScrollbarLayer() {
  const [layout, setLayout] = useState<ScrollbarLayout | null>(null);
  const [visible, setVisible] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const refreshRef = useRef<(target: HTMLElement) => void>(() => undefined);
  const hideTimerRef = useRef<number | null>(null);
  const clearTimerRef = useRef<number | null>(null);

  const clearHideTimers = useCallback(() => {
    if (hideTimerRef.current !== null)
      window.clearTimeout(hideTimerRef.current);
    if (clearTimerRef.current !== null)
      window.clearTimeout(clearTimerRef.current);
    hideTimerRef.current = null;
    clearTimerRef.current = null;
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimers();
    hideTimerRef.current = window.setTimeout(() => {
      if (dragRef.current) return;
      targetRef.current = null;
      setVisible(false);
      clearTimerRef.current = window.setTimeout(() => {
        if (!dragRef.current) setLayout(null);
      }, FADE_DURATION_MS);
    }, HIDE_DELAY_MS);
  }, [clearHideTimers]);

  useEffect(() => {
    let frame = 0;
    // "direct" names the element to measure; a scroll or wheel event names
    // where it happened, and the frame works out what scrolls there.
    const queue = createRefreshQueue<
      "direct" | "scroll" | "wheel",
      EventTarget | null
    >();
    // A wheel gesture resolves its scroll container once, not per event.
    const wheelTargets = createWheelTargetCache<EventTarget, HTMLElement>(
      findScrollableElement,
    );
    let layerRect: DOMRect | null = null;
    const forgetMeasurements = () => {
      layerRect = null;
      wheelTargets.clear();
    };

    // Style and layout reads for scroll, wheel and drag updates happen here,
    // at most once per frame.
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const nextTarget = queue.take((kind, target) =>
          kind === "wheel"
            ? target && wheelTargets.get(target)
            : target instanceof HTMLElement &&
                (kind === "direct" || hasScrollableOverflow(target))
              ? target
              : null,
        );
        const layer = layerRef.current;
        if (!nextTarget || !layer) return;
        layerRect ??= layer.getBoundingClientRect();
        const nextLayout = measureScrollbars(nextTarget, layerRect);
        targetRef.current = nextTarget;
        setLayout((current) =>
          sameLayout(current, nextLayout) ? current : nextLayout,
        );
        setVisible(Boolean(nextLayout));
        if (nextLayout) scheduleHide();
      });
    };
    const refresh = (target: HTMLElement) => {
      queue.add("direct", target);
      schedule();
    };
    refreshRef.current = refresh;

    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (overlayScrollbarExcludedElement(target)) {
        if (
          targetRef.current &&
          overlayScrollbarExcludedElement(targetRef.current)
        ) {
          targetRef.current = null;
          setVisible(false);
          setLayout(null);
        }
        return;
      }
      queue.add("scroll", target);
      schedule();
    };
    const onWheel = (event: WheelEvent) => {
      queue.add("wheel", event.target);
      schedule();
    };
    const onResize = () => {
      forgetMeasurements();
      if (targetRef.current) refresh(targetRef.current);
    };
    const layerObserver = new ResizeObserver(forgetMeasurements);
    if (layerRef.current) layerObserver.observe(layerRef.current);

    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("wheel", onWheel, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", onResize);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      layerObserver.disconnect();
      clearHideTimers();
      refreshRef.current = () => undefined;
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("resize", onResize);
    };
  }, [clearHideTimers, scheduleHide]);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, axis: Axis) => {
    const target = targetRef.current;
    const thumb = axis === "vertical" ? layout?.vertical : layout?.horizontal;
    if (!target || !thumb) return;
    event.preventDefault();
    event.stopPropagation();
    clearHideTimers();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      axis,
      pointerId: event.pointerId,
      pointerStart: axis === "vertical" ? event.clientY : event.clientX,
      scrollStart: axis === "vertical" ? target.scrollTop : target.scrollLeft,
      maxScroll: thumb.maxScroll,
      travel: Math.max(1, thumb.trackLength - thumb.size),
      target,
    };
    setVisible(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const pointer = drag.axis === "vertical" ? event.clientY : event.clientX;
    const nextScroll =
      drag.scrollStart +
      ((pointer - drag.pointerStart) / drag.travel) * drag.maxScroll;
    if (drag.axis === "vertical") drag.target.scrollTop = nextScroll;
    else drag.target.scrollLeft = nextScroll;
    refreshRef.current(drag.target);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!event.currentTarget.matches(":hover")) scheduleHide();
  };

  const thumbStyle = (thumb: ThumbLayout): CSSProperties => ({
    top: thumb.top,
    left: thumb.left,
    width: thumb.width,
    height: thumb.height,
  });

  return (
    <div
      ref={layerRef}
      className={`overlay-scrollbar-layer ${visible ? "is-visible" : ""}`}
    >
      {layout?.vertical ? (
        <div
          className="overlay-scrollbar-thumb is-vertical"
          data-testid="overlay-scrollbar-vertical"
          style={thumbStyle(layout.vertical)}
          aria-hidden="true"
          onPointerEnter={clearHideTimers}
          onPointerLeave={scheduleHide}
          onPointerDown={(event) => beginDrag(event, "vertical")}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      ) : null}
      {layout?.horizontal ? (
        <div
          className="overlay-scrollbar-thumb is-horizontal"
          data-testid="overlay-scrollbar-horizontal"
          style={thumbStyle(layout.horizontal)}
          aria-hidden="true"
          onPointerEnter={clearHideTimers}
          onPointerLeave={scheduleHide}
          onPointerDown={(event) => beginDrag(event, "horizontal")}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      ) : null}
    </div>
  );
}
