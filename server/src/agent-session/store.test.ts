import { expect, jest, test } from "bun:test";
import {
  AGENT_SESSION_ITEM_LIMIT,
  AGENT_TOOL_OUTPUT_LIMIT,
  type AgentSessionEvent,
} from "../../../shared/agentSession";
import { AgentSessionStore, boundToolOutput, DELTA_FLUSH_MS } from "./store";
import { AGENT_SESSION_TEXT_BUDGET, SessionMirror } from "./transcript";

function harness(now: () => number = () => 1000) {
  const events: AgentSessionEvent[] = [];
  const store = new AgentSessionStore({
    info: {
      pane_id: "w1:p1",
      kind: "claude",
      cwd: "/work",
      started_at: 1,
      modes: [],
    },
    onEvent: (event) => events.push(event),
    now,
  });
  return { store, events };
}

test("every change is one event with the next sequence number", () => {
  const { store, events } = harness();
  expect(store.snapshot()).toMatchObject({
    info: { status: "starting", pane_id: "w1:p1" },
    items: [],
    approvals: [],
    seq: 0,
  });
  store.setPhase("idle");
  store.upsertItem({ id: "u1", type: "user", text: "hi" });
  store.updateInfo({ model: "m" });
  // Nothing changed: nothing is announced.
  store.updateInfo({ model: "m" });
  store.setPhase("idle");
  store.upsertItem({ id: "u1", type: "user", text: "hi" });
  expect(events.map((event) => [event.seq, event.type])).toEqual([
    [1, "info"],
    [2, "item"],
    [3, "info"],
  ]);
  expect(events.every((event) => event.pane_id === "w1:p1")).toBe(true);
  expect(store.snapshot().seq).toBe(3);
});

test("a replaced item keeps its place and its first time", () => {
  let time = 10;
  const { store } = harness(() => time);
  store.upsertItem({ id: "a", type: "user", text: "first" });
  time = 20;
  store.upsertItem({ id: "b", type: "user", text: "second" });
  time = 30;
  store.upsertItem({ id: "a", type: "user", text: "edited" });
  expect(store.snapshot().items).toEqual([
    { id: "a", type: "user", text: "edited", at: 10 },
    { id: "b", type: "user", text: "second", at: 20 },
  ]);
});

test("open approvals turn a running session into awaiting_approval", () => {
  const { store, events } = harness();
  store.setPhase("running");
  const approval = {
    id: "ap1",
    title: "Run: ls",
    options: [{ id: "allow", label: "Allow", kind: "allow" as const }],
  };
  store.addApproval(approval);
  expect(store.info.status).toBe("awaiting_approval");
  expect(store.resolveApproval("ap1")).toBe(true);
  expect(store.resolveApproval("ap1")).toBe(false);
  expect(store.info.status).toBe("running");
  expect(events.map((event) => event.type)).toEqual([
    "info",
    "approval",
    "info",
    "approval_resolved",
    "info",
  ]);
  // An idle session with a stray approval is not waiting on anyone.
  store.setPhase("idle");
  store.addApproval(approval);
  expect(store.info.status).toBe("idle");
});

test("exited is final and carries the reason", () => {
  const { store } = harness();
  store.setPhase("exited", "claude exited with code 1");
  store.setPhase("running");
  expect(store.info).toMatchObject({
    status: "exited",
    error: "claude exited with code 1",
  });
});

test("streamed text is sent at once, then at most once per interval", () => {
  jest.useFakeTimers();
  try {
    let time = 1000;
    const { store, events } = harness(() => time);
    store.upsertItem({ id: "m", type: "assistant", text: "", streaming: true });
    events.length = 0;
    store.appendDelta("m", "Hel");
    expect(events).toEqual([
      { pane_id: "w1:p1", seq: 2, type: "delta", id: "m", text: "Hel" },
    ]);
    store.appendDelta("m", "lo");
    store.appendDelta("m", ", wor");
    expect(events).toHaveLength(1);
    time += DELTA_FLUSH_MS;
    jest.advanceTimersByTime(DELTA_FLUSH_MS);
    expect(events[1]).toMatchObject({ type: "delta", text: "lo, wor" });
    // The snapshot never holds text a later delta would repeat.
    store.appendDelta("m", "ld");
    const snapshot = store.snapshot();
    expect(snapshot.items[0]).toMatchObject({ text: "Hello, world" });
    expect(events[2]).toMatchObject({ type: "delta", text: "ld", seq: 4 });
    expect(snapshot.seq).toBe(4);
    jest.advanceTimersByTime(1000);
    expect(events).toHaveLength(3);
  } finally {
    jest.useRealTimers();
  }
});

test("held-back text goes out before the event that follows it", () => {
  jest.useFakeTimers();
  try {
    const { store, events } = harness();
    store.upsertItem({ id: "m", type: "assistant", text: "", streaming: true });
    store.appendDelta("m", "a");
    store.appendDelta("m", "b");
    store.upsertItem({
      id: "m",
      type: "assistant",
      text: "ab",
      streaming: false,
    });
    expect(events.map((event) => event.type)).toEqual([
      "item",
      "delta",
      "delta",
      "item",
    ]);
    store.appendDelta("missing", "x");
    store.upsertItem({ id: "u", type: "user", text: "q" });
    store.appendDelta("u", "x");
    expect(events).toHaveLength(5);
  } finally {
    jest.useRealTimers();
  }
});

test("the bridge's mirror follows the store event by event", () => {
  const { store, events } = harness();
  const mirror = new SessionMirror(store.snapshot());
  store.setPhase("running");
  store.upsertItem({ id: "u", type: "user", text: "go" });
  store.upsertItem({ id: "m", type: "assistant", text: "", streaming: true });
  store.appendDelta("m", "wor");
  store.appendDelta("m", "king");
  store.addApproval({ id: "ap", title: "t", options: [] });
  store.upsertItem({
    id: "t",
    type: "tool",
    kind: "command",
    name: "Bash",
    title: "ls",
    status: "running",
  });
  store.resolveApproval("ap");
  store.setPhase("idle");
  const final = store.snapshot();
  for (const event of events) expect(mirror.apply(event)).toBe(true);
  expect(mirror.snapshot()).toEqual(final);
  // A repeated or skipped event is refused, so the bridge resynchronizes.
  expect(mirror.apply(events.at(-1)!)).toBe(false);
  expect(mirror.apply({ ...events.at(-1)!, seq: final.seq + 2 })).toBe(false);
});

test("a reset replaces the transcript in one event and closes approvals", () => {
  jest.useFakeTimers();
  try {
    let time = 1000;
    const { store, events } = harness(() => time);
    const mirror = new SessionMirror(store.snapshot());
    store.setPhase("running");
    store.upsertItem({ id: "u", type: "user", text: "old prompt" });
    store.upsertItem({ id: "m", type: "assistant", text: "", streaming: true });
    store.appendDelta("m", "sent at once");
    store.appendDelta("m", ", then held back");
    store.addApproval({ id: "ap", title: "t", options: [] });
    expect(store.info.status).toBe("awaiting_approval");
    const before = events.length;

    time = 5000;
    store.resetItems([
      { id: "r1", type: "user", text: "stored prompt", at: 10 },
      { id: "r2", type: "assistant", text: "stored", streaming: false, at: 20 },
    ]);
    // One reset; the status follows because no approval is open any more.
    expect(events.slice(before).map((event) => event.type)).toEqual([
      "reset",
      "info",
    ]);
    expect(events[before]).toMatchObject({
      type: "reset",
      seq: before + 1,
      items: [{ id: "r1" }, { id: "r2" }],
    });
    expect(store.info.status).toBe("running");
    const snapshot = store.snapshot();
    expect(snapshot.approvals).toEqual([]);
    // Restored items keep their own times, not the time of the reset.
    expect(snapshot.items.map((item) => [item.id, item.at])).toEqual([
      ["r1", 10],
      ["r2", 20],
    ]);
    // Text held back for the old transcript is never announced.
    jest.advanceTimersByTime(DELTA_FLUSH_MS * 2);
    expect(events.slice(before).some((event) => event.type === "delta")).toBe(
      false,
    );
    expect(store.item("m")).toBeUndefined();
    expect(store.approval("ap")).toBeUndefined();

    store.upsertItem({ id: "n", type: "user", text: "next" });
    for (const event of events) expect(mirror.apply(event)).toBe(true);
    expect(mirror.snapshot()).toEqual(store.snapshot());
  } finally {
    jest.useRealTimers();
  }
});

test("a reset keeps the newest items within the bounds", () => {
  const { store, events } = harness();
  const mirror = new SessionMirror(store.snapshot());
  store.resetItems(
    Array.from({ length: AGENT_SESSION_ITEM_LIMIT + 7 }, (_, index) => ({
      id: `r${index}`,
      type: "user" as const,
      text: "x",
      at: index,
    })),
  );
  const reset = events.at(-1)!;
  expect(reset.type === "reset" && reset.items).toHaveLength(
    AGENT_SESSION_ITEM_LIMIT,
  );
  expect(store.snapshot().items[0]!.id).toBe("r7");

  const big = "x".repeat(AGENT_SESSION_TEXT_BUDGET / 40);
  store.resetItems(
    Array.from({ length: 60 }, (_, index) => ({
      id: `b${index}`,
      type: "user" as const,
      text: big,
      at: index,
    })),
  );
  const { items } = store.snapshot();
  expect(items.length).toBeLessThanOrEqual(40);
  expect(items.at(-1)!.id).toBe("b59");
  for (const event of events) expect(mirror.apply(event)).toBe(true);
  expect(mirror.snapshot()).toEqual(store.snapshot());
});

test("the oldest items go past the item limit", () => {
  const { store } = harness();
  for (let index = 0; index < AGENT_SESSION_ITEM_LIMIT + 5; index++)
    store.upsertItem({ id: `u${index}`, type: "user", text: "x" });
  const { items } = store.snapshot();
  expect(items).toHaveLength(AGENT_SESSION_ITEM_LIMIT);
  expect(items[0]!.id).toBe("u5");
});

test("the oldest items go past the text budget, never the newest", () => {
  const { store, events } = harness();
  const mirror = new SessionMirror(store.snapshot());
  const big = "x".repeat(AGENT_SESSION_TEXT_BUDGET / 40);
  for (let index = 0; index < 60; index++)
    store.upsertItem({ id: `u${index}`, type: "user", text: big });
  const { items } = store.snapshot();
  expect(items.length).toBeLessThanOrEqual(40);
  expect(items.length).toBeGreaterThanOrEqual(20);
  expect(items.at(-1)!.id).toBe("u59");
  for (const event of events) mirror.apply(event);
  expect(mirror.snapshot().items.map((item) => item.id)).toEqual(
    items.map((item) => item.id),
  );
});

test("long tool output keeps its start and end within the limit", () => {
  expect(boundToolOutput("short")).toEqual({ output: "short" });
  const long = `START${"x".repeat(AGENT_TOOL_OUTPUT_LIMIT * 2)}END`;
  const bounded = boundToolOutput(long);
  expect(bounded.output_truncated).toBe(true);
  expect(bounded.output.length).toBeLessThanOrEqual(AGENT_TOOL_OUTPUT_LIMIT);
  expect(bounded.output.startsWith("START")).toBe(true);
  expect(bounded.output.endsWith("END")).toBe(true);
  expect(bounded.output).toContain("[... output truncated ...]");
  // A cut never leaves half of a surrogate pair.
  const emoji = boundToolOutput("😀".repeat(AGENT_TOOL_OUTPUT_LIMIT));
  expect(emoji.output.isWellFormed()).toBe(true);
});
