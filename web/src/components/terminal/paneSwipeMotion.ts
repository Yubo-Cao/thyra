import { groupPanesByTab } from "../../paneIdentity";
import { PAN_SLOP_PX, twoFingerMode } from "../../touchGestures";
import type { Pane, Tab, Workspace } from "../../types";

// The decisions behind an interactive pane swipe, free of the DOM: what a
// multi-finger touch is, which pane a drag reveals, how far the content
// follows the fingers, whether a release commits, and which switch a chain of
// quick swipes finally makes.

type Point = { identifier: number; clientX: number; clientY: number };
type Points = ArrayLike<Point>;

/** Finger travel before a touch is classified (the pinch tracker's pan slop). */
export const SWIPE_SLOP_PX = PAN_SLOP_PX;
/** How far horizontal travel must outrun vertical for two fingers... */
export const TWO_FINGER_DOMINANCE = 2;
/** ...and for three or four, which nothing else claims. */
export const SWIPE_DOMINANCE = 1.5;
/** Finger-distance change a two-finger swipe tolerates when it is classified. */
export const SWIPE_SPREAD_PX = 10;

/**
 * What a touch of `fingers` fingers is, once it has moved: a pinch (their
 * distance changed), a pan (vertical scroll, a zoomed view's pan, or a
 * wavering drag), or a pane swipe (horizontal, near-constant distance, and
 * no view to pan that way first). `room` is how far a zoomed view can still
 * pan in the fingers' direction: +1 is toward the right. Two fingers resolve
 * exactly as the terminal's pinch tracker does, except that a swipe takes
 * over what it would call a pan.
 */
export function classifySwipe(
  fingers: number,
  dx: number,
  dy: number,
  spread: number,
  room: (direction: -1 | 1) => number,
): "pending" | "pinch" | "pan" | "swipe" {
  const two = fingers === 2;
  if (two) {
    const mode = twoFingerMode(spread, dx, dy);
    if (mode !== "pan") return mode;
  } else if (Math.hypot(dx, dy) < SWIPE_SLOP_PX) return "pending";
  if (
    Math.abs(dx) <
    (two ? TWO_FINGER_DOMINANCE : SWIPE_DOMINANCE) * Math.abs(dy)
  )
    return "pan";
  if (two && (Math.abs(spread) > SWIPE_SPREAD_PX || room(dx > 0 ? 1 : -1) >= 1))
    return "pan";
  return "swipe";
}

/**
 * Follows the fingers of one multi-finger touch from the moment exactly
 * `fingers` are down, and locks its classification once it is decided.
 * Another finger landing or one lifting ends it.
 */
export class SwipeTracker {
  private start = new Map<number, { x: number; y: number }>();
  private last = new Map<number, { x: number; y: number }>();
  private span = 0;
  mode: ReturnType<typeof classifySwipe> | "idle" | "done" = "idle";

  begin(points: Points) {
    this.cancel();
    for (const point of Array.from(points))
      this.start.set(point.identifier, { x: point.clientX, y: point.clientY });
    this.last = new Map(this.start);
    this.span = this.spread();
    this.mode = "pending";
  }

  /** Records a move; returns the classification, locked once decided. */
  move(
    points: Points,
    room: (direction: -1 | 1) => number = () => 0,
  ): SwipeTracker["mode"] {
    if (this.mode === "idle" || this.mode === "done") return this.mode;
    for (const point of Array.from(points))
      if (this.start.has(point.identifier))
        this.last.set(point.identifier, { x: point.clientX, y: point.clientY });
    if (this.mode === "pending") {
      const { dx, dy } = this.delta();
      this.mode = classifySwipe(
        this.start.size,
        dx,
        dy,
        this.spread() - this.span,
        room,
      );
    }
    return this.mode;
  }

  /** The fingers' mean travel since they came down. */
  delta(): { dx: number; dy: number } {
    let dx = 0;
    let dy = 0;
    for (const [id, from] of this.start) {
      const to = this.last.get(id) ?? from;
      dx += (to.x - from.x) / this.start.size;
      dy += (to.y - from.y) / this.start.size;
    }
    return { dx, dy };
  }

  /** The distance between the first two fingers (0 for one). */
  private spread(): number {
    const [a, b] = Array.from(this.last.values());
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  /** The touch ended as a swipe candidate; ignore it until the next begins. */
  finish() {
    if (this.mode !== "idle") this.mode = "done";
  }

  cancel() {
    this.start.clear();
    this.last.clear();
    this.mode = "idle";
  }
}

/**
 * Panes sit side by side in navigation order: dragging the content right
 * (`direction` +1) reveals the previous pane on the left, dragging it left
 * the next one on the right. `reversed` restores "left to right is next".
 */
export function swipeStep(direction: -1 | 1, reversed = false): -1 | 1 {
  return (reversed ? direction : -direction) as -1 | 1;
}

/** The screen edge a drag uncovers, where the destination's icon sits. */
export function revealedEdge(direction: -1 | 1): "left" | "right" {
  return direction > 0 ? "left" : "right";
}

/** Share of the width that must be revealed for a release to switch. */
export const SWIPE_COMMIT_FRACTION = 0.5;
/** A flick at least this fast, in px/ms, toward the reveal... */
export const SWIPE_FLICK_SPEED = 0.8;
/** ...switches once this share of the width is revealed. */
export const SWIPE_FLICK_FRACTION = 0.25;

/**
 * Whether a release now switches panes, given the share of the width revealed
 * and the fingers' speed toward revealing more (px/ms). The destination's
 * icon arms by this same rule on every frame, so it shows what a release
 * does.
 */
export function swipeCommits(revealed: number, speed: number): boolean {
  return (
    revealed > SWIPE_COMMIT_FRACTION ||
    (speed >= SWIPE_FLICK_SPEED && revealed >= SWIPE_FLICK_FRACTION)
  );
}

/**
 * The content's offset for a finger travel: 1:1 while there is a pane to
 * reveal, up to the full width; with nothing there, a rubber band that
 * approaches `RESIST_FRACTION` of it.
 */
export function swipeOffset(dx: number, width: number, target: boolean) {
  if (target) return Math.max(-width, Math.min(width, dx));
  const room = width * RESIST_FRACTION;
  return Math.sign(dx) * room * (1 - 1 / ((Math.abs(dx) * 0.55) / room + 1));
}
const RESIST_FRACTION = 0.35;

/**
 * One frame of a drag: the content's offset, the share of the width it
 * reveals, and whether a release now would switch (`velocity` is the
 * fingers' px/ms). The destination's icon arms by this on every frame, and a
 * release does what its last frame showed.
 */
export function swipeProgress(
  dx: number,
  width: number,
  target: boolean,
  velocity: number,
) {
  const offset = swipeOffset(dx, width, target);
  const revealed = target && width > 0 ? Math.abs(offset) / width : 0;
  const armed = target && swipeCommits(revealed, velocity * Math.sign(dx));
  return { offset, revealed, armed };
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
