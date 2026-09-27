import { createStore, useStore } from "zustand";

/**
 * Whom this page follows: a person (presence key, see collaborationGroups).
 * Kept tiny and eager so avatars anywhere can start or show following; the
 * controller that moves the view lives with the collaboration bar.
 */
export type FollowTarget = {
  /** Presence key: a person id, or `participant:<id>` without one. */
  key: string;
  name: string;
};

export type FollowStopReason =
  | "user"
  | "navigated"
  | "escape"
  | "disconnected"
  | "connection";

const followStore = createStore<FollowTarget | null>()(() => null);

export const followTarget = followStore.getState;

function publish(next: FollowTarget | null) {
  const target = followTarget();
  if (target?.key === next?.key && target?.name === next?.name) return;
  followStore.setState(next, true);
}

export function startFollowing(next: FollowTarget) {
  publish({ key: next.key, name: next.name });
}

let lastStopReason: FollowStopReason | null = null;

export function stopFollowing(reason: FollowStopReason = "user") {
  if (!followTarget()) return;
  lastStopReason = reason;
  publish(null);
}

/** Why following last ended (tests and diagnostics). */
export function lastFollowStopReason() {
  return lastStopReason;
}

export function useFollowTarget() {
  return useStore(followStore);
}
