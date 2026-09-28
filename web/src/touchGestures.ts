import { thyraLocalStorage } from "./browserStorage";
import type { Terminal } from "@xterm/xterm";

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
    if (this.mode === "pending") {
      if (Math.abs(span - start.span) >= PINCH_SLOP_PX) this.mode = "pinch";
      else if (Math.hypot(dx, dy) >= PAN_SLOP_PX) this.mode = "pan";
    }
    const scale = this.mode === "pinch" ? span / start.span : 1;
    return { mode: this.mode, scale, dx, dy };
  }

  end() {
    this.start = null;
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
  open: Map<Terminal, { current: string | null }>;
  keep?(terminalId: string, term: Terminal): void;
} = { open: new Map() };
