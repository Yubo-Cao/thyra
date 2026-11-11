import {
  AGENT_SESSION_ITEM_LIMIT,
  type AgentApproval,
  type AgentItem,
  type AgentSessionEvent,
  type AgentSessionInfo,
  type AgentSessionSnapshot,
} from "../../../shared/agentSession";

/**
 * One session as the page holds it. `order` and `approvals` keep their
 * identity while only an item's content changes, so a streamed delta
 * re-renders the one row that shows it.
 */
export type AgentSessionState = {
  info: AgentSessionInfo;
  /** Item IDs, oldest first. */
  order: readonly string[];
  items: Readonly<Record<string, AgentItem>>;
  approvals: readonly AgentApproval[];
  /** Sequence number of the last event reflected here. */
  seq: number;
  /**
   * Rises when the items became another conversation's (a `reset`). What a
   * view keeps per item (its place, open rows, parsed text) ends with it.
   */
  epoch: number;
};

/** Items by ID and their order; an ID sent twice keeps its first position and its last content. */
function indexItems(list: readonly AgentItem[] | undefined) {
  const items: Record<string, AgentItem> = {};
  for (const item of list ?? []) items[item.id] = item;
  return { items, order: Object.keys(items) };
}

/**
 * The session a snapshot describes. `previous` is the state it replaces, when
 * the page subscribed again: a resume missed meanwhile shows as another
 * conversation ID and starts a new epoch like the `reset` would have.
 */
export function sessionFromSnapshot(
  snapshot: AgentSessionSnapshot,
  previous?: AgentSessionState | null,
): AgentSessionState {
  const before = previous?.info.agent_session_id;
  const resumed =
    before !== undefined && before !== snapshot.info.agent_session_id;
  return {
    info: snapshot.info,
    ...indexItems(snapshot.items),
    approvals: snapshot.approvals ?? [],
    seq: snapshot.seq,
    epoch: (previous?.epoch ?? 0) + (resumed ? 1 : 0),
  };
}

/**
 * The session after `event`. An event the state already reflects returns the
 * same state; `"gap"` means events were missed and only a fresh snapshot
 * (subscribing again) can catch up.
 */
export function applySessionEvent(
  state: AgentSessionState,
  event: AgentSessionEvent,
): AgentSessionState | "gap" {
  if (event.seq <= state.seq) return state;
  if (event.seq !== state.seq + 1) return "gap";
  const seq = event.seq;
  switch (event.type) {
    case "info":
      return { ...state, info: event.info, seq };
    case "item": {
      const { item } = event;
      if (item.id in state.items)
        return { ...state, items: { ...state.items, [item.id]: item }, seq };
      const items = { ...state.items, [item.id]: item };
      const order = [...state.order, item.id];
      // The host keeps the same limit and drops its oldest items too.
      for (const dropped of order.splice(
        0,
        Math.max(0, order.length - AGENT_SESSION_ITEM_LIMIT),
      ))
        delete items[dropped];
      return { ...state, items, order, seq };
    }
    case "delta": {
      const item = state.items[event.id];
      // A delta for an item that is gone (dropped as too old) has nowhere to go.
      if (!item || (item.type !== "assistant" && item.type !== "thinking"))
        return { ...state, seq };
      return {
        ...state,
        items: {
          ...state.items,
          [item.id]: { ...item, text: item.text + event.text },
        },
        seq,
      };
    }
    case "approval": {
      const { approval } = event;
      const known = state.approvals.some((item) => item.id === approval.id);
      return {
        ...state,
        approvals: known
          ? state.approvals.map((item) =>
              item.id === approval.id ? approval : item,
            )
          : [...state.approvals, approval],
        seq,
      };
    }
    case "approval_resolved":
      return {
        ...state,
        approvals: state.approvals.filter((item) => item.id !== event.id),
        seq,
      };
    case "reset":
      return {
        ...state,
        ...indexItems(event.items),
        approvals: [],
        seq,
        epoch: state.epoch + 1,
      };
    default:
      // An event kind from a newer host: nothing to draw, still in sequence.
      return { ...state, seq };
  }
}

/** Whether the agent is working with nothing on screen that shows it. */
export function sessionShowsActivity(state: AgentSessionState): boolean {
  if (state.info.status !== "running") return false;
  const last = state.items[state.order[state.order.length - 1] ?? ""];
  if (!last) return true;
  if (last.type === "assistant" || last.type === "thinking")
    return !last.streaming;
  if (last.type === "tool")
    return last.status !== "running" && last.status !== "pending";
  return true;
}
