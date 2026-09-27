import { useSyncExternalStore } from "react";

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

let target: FollowTarget | null = null;
const listeners = new Set<() => void>();

export function followTarget() {
  return target;
}

export function subscribeFollow(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: FollowTarget | null) {
  if (target?.key === next?.key && target?.name === next?.name) return;
  target = next;
  listeners.forEach((listener) => listener());
}

export function startFollowing(next: FollowTarget) {
  publish({ key: next.key, name: next.name });
}

let lastStopReason: FollowStopReason | null = null;

export function stopFollowing(reason: FollowStopReason = "user") {
  if (!target) return;
  lastStopReason = reason;
  publish(null);
}

/** Why following last ended (tests and diagnostics). */
export function lastFollowStopReason() {
  return lastStopReason;
}

export function useFollowTarget() {
  return useSyncExternalStore(subscribeFollow, followTarget, () => null);
}
