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

  test("a reset replaces the transcript, closes approvals and starts an epoch", () => {
    const approval = {
      id: "ap1",
      item_id: "a1",
      title: "Run command",
      options: [{ id: "y", label: "Allow", kind: "allow" as const }],
    };
    const state = apply(session([user("u1", "now"), assistant("a1", "x")]), {
      type: "approval",
      approval,
    });
    const next = apply(state, {
      type: "reset",
      // An ID the replaced transcript used too: it is another item now.
      items: [user("old1", "earlier"), assistant("a1", "stored", false)],
    });
    expect(next.order).toEqual(["old1", "a1"]);
    expect(Object.keys(next.items)).toEqual(["old1", "a1"]);
    expect(next.items.a1).toMatchObject({ text: "stored", streaming: false });
    expect(next.approvals).toEqual([]);
    expect(next.info).toBe(state.info);
    expect(next.seq).toBe(state.seq + 1);
    expect(next.epoch).toBe(state.epoch + 1);
    // Events after it apply to the new items, in sequence.
    const later = apply(next, { type: "item", item: user("u2", "go on") });
    expect(later.order).toEqual(["old1", "a1", "u2"]);
    expect(later.epoch).toBe(next.epoch);
    expect(
      applySessionEvent(next, {
        pane_id: "p1",
        seq: next.seq + 2,
        type: "reset",
        items: [],
      }),
    ).toBe("gap");
  });

  test("a reset to nothing leaves an empty transcript", () => {
    const next = apply(session([user("u1", "now")]), {
      type: "reset",
      items: [],
    });
    expect(next.order).toEqual([]);
    expect(next.items).toEqual({});
    expect(
      apply(session([user("u1", "now")]), { type: "reset" }).order,
    ).toEqual([]);
  });

  test("a snapshot after another keeps the epoch unless the conversation changed", () => {
    const first = sessionFromSnapshot({
      info: { ...info, agent_session_id: "c1" },
      items: [user("u1", "hi")],
      approvals: [],
      seq: 4,
    });
    expect(first.epoch).toBe(0);
    const reset = apply(first, { type: "reset", items: [] });
    const snapshot = (id?: string) =>
      sessionFromSnapshot(
        {
          info: { ...info, agent_session_id: id },
          items: [],
          approvals: [],
          seq: 9,
        },
        reset,
      );
    expect(snapshot("c1").epoch).toBe(1);
    // A resume missed while not subscribed.
    expect(snapshot("c2").epoch).toBe(2);
    expect(snapshot().epoch).toBe(2);
    // A conversation ID that only became known is the same conversation.
    const unknown = sessionFromSnapshot({
      info,
      items: [],
      approvals: [],
      seq: 1,
    });
    expect(
      sessionFromSnapshot(
        {
          info: { ...info, agent_session_id: "c1" },
          items: [],
          approvals: [],
          seq: 2,
        },
        unknown,
      ).epoch,
    ).toBe(0);
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

  test("an unknown event kind keeps the state and the sequence", () => {
    const state = session([user("u1", "hi")]);
    const next = apply(state, { type: "from_a_newer_host", extra: 1 });
    expect(next.items).toBe(state.items);
    expect(next.seq).toBe(11);
    expect(sessionFromSnapshot({ info, seq: 3 } as never)).toMatchObject({
      order: [],
      approvals: [],
      seq: 3,
    });
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
