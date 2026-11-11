import {
  AGENT_SESSION_ITEM_LIMIT,
  type AgentApproval,
  type AgentItem,
  type AgentSessionEvent,
  type AgentSessionInfo,
  type AgentSessionSnapshot,
} from "../../../shared/agentSession";

/**
 * Characters of transcript text a session keeps. Past it the oldest items go,
 * like past `AGENT_SESSION_ITEM_LIMIT`, so a snapshot stays a few megabytes.
 */
export const AGENT_SESSION_TEXT_BUDGET = 2 * 1024 * 1024;
/** The newest items stay whatever their size. */
const KEEP_RECENT_ITEMS = 20;

function itemSize(item: AgentItem): number {
  switch (item.type) {
    case "user":
    case "assistant":
    case "thinking":
    case "notice":
      return item.text.length;
    case "plan":
      return item.entries.reduce((sum, entry) => sum + entry.text.length, 0);
    case "tool":
      return (
        item.title.length +
        (item.command?.length ?? 0) +
        (item.input?.length ?? 0) +
        (item.output?.length ?? 0) +
        (item.diffs?.reduce(
          (sum, diff) => sum + diff.path.length + diff.patch.length,
          0,
        ) ?? 0)
      );
  }
}

/**
 * The bounded item list of one session, oldest first. The host and the
 * bridge's copy drop the same items, since both apply the same events.
 */
export class Transcript {
  private readonly items = new Map<string, AgentItem>();
  private readonly sizes = new Map<string, number>();
  private textSize = 0;

  constructor(items: AgentItem[] = []) {
    for (const item of items) this.upsert(item);
  }

  get(id: string): AgentItem | undefined {
    return this.items.get(id);
  }

  list(): AgentItem[] {
    return [...this.items.values()];
  }

  /** Insert an item, or replace the one with its ID in place. */
  upsert(item: AgentItem) {
    this.items.set(item.id, item);
    const size = itemSize(item);
    this.textSize += size - (this.sizes.get(item.id) ?? 0);
    this.sizes.set(item.id, size);
    this.trim();
  }

  /** Append streamed text; false when the item cannot take it. */
  appendText(id: string, text: string): boolean {
    const item = this.items.get(id);
    if (!item || (item.type !== "assistant" && item.type !== "thinking"))
      return false;
    this.items.set(id, { ...item, text: item.text + text });
    this.textSize += text.length;
    this.sizes.set(id, (this.sizes.get(id) ?? 0) + text.length);
    return true;
  }

  private trim() {
    for (const [id] of this.items) {
      const over =
        this.items.size > AGENT_SESSION_ITEM_LIMIT ||
        (this.textSize > AGENT_SESSION_TEXT_BUDGET &&
          this.items.size > KEEP_RECENT_ITEMS);
      if (!over) return;
      this.items.delete(id);
      this.textSize -= this.sizes.get(id) ?? 0;
      this.sizes.delete(id);
    }
  }
}

/**
 * The bridge's copy of one session: a host's snapshot kept current by its
 * events, so a page can subscribe without a round trip to the pane.
 */
export class SessionMirror {
  info: AgentSessionInfo;
  seq: number;
  private transcript: Transcript;
  private readonly approvals = new Map<string, AgentApproval>();

  constructor(snapshot: AgentSessionSnapshot) {
    this.info = snapshot.info;
    this.seq = snapshot.seq;
    this.transcript = new Transcript(snapshot.items);
    for (const approval of snapshot.approvals)
      this.approvals.set(approval.id, approval);
  }

  /** Apply the next event; false when it is not the one after `seq`. */
  apply(event: AgentSessionEvent): boolean {
    if (event.seq !== this.seq + 1) return false;
    this.seq = event.seq;
    switch (event.type) {
      case "info":
        this.info = event.info;
        break;
      case "item":
        this.transcript.upsert(event.item);
        break;
      case "delta":
        this.transcript.appendText(event.id, event.text);
        break;
      case "approval":
        this.approvals.set(event.approval.id, event.approval);
        break;
      case "approval_resolved":
        this.approvals.delete(event.id);
        break;
      case "reset":
        this.transcript = new Transcript(event.items);
        this.approvals.clear();
        break;
    }
    return true;
  }

  snapshot(): AgentSessionSnapshot {
    return {
      info: this.info,
      items: this.transcript.list(),
      approvals: [...this.approvals.values()],
      seq: this.seq,
    };
  }
}
