import type { TerminalFrameParts } from "../../shared/terminalFrame";

/** Row-update fields of an endpoint frame sent to a `frame_delta` viewer. */
export interface TerminalFrameUpdate {
  frame_seq?: number;
  /** Full frame rows; absent on row updates. */
  rows?: string[];
  /** Row update against the frame with this sequence number. */
  base_seq?: number;
  changed?: [number, string][];
  /** Omitted from a row update when the cursor tail is unchanged. */
  tail?: string;
}

export type TerminalFrameDecodeResult =
  | { kind: "frame"; seq: number; parts: TerminalFrameParts }
  | { kind: "resync" }
  | { kind: "none" };

/** How long a requested full frame may stay missing before it is asked for again. */
export const TERMINAL_RESYNC_RETRY_MS = 2000;

/**
 * Rebuilds complete endpoint frames from full frames and row updates. A row
 * update against any frame other than the last one applied cannot be trusted,
 * so the caller asks the bridge to resend the newest frame in full.
 */
export class TerminalFrameDecoder {
  private current: { seq: number; parts: TerminalFrameParts } | null = null;
  // Row updates already in flight behind a lost base are dropped quietly
  // until the requested full frame arrives, so one gap asks only once.
  private awaitingFull = false;
  private requestedAt = 0;

  decode(
    update: TerminalFrameUpdate,
    now = performance.now(),
  ): TerminalFrameDecodeResult {
    const seq = update.frame_seq;
    if (typeof seq !== "number") return { kind: "none" };
    if (Array.isArray(update.rows)) {
      if (typeof update.tail !== "string") return this.lost(now);
      this.current = { seq, parts: { rows: update.rows, tail: update.tail } };
      this.awaitingFull = false;
      return { kind: "frame", seq, parts: this.current.parts };
    }
    const base = this.current;
    if (this.awaitingFull) {
      // The request or its reply can be lost too (a dropped call, a bridge
      // that restarted). Row updates still arriving long after it prove the
      // full frame is not coming, so ask again instead of freezing the pane.
      if (now - this.requestedAt < TERMINAL_RESYNC_RETRY_MS)
        return { kind: "none" };
      return this.lost(now);
    }
    if (
      !base ||
      update.base_seq !== base.seq ||
      !Array.isArray(update.changed)
    ) {
      return this.lost(now);
    }
    const rows = base.parts.rows.slice();
    for (const [index, row] of update.changed) {
      if (!Number.isInteger(index) || index < 0 || index >= rows.length)
        return this.lost(now);
      rows[index] = row;
    }
    const parts = { rows, tail: update.tail ?? base.parts.tail };
    this.current = { seq, parts };
    return { kind: "frame", seq, parts };
  }

  /** A requested full frame has not arrived yet. */
  get awaitingResync(): boolean {
    return this.awaitingFull;
  }

  /** The caller asked for the full frame again (see TerminalResyncRetry). */
  resyncRequested(now = performance.now()): void {
    if (this.awaitingFull) this.requestedAt = now;
  }

  reset(): void {
    this.current = null;
    this.awaitingFull = false;
  }

  private lost(now: number): TerminalFrameDecodeResult {
    this.current = null;
    this.awaitingFull = true;
    this.requestedAt = now;
    return { kind: "resync" };
  }
}

/**
 * Asks for a missing full frame again on a timer. The decoder alone re-asks
 * only when a later row update arrives, so a pane that went quiet after its
 * request was lost (a dropped call, a bridge that restarted) would stay stale
 * until the application printed something.
 *
 * `request` sends the resync and returns false once asking is pointless (the
 * terminal was detached or the session disposed), which ends the retries.
 */
export class TerminalResyncRetry {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly decoder: TerminalFrameDecoder,
    private readonly request: () => boolean,
    private readonly retryMs = TERMINAL_RESYNC_RETRY_MS,
  ) {}

  get armed(): boolean {
    return this.timer !== null;
  }

  /** Call after each resync request; restarts the wait. */
  arm(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.decoder.awaitingResync || !this.request()) return;
      this.decoder.resyncRequested();
      this.arm();
    }, this.retryMs);
  }

  cancel(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
