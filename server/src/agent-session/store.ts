import {
  AGENT_TOOL_OUTPUT_LIMIT,
  type AgentApproval,
  type AgentItem,
  type AgentSessionEvent,
  type AgentSessionInfo,
  type AgentSessionSnapshot,
  type AgentSessionStatus,
} from "../../../shared/agentSession";
import { Transcript } from "./transcript";

/** Streamed text reaches pages at most once per this interval per session. */
export const DELTA_FLUSH_MS = 40;
const TRUNCATION_MARK = "\n[... output truncated ...]\n";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type EventBody = DistributiveOmit<AgentSessionEvent, "pane_id" | "seq">;
/**
 * An item as adapters write it. The store stamps when it first appeared, so
 * an `at` passed along (an item read back and changed) is ignored.
 */
export type AgentItemInput = DistributiveOmit<AgentItem, "at"> & {
  at?: number;
};
export type AgentToolItem = Extract<AgentItem, { type: "tool" }>;

/** `starting`, `idle`, `running` or `exited`: open approvals refine `running`. */
export type AgentPhase = Exclude<AgentSessionStatus, "awaiting_approval">;

/**
 * Tool output cut to `AGENT_TOOL_OUTPUT_LIMIT`: the start and the end, since
 * a command's verdict is usually in its last lines.
 */
export function boundToolOutput(text: string): {
  output: string;
  output_truncated?: true;
} {
  if (text.length <= AGENT_TOOL_OUTPUT_LIMIT) return { output: text };
  const room = AGENT_TOOL_OUTPUT_LIMIT - TRUNCATION_MARK.length;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return {
    output:
      wholeCharacters(text.slice(0, head), "end") +
      TRUNCATION_MARK +
      wholeCharacters(text.slice(text.length - tail), "start"),
    output_truncated: true,
  };
}

/** Drop half of a surrogate pair left at a cut. */
function wholeCharacters(text: string, cut: "start" | "end"): string {
  if (cut === "end") {
    const last = text.charCodeAt(text.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
  }
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
}

/**
 * The session an agent host keeps in memory: what `AgentSessionSnapshot`
 * shows, and the numbered events that lead from one snapshot to the next.
 * Adapters change it; every change is announced once through `onEvent`.
 */
export class AgentSessionStore {
  private info_: AgentSessionInfo;
  private phase_: AgentPhase = "starting";
  private transcript = new Transcript();
  private readonly approvals_ = new Map<string, AgentApproval>();
  private seq = 0;
  /** Streamed text already in the transcript and not yet announced, by item. */
  private readonly pendingDeltas = new Map<string, string>();
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDeltaFlush = 0;
  private readonly onEvent: (event: AgentSessionEvent) => void;
  private readonly now: () => number;

  constructor(args: {
    info: Omit<AgentSessionInfo, "status">;
    onEvent: (event: AgentSessionEvent) => void;
    now?: () => number;
  }) {
    this.info_ = { ...args.info, status: "starting" };
    this.onEvent = args.onEvent;
    this.now = args.now ?? Date.now;
  }

  get info(): AgentSessionInfo {
    return this.info_;
  }

  get phase(): AgentPhase {
    return this.phase_;
  }

  get approvals(): AgentApproval[] {
    return [...this.approvals_.values()];
  }

  item(id: string): AgentItem | undefined {
    return this.transcript.get(id);
  }

  approval(id: string): AgentApproval | undefined {
    return this.approvals_.get(id);
  }

  /** Everything so far; streamed text still held back is announced first. */
  snapshot(): AgentSessionSnapshot {
    this.flushDeltas();
    return {
      info: this.info_,
      items: this.transcript.list(),
      approvals: this.approvals,
      seq: this.seq,
    };
  }

  private emit(body: EventBody) {
    this.seq += 1;
    this.onEvent({
      ...body,
      pane_id: this.info_.pane_id,
      seq: this.seq,
    } as AgentSessionEvent);
  }

  private status(): AgentSessionStatus {
    return this.phase_ === "running" && this.approvals_.size > 0
      ? "awaiting_approval"
      : this.phase_;
  }

  /** Change session facts other than the status; announced when they differ. */
  updateInfo(patch: Partial<Omit<AgentSessionInfo, "status" | "pane_id">>) {
    this.setInfo({ ...this.info_, ...patch });
  }

  /** Move to a phase; `exited` is final and may carry why. */
  setPhase(phase: AgentPhase, error?: string) {
    if (this.phase_ === "exited") return;
    this.phase_ = phase;
    this.setInfo(
      phase === "exited" && error ? { ...this.info_, error } : this.info_,
    );
  }

  private setInfo(next: AgentSessionInfo) {
    const info = { ...next, status: this.status() };
    if (JSON.stringify(info) === JSON.stringify(this.info_)) return;
    this.flushDeltas();
    this.info_ = info;
    this.emit({ type: "info", info });
  }

  /** Insert an item, or replace the one with its ID (which keeps its time). */
  upsertItem(item: AgentItemInput): AgentItem {
    const previous = this.transcript.get(item.id);
    const stored = { ...item, at: previous?.at ?? this.now() } as AgentItem;
    if (previous && JSON.stringify(previous) === JSON.stringify(stored))
      return previous;
    this.flushDeltas();
    this.transcript.upsert(stored);
    this.emit({ type: "item", item: stored });
    return stored;
  }

  /**
   * Replace the whole transcript with a stored conversation's, in one `reset`
   * event. The items keep their own times, no approval stays open, and text
   * still held back belonged to the transcript that goes away.
   */
  resetItems(items: AgentItem[]) {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = null;
    this.pendingDeltas.clear();
    this.transcript = new Transcript(items);
    this.approvals_.clear();
    this.emit({ type: "reset", items: this.transcript.list() });
    this.setInfo(this.info_);
  }

  /** Append streamed text to an `assistant` or `thinking` item. */
  appendDelta(id: string, text: string) {
    if (!text || !this.transcript.appendText(id, text)) return;
    this.pendingDeltas.set(id, (this.pendingDeltas.get(id) ?? "") + text);
    if (this.deltaTimer) return;
    const wait = this.lastDeltaFlush + DELTA_FLUSH_MS - this.now();
    if (wait <= 0) this.flushDeltas();
    else this.deltaTimer = setTimeout(() => this.flushDeltas(), wait);
  }

  /** Announce streamed text held back so far. */
  flushDeltas() {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = null;
    if (this.pendingDeltas.size === 0) return;
    this.lastDeltaFlush = this.now();
    const pending = [...this.pendingDeltas];
    this.pendingDeltas.clear();
    for (const [id, text] of pending) this.emit({ type: "delta", id, text });
  }

  addApproval(approval: AgentApproval) {
    this.flushDeltas();
    this.approvals_.set(approval.id, approval);
    this.emit({ type: "approval", approval });
    this.setInfo(this.info_);
  }

  resolveApproval(id: string): boolean {
    if (!this.approvals_.delete(id)) return false;
    this.flushDeltas();
    this.emit({ type: "approval_resolved", id });
    this.setInfo(this.info_);
    return true;
  }

  resolveAllApprovals() {
    for (const id of [...this.approvals_.keys()]) this.resolveApproval(id);
  }

  dispose() {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = null;
  }
}
