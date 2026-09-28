import {
  clampPinchScale,
  pinchedTerminalZoom,
  setTerminalZoom,
  TERMINAL_ZOOM_EVENT,
  terminalZoom,
} from "../../touchGestures";
import {
  applyTerminalFollowScale,
  terminalDensity,
  type TerminalSession,
} from "./terminalSession";
import { type TouchScroll, TwoFingerTouch } from "./terminalTouchScroll";

const ZOOM_BADGE_MS = 2500;

/**
 * Two-finger pinch zooms this browser's terminal font. A transform previews
 * the gesture and the font changes once, on release: a device that sizes the
 * pane then refits it and resizes the PTY; one that follows another device's
 * size only magnifies its scaled view, which two fingers also pan. A pan
 * scrolls the terminal as one finger does, once a magnified view has reached
 * its top or bottom edge.
 */
export function installTerminalPinch(
  session: TerminalSession,
  scroll: TouchScroll,
) {
  const { container, term, refs, ui, signal } = session;
  const pinch = new TwoFingerTouch(scroll);
  const pan = refs.followPan;
  let start = { zoom: 1, base: 13, x: 0, y: 0, pan: { ...pan.current } };
  let scale = 1;
  let badgeTimer = 0;
  const showZoom = (zoom: number, hide: boolean) => {
    window.clearTimeout(badgeTimer);
    ui.setZoomBadge(Math.round(zoom * 100));
    if (hide)
      badgeTimer = window.setTimeout(
        () => ui.setZoomBadge(null),
        ZOOM_BADGE_MS,
      );
  };
  const follow = () =>
    applyTerminalFollowScale(term, container, true, pan.current);

  const finish = (commit: boolean) => {
    const pinched = pinch.mode === "pinch";
    pinch.end(commit, performance.now());
    term.element?.style.removeProperty("transform");
    term.element?.style.removeProperty("transform-origin");
    if (!commit) pan.current = start.pan;
    const zoom =
      commit && pinched
        ? pinchedTerminalZoom(start.base, start.zoom, scale)
        : terminalZoom();
    if (pinched) showZoom(zoom, true);
    if (zoom !== terminalZoom()) setTerminalZoom(zoom);
    else if (refs.followShared.current) follow();
  };
  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 2) {
      if (pinch.active) finish(false);
      // More fingers stop a fling; one finger restarts it (terminalGestures).
      else if (e.touches.length > 2) scroll.stop();
      return;
    }
    const [a, b] = [e.touches[0], e.touches[1]];
    const rect = container.getBoundingClientRect();
    if (refs.followShared.current) follow();
    start = {
      zoom: terminalZoom(),
      base: terminalDensity(refs.uiScale.current, 1).fontSize,
      x: (a.clientX + b.clientX) / 2 - rect.left,
      y: (a.clientY + b.clientY) / 2 - rect.top,
      pan: { ...pan.current },
    };
    scale = 1;
    pinch.begin(e.touches, performance.now());
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!pinch.active || e.touches.length !== 2) return;
    e.preventDefault();
    pinch.move(e.touches, performance.now(), (move) => {
      scale = clampPinchScale(start.base, start.zoom, move.scale);
      if (move.mode === "pinch")
        showZoom(pinchedTerminalZoom(start.base, start.zoom, scale), false);
      if (refs.followShared.current) {
        // Keep the content under the starting midpoint beneath the fingers;
        // the view stops at its edges, and a pan scrolls on from there.
        pan.current = {
          x: start.x + move.dx - (start.x - start.pan.x) * scale,
          y: start.y + move.dy - (start.y - start.pan.y) * scale,
        };
        applyTerminalFollowScale(term, container, true, pan.current, scale);
        return pan.current.y - start.pan.y;
      }
      if (move.mode === "pinch" && term.element) {
        term.element.style.transformOrigin = `${start.x}px ${start.y}px`;
        term.element.style.transform = `scale(${scale})`;
      }
      return 0;
    });
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (pinch.active && e.touches.length < 2) finish(true);
  };
  const onTouchCancel = () => {
    if (pinch.active) finish(false);
  };
  const options = { capture: true, passive: false, signal };
  container.addEventListener("touchstart", onTouchStart, options);
  container.addEventListener("touchmove", onTouchMove, options);
  container.addEventListener("touchend", onTouchEnd, options);
  container.addEventListener("touchcancel", onTouchCancel, options);
  // WebKit's own pinch would zoom the page; touch devices pinch the terminal.
  if (window.matchMedia("(any-pointer: coarse)").matches)
    for (const type of ["gesturestart", "gesturechange", "gestureend"])
      container.addEventListener(type, (e) => e.preventDefault(), options);

  // A committed zoom refits every terminal once; only a device that sizes
  // its pane sends the new grid (a follower's fit returns no size).
  const onZoom = () => {
    term.options = terminalDensity(refs.uiScale.current);
    const size = session.fitVisibleTerminal();
    if (size) refs.resizeSync.current?.sendNow(size);
    else if (refs.followShared.current)
      requestAnimationFrame(() => {
        if (!session.disposed) session.fitVisibleTerminal();
      });
  };
  window.addEventListener(TERMINAL_ZOOM_EVENT, onZoom, { signal });
  return () => window.clearTimeout(badgeTimer);
}
