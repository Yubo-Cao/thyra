import { describe, expect, test } from "bun:test";
import {
  AGENT_SESSION_ITEM_LIMIT,
  type AgentItem,
  type AgentSessionEvent,
  type AgentSessionInfo,
} from "../../../shared/agentSession";
import {
  type AgentSessionState,
  applySessionEvent,
  sessionFromSnapshot,
  sessionShowsActivity,
} from "./reducer";

const info: AgentSessionInfo = {
  pane_id: "p1",
  kind: "claude",
  status: "running",
  cwd: "/work",
  started_at: 1,
  modes: [],
};
const assistant = (id: string, text: string, streaming = true): AgentItem => ({
  id,
  at: 1,
  type: "assistant",
  text,
  streaming,
});
const user = (id: string, text: string): AgentItem => ({
  id,
  at: 1,
  type: "user",
  text,
});

function session(items: AgentItem[] = [], seq = 10): AgentSessionState {
  return sessionFromSnapshot({ info, items, approvals: [], seq });
}

function apply(state: AgentSessionState, ...events: object[]) {
  let current = state;
  for (const [index, event] of events.entries()) {
    const next = applySessionEvent(current, {
      pane_id: "p1",
      seq: state.seq + index + 1,
      ...event,
    } as AgentSessionEvent);
    if (next === "gap") throw new Error("unexpected gap");
    current = next;
  }
  return current;
}

describe("agent session reducer", () => {
  test("a snapshot keeps item order and indexes by ID", () => {
    const state = session([user("u1", "hi"), assistant("a1", "hello")], 4);
    expect(state.order).toEqual(["u1", "a1"]);
    expect(state.items.a1).toMatchObject({ text: "hello" });
    expect(state.seq).toBe(4);
  });

  test("a delta appends to its item and leaves the order untouched", () => {
    const state = session([user("u1", "hi"), assistant("a1", "Hel")]);
    const next = apply(state, { type: "delta", id: "a1", text: "lo" });
    expect(next.items.a1).toMatchObject({ text: "Hello", streaming: true });
    expect(next.order).toBe(state.order);
    expect(next.items.u1).toBe(state.items.u1);
    expect(next.approvals).toBe(state.approvals);
    expect(next.seq).toBe(11);
  });

  test("a delta for an unknown or non-text item only advances the sequence", () => {
    const state = session([user("u1", "hi")]);
    const next = apply(
      state,
      { type: "delta", id: "missing", text: "x" },
      { type: "delta", id: "u1", text: "x" },
    );
    expect(next.items).toBe(state.items);
    expect(next.seq).toBe(12);
  });

  test("an item event inserts at the end or replaces in place", () => {
    const state = session([assistant("a1", "one")]);
    const next = apply(
      state,
      { type: "item", item: user("u2", "next") },
      { type: "item", item: assistant("a1", "one.", false) },
    );
    expect(next.order).toEqual(["a1", "u2"]);
    expect(next.items.a1).toMatchObject({ text: "one.", streaming: false });
  });

  test("the oldest items are dropped past the limit", () => {
    const items = Array.from({ length: AGENT_SESSION_ITEM_LIMIT }, (_, index) =>
      user(`u${index}`, "x"),
    );
    const next = apply(session(items), {
      type: "item",
      item: user("new", "y"),
    });
    expect(next.order).toHaveLength(AGENT_SESSION_ITEM_LIMIT);
    expect(next.order[0]).toBe("u1");
    expect(next.order[next.order.length - 1]).toBe("new");
    expect(next.items.u0).toBeUndefined();
  });

  test("approvals are added, replaced and resolved", () => {
    const approval = {
      id: "ap1",
      item_id: "t1",
      title: "Run command",
      options: [{ id: "y", label: "Allow", kind: "allow" as const }],
    };
    const open = apply(
      session(),
      { type: "approval", approval },
      { type: "approval", approval: { ...approval, title: "Run rm" } },
    );
    expect(open.approvals).toEqual([{ ...approval, title: "Run rm" }]);
    const resolved = apply(open, { type: "approval_resolved", id: "ap1" });
    expect(resolved.approvals).toEqual([]);
  });

  test("info events replace the session info", () => {
    const next = apply(session(), {
      type: "info",
      info: { ...info, status: "idle", model: "m" },
    });
    expect(next.info).toMatchObject({ status: "idle", model: "m" });
  });

  test("stale events are ignored and a skipped sequence is a gap", () => {
    const state = session([assistant("a1", "x")], 10);
    const stale = {
      pane_id: "p1",
      type: "delta",
      id: "a1",
      text: "y",
    } as const;
    expect(applySessionEvent(state, { ...stale, seq: 10 })).toBe(state);
    expect(applySessionEvent(state, { ...stale, seq: 3 })).toBe(state);
    expect(applySessionEvent(state, { ...stale, seq: 12 })).toBe("gap");
  });

  test("activity shows only while nothing on screen is moving", () => {
    expect(sessionShowsActivity(session())).toBe(true);
    expect(sessionShowsActivity(session([assistant("a1", "x")]))).toBe(false);
    expect(sessionShowsActivity(session([assistant("a1", "x", false)]))).toBe(
      true,
    );
    const idle = apply(session([user("u1", "x")]), {
      type: "info",
      info: { ...info, status: "idle" },
    });
    expect(sessionShowsActivity(idle)).toBe(false);
  });
});
