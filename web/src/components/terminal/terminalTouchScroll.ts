import {
  PinchTracker,
  type PinchMove,
  TouchVelocity,
} from "../../touchGestures";

// Touch scrolling for the terminal, free of the DOM: one finger's travel, or
// two fingers' midpoint once they pan, drives the same line scroll, and a
// release at speed keeps it going with momentum.

type Point = { x: number; y: number };
type Points = ArrayLike<{
  identifier: number;
  clientX: number;
  clientY: number;
}>;

/** Finger travel that scrolls one line. */
export const TOUCH_SCROLL_LINE_PX = 24;
/** Release speed, in px/ms, a fling needs; slower releases stop dead. */
export const FLING_MIN_SPEED = 0.3;
/** Share of a fling's speed kept per ms. */
export const FLING_FRICTION = 0.997;
/** Speed, in px/ms, at which a fling stops. */
const FLING_STOP_SPEED = 0.02;
/** Longest frame a fling integrates at once, so a stall does not lurch. */
const FLING_MAX_FRAME_MS = 50;

export type Frames = {
  request(callback: (time: number) => void): number;
  cancel(id: number): void;
};

const animationFrames: Frames = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};

/** Where a touch is: one finger, or the midpoint of the first two. */
export function touchPoint(points: Points): Point {
  const a = points[0];
  const b = points.length > 1 ? points[1] : a;
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

/**
 * Turns a tracked vertical position into whole-line scrolls: `scroll(lines,
 * at)` gets a positive count to scroll down (the fingers moved up) and the
 * point to report them at. A release faster than `FLING_MIN_SPEED` keeps
 * scrolling on animation frames, slowing by `FLING_FRICTION`, until it
 * stops, a new touch begins, or `stop()`.
 */
export class TouchScroll {
  private last: number | null = null;
  private remainder = 0;
  private velocity = new TouchVelocity();
  private at: Point = { x: 0, y: 0 };
  private fling = 0;

  constructor(
    private readonly scroll: (lines: number, at: Point) => void,
    private readonly frames: Frames = animationFrames,
  ) {}

  /** A touch is driving the scroll. */
  get tracking() {
    return this.last !== null;
  }

  /** A released touch is still scrolling. */
  get flinging() {
    return this.fling !== 0;
  }

  begin(y: number, at: Point, time: number) {
    this.stop();
    this.last = y;
    this.at = at;
    this.velocity = new TouchVelocity();
    this.velocity.add(time, y);
  }

  move(y: number, at: Point, time: number) {
    if (this.last === null) return;
    this.at = at;
    this.velocity.add(time, y);
    this.travel(this.last - y);
    this.last = y;
  }

  /** The touch lifted: fling at its speed, or stop. */
  release(time: number) {
    if (this.last === null) return;
    this.last = null;
    let speed = -this.velocity.at(time);
    if (Math.abs(speed) < FLING_MIN_SPEED) {
      this.remainder = 0;
      return;
    }
    let previous = time;
    const step = (now: number) => {
      const elapsed = Math.min(FLING_MAX_FRAME_MS, Math.max(0, now - previous));
      previous = now;
      this.travel(speed * elapsed);
      speed *= FLING_FRICTION ** elapsed;
      if (Math.abs(speed) < FLING_STOP_SPEED) {
        this.fling = 0;
        this.remainder = 0;
      } else this.fling = this.frames.request(step);
    };
    this.fling = this.frames.request(step);
  }

  stop() {
    if (this.fling) this.frames.cancel(this.fling);
    this.fling = 0;
    this.last = null;
    this.remainder = 0;
  }

  private travel(px: number) {
    this.remainder += px;
    const lines = Math.trunc(this.remainder / TOUCH_SCROLL_LINE_PX);
    if (!lines) return;
    this.remainder -= lines * TOUCH_SCROLL_LINE_PX;
    this.scroll(lines, this.at);
  }
}

/**
 * Two fingers on the terminal: a pinch, or a pan that scrolls through the
 * same `TouchScroll` as one finger, tracking the fingers' midpoint. The mode
 * locks once decided (by the same rule as the pane swipe, which claims a
 * horizontal pan before it gets here), so a gesture never both pinches and
 * scrolls.
 */
export class TwoFingerTouch {
  private readonly pinch = new PinchTracker();
  private startY = 0;

  constructor(private readonly scroll: TouchScroll) {}

  get active() {
    return this.pinch.active;
  }

  get mode() {
    return this.pinch.mode;
  }

  begin(points: Points, time: number) {
    this.pinch.begin(points);
    const at = touchPoint(points);
    this.startY = at.y;
    this.scroll.begin(at.y, at, time);
  }

  /**
   * Classifies a move and hands a decided one to `view`, which applies it
   * (a pinch preview, or a magnified view's pan) and returns how far the
   * view itself moved down. A pan scrolls by the rest of the midpoint's
   * vertical travel: a magnified view pans to its edge, then scrolls.
   */
  move(
    points: Points,
    time: number,
    view: (move: PinchMove) => number = () => 0,
  ): PinchMove | null {
    const move = this.pinch.move(points);
    if (!move || move.mode === "pending") return move;
    const moved = view(move);
    if (move.mode === "pan")
      this.scroll.move(this.startY + move.dy - moved, touchPoint(points), time);
    return move;
  }

  /** A finger lifted (`lifted`), or the touch was taken away. */
  end(lifted: boolean, time: number) {
    const panned = this.pinch.mode === "pan";
    this.pinch.end();
    if (lifted && panned) this.scroll.release(time);
    else this.scroll.stop();
  }
}
