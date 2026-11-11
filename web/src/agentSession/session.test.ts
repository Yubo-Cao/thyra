import { expect, test } from "bun:test";
import type {
  AgentItem,
  AgentSessionSnapshot,
} from "../../../shared/agentSession";
import type { AgentSessionTransport } from "../agentSessions";
import { connectAgentSession, createAgentSessionStore } from "./session";

const assistant = (text: string): AgentItem => ({
  id: "a1",
  at: 1,
  type: "assistant",
  text,
  streaming: true,
});

function snapshot(seq: number, text: string): AgentSessionSnapshot {
  return {
    info: {
      pane_id: "p1",
      kind: "codex",
      status: "running",
      cwd: "/work",
      started_at: 1,
      modes: [],
    },
    items: [assistant(text)],
    approvals: [],
    seq,
  };
}

/** A transport and scheduler the test drives by hand. */
function harness() {
  const calls: string[] = [];
  const replies: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  const listeners = new Set<(name: string, data: unknown) => void>();
  const frames: Array<() => void> = [];
  const timers: Array<{ task: () => void; ms: number }> = [];
  const transport: AgentSessionTransport = {
    call(method, params) {
      calls.push(`${method}:${String(params?.pane_id)}`);
      if (method !== "agent_session.subscribe") return Promise.resolve({});
      return new Promise((resolve, reject) =>
        replies.push({ resolve, reject }),
      );
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const store = createAgentSessionStore();
  const stop = connectAgentSession(transport, "p1", store, {
    frame(task) {
      frames.push(task);
      return () => frames.splice(frames.indexOf(task), 1);
    },
    timer(task, ms) {
      timers.push({ task, ms });
      return () => {};
    },
  });
  return {
    calls,
    store,
    stop,
    frames,
    timers,
    listeners,
    async reply(value: unknown) {
      replies.shift()?.resolve(value);
      await Promise.resolve();
    },
    async fail(message: string) {
      replies.shift()?.reject(new Error(message));
      await Promise.resolve();
    },
    delta(seq: number, text: string, paneId = "p1") {
      for (const listener of listeners)
        listener("agent_session.event", {
          pane_id: paneId,
          seq,
          type: "delta",
          id: "a1",
          text,
        });
    },
    frame() {
      for (const task of frames.splice(0)) task();
    },
    text() {
      const item = store.getState().session?.items.a1;
      return item?.type === "assistant" ? item.text : null;
    },
  };
}

test("events apply once per frame after the snapshot", async () => {
  const h = harness();
  expect(h.calls).toEqual(["agent_session.subscribe:p1"]);
  expect(h.store.getState().session).toBeNull();
  await h.reply(snapshot(5, "Hel"));
  expect(h.text()).toBe("Hel");
  let renders = 0;
  h.store.subscribe(() => renders++);
  h.delta(6, "lo");
  h.delta(7, " wor");
  h.delta(8, "ld");
  h.delta(9, "!", "other-pane");
  expect(h.frames).toHaveLength(1);
  expect(h.text()).toBe("Hel");
  h.frame();
  expect(h.text()).toBe("Hello world");
  expect(renders).toBe(1);
});

test("events that raced the snapshot are applied or skipped by sequence", async () => {
  const h = harness();
  h.delta(5, "l");
  h.delta(6, "lo");
  expect(h.frames).toHaveLength(0);
  // The snapshot already reflects event 5.
  await h.reply(snapshot(5, "Hel"));
  expect(h.text()).toBe("Hello");
});

test("a skipped sequence number subscribes again for a fresh snapshot", async () => {
  const h = harness();
  await h.reply(snapshot(5, "Hel"));
  h.delta(6, "lo");
  h.delta(8, "lost");
  h.frame();
  expect(h.text()).toBe("Hello");
  expect(h.calls).toEqual([
    "agent_session.subscribe:p1",
    "agent_session.subscribe:p1",
  ]);
  // Held until the snapshot arrives, then applied on top of it.
  h.delta(9, "!");
  expect(h.frames).toHaveLength(0);
  await h.reply(snapshot(8, "Hello there"));
  expect(h.text()).toBe("Hello there!");
});

test("a failed subscribe is reported and retried with a growing delay", async () => {
  const h = harness();
  await h.fail("no such session");
  expect(h.store.getState().error).toBe("no such session");
  expect(h.timers.map((timer) => timer.ms)).toEqual([1000]);
  h.timers[0].task();
  await h.fail("still starting");
  expect(h.timers.map((timer) => timer.ms)).toEqual([1000, 2000]);
  h.timers[1].task();
  await h.reply(snapshot(1, "Hi"));
  expect(h.store.getState()).toMatchObject({ error: null });
  expect(h.text()).toBe("Hi");
});

test("stopping unsubscribes and ignores what arrives later", async () => {
  const h = harness();
  h.stop();
  expect(h.calls[h.calls.length - 1]).toBe("agent_session.unsubscribe:p1");
  expect(h.listeners.size).toBe(0);
  await h.reply(snapshot(5, "late"));
  expect(h.store.getState().session).toBeNull();
});
