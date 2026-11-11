// When a press on a pane header becomes a pane drag. A mouse or pen drags
// once it moves a few pixels; a finger first has to hold still for a long
// press, so taps still focus and a quick swipe stays a swipe.

type Point = { x: number; y: number };

/** Mouse and pen travel that starts a drag. */
export const PANE_DRAG_SLOP_PX = 5;
/** How long a finger holds the header before it can drag the pane. */
export const PANE_DRAG_LONG_PRESS_MS = 350;
/** Finger travel before the long press that makes the touch a swipe instead. */
export const PANE_DRAG_TOUCH_SLOP_PX = 8;

/**
 * `pending`: pressed, not a drag yet. `armed`: a long press fired and the
 * finger may now drag. `dragging`: the pane follows the pointer.
 * `abandoned`: the press is not a drag and never becomes one.
 */
export type PaneDragPhase = "pending" | "armed" | "dragging" | "abandoned";

export class PaneDragGesture {
  phase: PaneDragPhase = "pending";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly start: Point,
    readonly touch: boolean,
    onArm: () => void = () => {},
  ) {
    if (!touch) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.phase !== "pending") return;
      this.phase = "armed";
      onArm();
    }, PANE_DRAG_LONG_PRESS_MS);
  }

  /** The phase after the pointer moved to `point`. */
  move(point: Point): PaneDragPhase {
    if (this.phase === "armed") this.phase = "dragging";
    else if (this.phase === "pending") {
      const distance = Math.hypot(
        point.x - this.start.x,
        point.y - this.start.y,
      );
      if (this.touch) {
        if (distance > PANE_DRAG_TOUCH_SLOP_PX) this.abandon();
      } else if (distance >= PANE_DRAG_SLOP_PX) this.phase = "dragging";
    }
    return this.phase;
  }

  /** Whether the press now owns the pointer (the pane is held or moving). */
  get holding() {
    return this.phase === "armed" || this.phase === "dragging";
  }

  abandon() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.phase = "abandoned";
  }
}

let held = false;

/**
 * Whether a pane drag owns the current touch. Other touch gestures on the
 * pane area (the multi-finger pane swipe) stand aside while it does.
 */
export function paneDragHeld() {
  return held;
}

export function setPaneDragHeld(value: boolean) {
  held = value;
}
