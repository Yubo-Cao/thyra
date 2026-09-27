import { thyraLocalStorage } from "./browserStorage";
import { msg } from "./i18n";
import { groupPanesByTab } from "./paneIdentity";
import type { Pane, Tab, Workspace } from "./types";

// Multi-touch gestures on the terminal: two-finger pinch zooms its font, and a
// three- or four-finger horizontal swipe moves between panes. Recognition is
// pure here; the DOM wiring lives beside the terminal.

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
export type PaneSwipeFingers = 0 | 3 | 4;
const SWIPE_KEY = "paneSwipeFingers";
export const PANE_SWIPE_OPTIONS = [
  { value: "3", label: msg("Three fingers") },
  { value: "4", label: msg("Four fingers") },
  { value: "0", label: msg("Off") },
];

export function paneSwipeFingers(): PaneSwipeFingers {
  const stored = thyraLocalStorage.getItem(SWIPE_KEY);
  return stored === "0" ? 0 : stored === "4" ? 4 : 3;
}

export function setPaneSwipeFingers(fingers: PaneSwipeFingers) {
  thyraLocalStorage.setItem(SWIPE_KEY, String(fingers));
}

/** Horizontal travel a pane swipe needs, and how far it must outrun vertical. */
export const SWIPE_MIN_PX = 60;
export const SWIPE_DOMINANCE = 1.5;

/**
 * A swipe starts once exactly `fingers` touches are down and resolves when
 * the first of them lifts: +1 for left-to-right, -1 for right-to-left, or 0
 * when it was too short, too vertical, cancelled, or gained another finger.
 */
export class SwipeTracker {
  private start = new Map<number, { x: number; y: number }>();
  private last = new Map<number, { x: number; y: number }>();
  private state: "idle" | "tracking" | "done" = "idle";

  get tracking() {
    return this.state === "tracking";
  }

  touch(points: Points, fingers: number) {
    if (this.state === "done" || !fingers) return;
    if (points.length > fingers) {
      this.state = "done";
      return;
    }
    if (this.state === "idle" && points.length === fingers) {
      this.state = "tracking";
      for (const point of Array.from(points))
        this.start.set(point.identifier, {
          x: point.clientX,
          y: point.clientY,
        });
    }
    for (const point of Array.from(points))
      if (this.start.has(point.identifier))
        this.last.set(point.identifier, { x: point.clientX, y: point.clientY });
  }

  /** The swiping fingers' mean travel, while the swipe is live. */
  delta(): { dx: number; dy: number } | null {
    if (this.state !== "tracking") return null;
    let dx = 0;
    let dy = 0;
    for (const [id, from] of this.start) {
      const to = this.last.get(id) ?? from;
      dx += (to.x - from.x) / this.start.size;
      dy += (to.y - from.y) / this.start.size;
    }
    return { dx, dy };
  }

  /** A finger lifted; `remaining` touches are still down. */
  lift(remaining: number): -1 | 0 | 1 {
    let step: -1 | 0 | 1 = 0;
    const delta = this.delta();
    if (delta) {
      const { dx, dy } = delta;
      if (
        Math.abs(dx) >= SWIPE_MIN_PX &&
        Math.abs(dx) >= SWIPE_DOMINANCE * Math.abs(dy)
      )
        step = dx > 0 ? 1 : -1;
      this.state = "done";
    }
    if (remaining === 0) this.cancel();
    return step;
  }

  cancel() {
    this.start.clear();
    this.last.clear();
    this.state = "idle";
  }
}

/**
 * Every pane in navigation order: workspaces by number, then tabs by number,
 * then panes in their tab's order.
 */
export function paneNavigationOrder(
  workspaces: readonly Pick<Workspace, "workspace_id" | "number">[],
  tabs: readonly Pick<Tab, "tab_id" | "label" | "number" | "pane_count">[],
  panes: readonly Pane[],
): Pane[] {
  return [...workspaces]
    .sort((a, b) => a.number - b.number)
    .flatMap((workspace) =>
      groupPanesByTab(
        panes.filter((pane) => pane.workspace_id === workspace.workspace_id),
        tabs,
      ).flatMap((group) => group.panes),
    );
}

/** The pane `step` away from the current one, wrapping at either end. */
export function adjacentPane<T extends { pane_id: string }>(
  order: readonly T[],
  currentId: string | null | undefined,
  step: -1 | 1,
): T | null {
  const index = order.findIndex((pane) => pane.pane_id === currentId);
  if (order.length === 0 || (index >= 0 && order.length === 1)) return null;
  if (index < 0) return step > 0 ? order[0] : order[order.length - 1];
  return order[(index + step + order.length) % order.length];
}
