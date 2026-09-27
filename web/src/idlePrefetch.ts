type NetworkInformationLike = {
  saveData?: boolean;
  effectiveType?: string;
};

type IdleWindow = Pick<Window, "setTimeout" | "clearTimeout"> & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Prefetching spends bandwidth the user did not ask for. Skip it when the
 * browser reports Data Saver or a 2G-class link; browsers without the Network
 * Information API (Safari, Firefox) prefetch.
 */
export function idlePrefetchAllowed(
  connection: NetworkInformationLike | undefined = (
    globalThis.navigator as { connection?: NetworkInformationLike } | undefined
  )?.connection,
) {
  if (!connection) return true;
  if (connection.saveData) return false;
  return !["slow-2g", "2g"].includes(connection.effectiveType ?? "");
}

/**
 * Run loaders one at a time, each in its own idle period, so prefetching
 * never competes with terminal output for the main thread or the link.
 * Returns a cancel function.
 */
export function prefetchWhenIdle(
  loaders: readonly (() => Promise<unknown>)[],
  target: IdleWindow = window,
  allowed = idlePrefetchAllowed,
) {
  let cancelled = false;
  let cancelPending = () => {};
  const idle = () =>
    new Promise<void>((resolve) => {
      if (target.requestIdleCallback) {
        const handle = target.requestIdleCallback(resolve, { timeout: 5000 });
        cancelPending = () => target.cancelIdleCallback?.(handle);
      } else {
        const handle = target.setTimeout(resolve, 250);
        cancelPending = () => target.clearTimeout(handle);
      }
    });
  void (async () => {
    for (const load of loaders) {
      await idle();
      // Re-check each time: Data Saver or the link can change mid-session.
      if (cancelled || !allowed()) return;
      await load().catch(() => undefined);
    }
  })();
  return () => {
    cancelled = true;
    cancelPending();
  };
}
