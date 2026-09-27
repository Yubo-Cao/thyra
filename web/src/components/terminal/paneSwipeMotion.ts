import { SWIPE_DOMINANCE } from "../../touchGestures";

// The decisions behind an interactive pane swipe, free of the DOM: when the
// fingers start dragging the pane, how far it follows them, whether a release
// commits, and which switch a chain of quick swipes finally makes.

/** Finger travel before a swipe drags the pane (or is ruled vertical). */
export const SWIPE_TRACK_PX = 16;
/** Share of the width past which a release commits. */
export const SWIPE_COMMIT_FRACTION = 0.3;
/** Finger speed, in px/ms, that commits a shorter swipe. */
export const SWIPE_FLICK_SPEED = 0.4;
/** Share of the width the pane follows 1:1 before it resists. */
export const SWIPE_FREE_FRACTION = 0.4;
/** How far, as a share of the width, resistance lets it go past that. */
const RESIST_FRACTION = 0.35;
/** Samples older than this, in ms, no longer count toward the speed. */
const VELOCITY_WINDOW_MS = 100;

/** Whether travel so far starts a drag, needs more, or is too vertical. */
export function swipeRecognition(
  dx: number,
  dy: number,
): "pending" | "track" | "reject" {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_TRACK_PX) return "pending";
  return Math.abs(dx) >= SWIPE_DOMINANCE * Math.abs(dy) ? "track" : "reject";
}

/**
 * The pane's offset for a finger travel: 1:1 up to `free` of the width, then
 * a rubber band that approaches `RESIST_FRACTION` more. With nothing to swipe
 * to, `free` is 0 and the band starts at once.
 */
export function rubberBand(
  dx: number,
  width: number,
  free = SWIPE_FREE_FRACTION,
): number {
  const limit = width * free;
  const travel = Math.abs(dx);
  if (travel <= limit) return dx;
  const room = width * RESIST_FRACTION;
  const over = travel - limit;
  return Math.sign(dx) * (limit + room * (1 - 1 / ((over * 0.55) / room + 1)));
}

/** Finger speed over the last `VELOCITY_WINDOW_MS`. */
export class SwipeVelocity {
  private samples: { time: number; x: number }[] = [];

  add(time: number, x: number) {
    this.samples.push({ time, x });
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
    return elapsed > 0 ? (last.x - first.x) / elapsed : 0;
  }
}

/**
 * What a release does: +1 or -1 commits toward the fingers' direction, 0
 * springs back. It commits past `SWIPE_COMMIT_FRACTION` of the width or on a
 * flick in that direction, unless the release turned vertical or flicks back.
 */
export function swipeRelease(
  dx: number,
  dy: number,
  width: number,
  velocity: number,
): -1 | 0 | 1 {
  if (!dx || width <= 0 || Math.abs(dx) < SWIPE_DOMINANCE * Math.abs(dy))
    return 0;
  const direction = dx > 0 ? 1 : -1;
  const speed = velocity * direction;
  if (speed <= -SWIPE_FLICK_SPEED) return 0;
  return Math.abs(dx) > SWIPE_COMMIT_FRACTION * width ||
    speed >= SWIPE_FLICK_SPEED
    ? direction
    : 0;
}

/**
 * A committed swipe switches panes only after its animation settles and every
 * finger is up, so a quick second swipe starts from the first one's
 * destination and only the last destination is switched to. The destination
 * card stays over the pane until the switch is on screen.
 */
export class SwipeChain {
  /** Committed, switch not yet requested. */
  private pending: string | null = null;
  /** Switch requested, not yet on screen. */
  private switching: string | null = null;
  animating = false;
  touching = false;

  /** The pane the next swipe starts from. */
  from(active: string | null | undefined): string | null {
    return this.pending ?? this.switching ?? active ?? null;
  }

  commit(paneId: string) {
    this.pending = paneId;
  }

  /** The switch to request now, if one is due. */
  due(): string | null {
    if (!this.pending || this.animating || this.touching) return null;
    this.switching = this.pending;
    this.pending = null;
    return this.switching;
  }

  /** Whether the destination card may give way to the live pane. */
  revealable(active: string | null | undefined): boolean {
    return (
      !this.pending &&
      !this.animating &&
      !this.touching &&
      (this.switching === null || this.switching === active)
    );
  }

  /** The switch is on screen, or gave up waiting. */
  revealed() {
    this.switching = null;
  }
}
