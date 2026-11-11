import { expect, test } from "bun:test";
import type { AgentSessionEvent } from "../../../shared/agentSession";
import { createTerminalLog } from "./terminal-log";

function log() {
  const written: string[] = [];
  const terminal = createTerminalLog((text) => written.push(text));
  let seq = 0;
  type Body = AgentSessionEvent extends infer T
    ? T extends unknown
      ? Omit<T, "pane_id" | "seq">
      : never
    : never;
  return {
    text: () => written.join(""),
    event: (body: Body) =>
      terminal.event({
        ...body,
        pane_id: "w1:p1",
        seq: ++seq,
      } as AgentSessionEvent),
  };
}

test("streamed answers are written as they arrive, other items once", () => {
  const { text, event } = log();
  event({ type: "item", item: { id: "u", type: "user", text: "hi", at: 1 } });
  event({
    type: "item",
    item: { id: "m", type: "assistant", text: "Hel", streaming: true, at: 2 },
  });
  event({ type: "delta", id: "m", text: "lo" });
  // Deltas of an item that is not on the current line are not interleaved.
  event({ type: "delta", id: "other", text: "XX" });
  event({
    type: "item",
    item: {
      id: "m",
      type: "assistant",
      text: "Hello",
      streaming: false,
      at: 2,
    },
  });
  event({ type: "item", item: { id: "u", type: "user", text: "hi", at: 1 } });
  event({
    type: "item",
    item: { id: "t", type: "thinking", text: "hm", streaming: false, at: 3 },
  });
  event({
    type: "item",
    item: {
      id: "p",
      type: "plan",
      at: 4,
      entries: [
        { text: "a", status: "done" },
        { text: "b", status: "in_progress" },
      ],
    },
  });
  expect(text()).toBe("\n> hi\n\nHello\n* plan 1/2: b\n");
});

test("a tool call is one line, with its outcome when it fails", () => {
  const { text, event } = log();
  const tool = (status: "pending" | "running" | "done" | "failed") =>
    event({
      type: "item",
      item: {
        id: "t",
        type: "tool",
        kind: "command",
        name: "Bash",
        title: "make",
        status,
        at: 1,
      },
    });
  tool("pending");
  tool("running");
  tool("running");
  tool("failed");
  event({
    type: "item",
    item: {
      id: "t2",
      type: "tool",
      kind: "other",
      name: "TaskList",
      title: "TaskList",
      status: "done",
      at: 2,
    },
  });
  expect(text()).toBe("* Bash: make\n  failed: make\n* TaskList\n");
});

test("session text cannot drive the terminal", () => {
  const { text, event } = log();
  event({
    type: "item",
    item: {
      id: "u",
      type: "user",
      text: "a\u001b[2Jb\rc\u0007\td\u009b1m",
      at: 1,
    },
  });
  expect(text()).toBe("\n> a[2Jbc\td1m\n");
});

test("the end of the session is announced once", () => {
  const { text, event } = log();
  const info = {
    pane_id: "w1:p1",
    kind: "claude" as const,
    status: "exited" as const,
    cwd: "/",
    started_at: 1,
    modes: [],
    error: "claude exited with code 1",
  };
  event({ type: "info", info: { ...info, status: "idle", error: undefined } });
  event({ type: "info", info });
  event({ type: "info", info });
  expect(text()).toBe("! agent exited: claude exited with code 1\n");
});
