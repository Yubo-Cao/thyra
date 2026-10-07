import { thyraLocalStorage } from "./browserStorage";
import type { TerminalEngine } from "./terminalEngine";

// Multi-touch gestures on the terminal: two-finger pinch zooms its font, and a
// two-, three- or four-finger horizontal swipe moves between panes (see
// components/terminal/paneSwipeMotion.ts). Recognition is pure here; the DOM
// wiring lives beside the terminal.

type Point = { identifier: number; clientX: number; clientY: number };
type Points = ArrayLike<Point>;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Finger-distance change that makes two fingers a pinch, not a pan. */
export const PINCH_SLOP_PX = 16;
/** Midpoint travel that makes two fingers a pan, not a pinch. */
export const PAN_SLOP_PX = 16;

export type PinchMove = {
  mode: "pending" | "pinch" | "pan";
  /** Finger distance relative to the start; 1 unless pinching. */
  scale: number;
  /** Midpoint travel since the start. */
  dx: number;
  dy: number;
};

/**
 * What two fingers are doing once they move: a pinch (their distance changed
 * by `spread`), a pan (their midpoint travelled `dx`, `dy`), whichever
 * crosses its slop first. The terminal's pinch tracker and the pane swipe
 * both classify two fingers by this, so they agree on every touch.
 */
export function twoFingerMode(
  spread: number,
  dx: number,
  dy: number,
): PinchMove["mode"] {
  if (Math.abs(spread) >= PINCH_SLOP_PX) return "pinch";
  if (Math.hypot(dx, dy) >= PAN_SLOP_PX) return "pan";
  return "pending";
}

/** Tells a pinch from a two-finger pan by whichever crosses its slop first. */
export class PinchTracker {
  private start: { span: number; x: number; y: number } | null = null;
  mode: PinchMove["mode"] = "pending";

  get active() {
    return this.start !== null;
  }

  begin(points: Points) {
    const [a, b] = [points[0], points[1]];
    this.start = {
      span: Math.max(
        1,
        Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      ),
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2,
    };
    this.mode = "pending";
  }

  move(points: Points): PinchMove | null {
    const start = this.start;
    if (!start) return null;
    const [a, b] = [points[0], points[1]];
    const span = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const dx = (a.clientX + b.clientX) / 2 - start.x;
    const dy = (a.clientY + b.clientY) / 2 - start.y;
    if (this.mode === "pending")
      this.mode = twoFingerMode(span - start.span, dx, dy);
    const scale = this.mode === "pinch" ? span / start.span : 1;
    return { mode: this.mode, scale, dx, dy };
  }

  end() {
    this.start = null;
  }
}

/** Samples older than this, in ms, no longer count toward the speed. */
const VELOCITY_WINDOW_MS = 100;

/** A finger coordinate's speed over the last `VELOCITY_WINDOW_MS`. */
export class TouchVelocity {
  private samples: { time: number; value: number }[] = [];

  add(time: number, value: number) {
    this.samples.push({ time, value });
    while (
      this.samples.length > 2 &&
      time - this.samples[0].time > VELOCITY_WINDOW_MS
    )
      this.samples.shift();
  }

  /** px/ms at `now`; a finger that has rested reads as still. */
  at(now: number): number {
    const recent = this.samples.filter(
      (sample) => now - sample.time <= VELOCITY_WINDOW_MS,
    );
    if (recent.length < 2) return 0;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const elapsed = last.time - first.time;
    return elapsed > 0 ? (last.value - first.value) / elapsed : 0;
  }
}

// Font sizes land on half pixels: the renderer caches cell metrics per size.
export const TERMINAL_FONT_MIN_PX = 8;
export const TERMINAL_FONT_MAX_PX = 32;

/** The font size for a zoom; the default zoom leaves the base untouched. */
export function zoomedTerminalFontSize(base: number, zoom: number): number {
  if (zoom === 1) return base;
  return clamp(
    Math.round(base * zoom * 2) / 2,
    TERMINAL_FONT_MIN_PX,
    TERMINAL_FONT_MAX_PX,
  );
}

/** Limits a live pinch scale to the font sizes a commit can reach. */
export function clampPinchScale(base: number, zoom: number, scale: number) {
  const size = base * zoom;
  return clamp(size * scale, TERMINAL_FONT_MIN_PX, TERMINAL_FONT_MAX_PX) / size;
}

/** The zoom a finished pinch commits; within half a pixel of base resets it. */
export function pinchedTerminalZoom(
  base: number,
  zoom: number,
  scale: number,
): number {
  const size = zoomedTerminalFontSize(base, zoom * scale || 1);
  return Math.abs(size - base) < 0.5 ? 1 : size / base;
}

const ZOOM_KEY = "terminalZoom";
export const TERMINAL_ZOOM_EVENT = "thyra:terminal-zoom";
let zoomCache: number | undefined;

/** This browser's terminal zoom (1 is the default size). */
export function terminalZoom(): number {
  if (zoomCache === undefined) {
    const stored = Number(thyraLocalStorage.getItem(ZOOM_KEY));
    zoomCache = stored >= 0.25 && stored <= 4 ? stored : 1;
  }
  return zoomCache;
}

export function setTerminalZoom(zoom: number) {
  zoomCache = zoom;
  if (zoom === 1) thyraLocalStorage.removeItem(ZOOM_KEY);
  else thyraLocalStorage.setItem(ZOOM_KEY, String(zoom));
  window.dispatchEvent(new Event(TERMINAL_ZOOM_EVENT));
}

/** Fingers a pane swipe takes; 0 turns it off. */
export type PaneSwipeFingers = 0 | 2 | 3 | 4;
export const PANE_SWIPE_KEY = "paneSwipeFingers";

export function paneSwipeFingers(): PaneSwipeFingers {
  const stored = thyraLocalStorage.getItem(PANE_SWIPE_KEY);
  return stored === "0" || stored === "3" || stored === "4"
    ? (Number(stored) as PaneSwipeFingers)
    : 2;
}

/**
 * Every open terminal with the terminal ID it shows, and, once the pane swipe
 * has loaded, the hook that keeps a terminal's screen as it leaves the view:
 * the swipe previews a neighbouring pane from these.
 */
export const terminalScreens: {
  open: Map<TerminalEngine, { current: string | null }>;
  keep?(terminalId: string, term: TerminalEngine): void;
} = { open: new Map() };
