export type TerminalSize = { cols: number; rows: number };

export type TerminalViewportLayout = {
  zoomed?: boolean;
  area: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  panes: Array<{
    pane_id: string;
    rect: {
      width: number;
      height: number;
    };
  }>;
};

export const TERMINAL_RESIZE_DEBOUNCE_MS = 90;
/** Waits before each retry of a size whose `terminal.resize` was rejected. */
export const TERMINAL_RESIZE_RETRY_DELAYS_MS: readonly number[] = [
  250, 1000, 3000,
];

function sameSize(a: TerminalSize | null, b: TerminalSize | null): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows;
}

function validSize(size: TerminalSize): boolean {
  return size.cols > 0 && size.rows > 0;
}

/** Endpoint surfaces cover the tab, excluding app sidebar and tab-bar insets. */
export function terminalEndpointViewportSize(
  size: TerminalSize,
  layout: TerminalViewportLayout | null | undefined,
  paneId: string | null | undefined,
): TerminalSize | null {
  if (!validSize(size) || !layout || !paneId) return null;
  const pane = layout.panes.find((item) => item.pane_id === paneId);
  const area = layout.area;
  if (
    !pane ||
    area.width <= 0 ||
    area.height <= 0 ||
    pane.rect.width <= 0 ||
    pane.rect.height <= 0
  ) {
    return null;
  }

  const splitLayout = layout.panes.length > 1 && !layout.zoomed;
  const paneChromeCols = splitLayout ? 3 : 1;
  const paneChromeRows = splitLayout ? 2 : 0;
  // A pane already matching the current layout (±1 cell for xterm fit's
  // fractional-pixel flooring) means the layout is settled: return the area
  // verbatim. Recomputing a rounded estimate per pane lets routine focus
  // switches re-base the shared geometry on ±1-2 cell differences, visibly
  // reflowing every pane in the tab.
  if (
    Math.abs(size.cols - (pane.rect.width - paneChromeCols)) <= 1 &&
    Math.abs(size.rows - (pane.rect.height - paneChromeRows)) <= 1
  ) {
    return { cols: area.width, rows: area.height };
  }
  const terminalAreaCols = Math.max(
    1,
    Math.round(((size.cols + paneChromeCols) * area.width) / pane.rect.width),
  );
  const terminalAreaRows = Math.max(
    1,
    Math.round(((size.rows + paneChromeRows) * area.height) / pane.rect.height),
  );
  return {
    cols: Math.min(65_535, terminalAreaCols),
    rows: Math.min(65_535, terminalAreaRows),
  };
}

/**
 * Coalesces xterm size changes into `terminal.resize` RPCs.
 *
 * Herdr re-renders and streams a full frame on every resize — even a same-size
 * one — so over a slow (remote) link every redundant RPC becomes a visible
 * full-screen reflow. This helper therefore
 *  - dedupes sizes identical to the last dispatched server size, and
 *  - debounces bursts (CSS transitions, window drags, pane-layout settling)
 *    into a single trailing update.
 *
 * `send` must return false when the resize could not be dispatched (e.g. no
 * terminal is currently attached); the size then stays "unsynced" so a later
 * schedule/sendNow retries it. A dispatched size the server rejected
 * (`markFailed`) is sent again on its own a bounded number of times, since no
 * further size change may ever come to retry it.
 */
export class TerminalResizeSync {
  private synced: TerminalSize | null = null;
  private pending: TerminalSize | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Consecutive rejections of `retrySize`; another size starts over.
  private retrySize: TerminalSize | null = null;
  private retries = 0;

  constructor(
    private send: (size: TerminalSize) => boolean,
    private debounceMs = TERMINAL_RESIZE_DEBOUNCE_MS,
    private retryDelaysMs = TERMINAL_RESIZE_RETRY_DELAYS_MS,
  ) {}

  /** Records the size an attach RPC already carried to the server. */
  markAttached(size: TerminalSize) {
    this.cancelPending();
    this.retrySize = null;
    this.retries = 0;
    this.synced = validSize(size) ? size : null;
  }

  /** Debounced sync; collapses bursts and drops no-op sizes. */
  schedule(size: TerminalSize) {
    if (!validSize(size)) return;
    if (sameSize(size, this.synced)) {
      // A burst that lands back on the synced size must not fire stale
      // intermediate sizes queued earlier in the burst.
      this.cancelPending();
      return;
    }
    this.pending = size;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.debounceMs);
  }

  /** Immediate sync, still deduped against the dispatched server size. */
  sendNow(size: TerminalSize): boolean {
    if (!validSize(size)) return false;
    this.cancelPending();
    return this.deliver(size);
  }

  /**
   * A dispatched size was rejected: forget it as synced and send it again
   * after a growing delay. After the last delay it waits for the next size
   * change (or `sendNow`), so a server that keeps refusing is not hammered.
   */
  markFailed(size: TerminalSize) {
    // A newer size was dispatched since; its own outcome decides.
    if (!sameSize(size, this.synced)) return;
    this.synced = null;
    if (!sameSize(size, this.retrySize)) {
      this.retrySize = size;
      this.retries = 0;
    }
    // A newer size is already queued and will be sent instead.
    if (this.timer !== null || this.retries >= this.retryDelaysMs.length)
      return;
    this.pending = size;
    this.timer = setTimeout(
      () => this.fire(),
      this.retryDelaysMs[this.retries++],
    );
  }

  dispose() {
    this.cancelPending();
  }

  private cancelPending() {
    this.pending = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private fire() {
    const size = this.pending;
    this.pending = null;
    this.timer = null;
    if (!size) return;
    this.deliver(size);
  }

  private deliver(size: TerminalSize): boolean {
    if (sameSize(size, this.synced)) return false;
    if (!this.send(size)) return false;
    this.synced = size;
    if (!sameSize(size, this.retrySize)) {
      this.retrySize = null;
      this.retries = 0;
    }
    return true;
  }
}

export class TerminalAttachFrameWatchdog {
  private attempt = 0;
  private frameAttempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Starts a new attach attempt and returns its identity. */
  begin(): number {
    this.clearTimer();
    this.attempt += 1;
    return this.attempt;
  }

  isCurrent(attempt: number): boolean {
    return attempt === this.attempt;
  }

  /**
   * Records a matching frame whether it arrives before or after the RPC.
   * True for the first frame of the current attempt: the moment the view
   * stops loading. Later frames of a stream return false.
   */
  markFrame(): boolean {
    const first = this.frameAttempt !== this.attempt;
    this.frameAttempt = this.attempt;
    this.clearTimer();
    return first;
  }

  /**
   * Arms only if this is still the current attempt and no frame has arrived.
   * Returns false when the watchdog was already satisfied or superseded.
   */
  arm(attempt: number, delayMs: number, onTimeout: () => void): boolean {
    if (attempt !== this.attempt || this.frameAttempt === attempt) return false;
    this.clearTimer();
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (attempt !== this.attempt || this.frameAttempt === attempt) return;
        onTimeout();
      },
      Math.max(0, delayMs),
    );
    return true;
  }

  cancel(attempt?: number) {
    if (attempt !== undefined && attempt !== this.attempt) return;
    this.clearTimer();
    this.attempt += 1;
  }

  dispose() {
    this.cancel();
  }

  private clearTimer() {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

const ATTACH_WATCHDOG_MIN_MS = 4000;
const ATTACH_WATCHDOG_MAX_MS = 20000;
const ATTACH_WATCHDOG_RTT_FACTOR = 3;

/**
 * Scales the "no frame after attach" watchdog with the attach round-trip so
 * slow remote links (where the first full frame legitimately takes seconds)
 * do not trigger futile detach/re-attach storms.
 */
export function terminalAttachWatchdogMs(attachRttMs: number): number {
  const scaled = Math.round(
    Math.max(0, attachRttMs) * ATTACH_WATCHDOG_RTT_FACTOR,
  );
  return Math.min(
    ATTACH_WATCHDOG_MAX_MS,
    Math.max(ATTACH_WATCHDOG_MIN_MS, scaled),
  );
}
