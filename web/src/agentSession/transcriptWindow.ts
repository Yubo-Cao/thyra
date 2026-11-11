// A long transcript mounts only a window of its items. The window follows
// the newest item until the reader scrolls far enough up, then it slides in
// steps, anchored to an item so new output cannot move what is being read.

/** Items mounted while following the newest. */
export const WINDOW_SIZE = 80;
/** Items added or dropped per step. */
export const WINDOW_STEP = 40;
/** Most items mounted at once. */
export const WINDOW_LIMIT = 200;

export type TranscriptWindow = {
  /** ID of the first mounted item; null while following the newest. */
  anchor: string | null;
  size: number;
};

export const TAIL_WINDOW: TranscriptWindow = {
  anchor: null,
  size: WINDOW_SIZE,
};

/** The mounted range `[start, end)` of `order`. */
export function windowRange(
  window: TranscriptWindow,
  order: readonly string[],
): { start: number; end: number } {
  if (window.anchor !== null) {
    // An anchor dropped as too old leaves the window at the oldest items.
    const start = Math.max(0, order.indexOf(window.anchor));
    return { start, end: Math.min(order.length, start + window.size) };
  }
  return { start: Math.max(0, order.length - window.size), end: order.length };
}

/** The window after the reader nears its top: older items join it. */
export function olderWindow(
  window: TranscriptWindow,
  order: readonly string[],
): TranscriptWindow {
  const { start } = windowRange(window, order);
  if (start === 0) return window;
  const next = Math.max(0, start - WINDOW_STEP);
  const size = window.size + (start - next);
  // Still within the limit: keep following the newest.
  if (window.anchor === null && size <= WINDOW_LIMIT)
    return { anchor: null, size };
  return { anchor: order[next], size: Math.min(size, WINDOW_LIMIT) };
}

/** The window after the reader nears its bottom: newer items join it. */
export function newerWindow(
  window: TranscriptWindow,
  order: readonly string[],
): TranscriptWindow {
  if (window.anchor === null) return window;
  const { start, end } = windowRange(window, order);
  if (end + WINDOW_STEP >= order.length) {
    // Reaches the newest: follow it again, keeping what is mounted in view.
    return {
      anchor: null,
      size: Math.min(WINDOW_LIMIT, order.length - start),
    };
  }
  const size = Math.min(WINDOW_LIMIT, window.size + WINDOW_STEP);
  return { anchor: order[end + WINDOW_STEP - size], size };
}
