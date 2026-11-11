import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import type { AgentSessionEvent } from "../../../shared/agentSession";
import { silentLogger } from "../utils/logger";
import { type AgentHost, startAgentHost } from "./host";
import { agentSocketName, agentSocketPath, herdrSocketKey } from "./paths";
import {
  createAgentSessionRelay,
  type VerifyAgentPane,
  verifyPaneWithHerdr,
} from "./relay";
import {
  fakeAgent,
  leaveDeadSocket,
  settle,
  socketRoot,
  storedClaude,
  until,
} from "./test-support";

const HERDR = "/nonexistent/herdr.sock";
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function root() {
  const dir = socketRoot();
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function host(
  dir: string,
  paneId: string,
  herdrSocketPath = HERDR,
  env: Record<string, string> = {},
) {
  const agent = fakeAgent();
  const started = await startAgentHost({
    kind: "claude",
    args: [],
    paneId,
    herdrSocketPath,
    cwd: "/work",
    socketDir: dir,
    env,
    spawn: agent.spawn,
  });
  agent.hooks.onKill = (child, signal) =>
    queueMicrotask(() => child.exit({ code: null, signal }));
  cleanups.push(() => started.shutdown());
  agent.say({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: agent.written[0]!.request_id,
      response: { current_permission_mode: "default" },
    },
  });
  await settle();
  return { host: started as AgentHost, agent };
}

function relay(
  dir: string,
  options: {
    herdr?: () => string | null;
    now?: () => number;
    verifyPane?: VerifyAgentPane;
  } = {},
) {
  const events: AgentSessionEvent[] = [];
  let changes = 0;
  const created = createAgentSessionRelay({
    dir,
    herdrSocketPath: options.herdr ?? (() => HERDR),
    logger: silentLogger,
    onEvent: (event) => events.push(event),
    onChanged: () => {
      changes += 1;
    },
    scanIntervalMs: 20,
    now: options.now,
    verifyPane: options.verifyPane,
  });
  cleanups.push(() => created.stop());
  created.start();
  return { relay: created, events, changes: () => changes };
}

test("hosts are found whether they start before or after the bridge", async () => {
  const dir = root();
  const early = await host(dir, "w1:p1");
  const { relay: bridge, changes } = relay(dir);
  await until(() => bridge.list().length === 1, "the early host");
  expect(bridge.list()[0]).toMatchObject({
    pane_id: "w1:p1",
    kind: "claude",
    status: "idle",
  });
  const seen = changes();
  await host(dir, "w2:p7");
  await until(() => bridge.list().length === 2, "the late host");
  expect(changes()).toBeGreaterThan(seen);
  expect(bridge.snapshot("w2:p7")).toMatchObject({
    info: { pane_id: "w2:p7" },
    items: [],
  });
  expect(bridge.snapshot("w9:p9")).toBeNull();
  expect(early.host.store.snapshot()).toEqual(bridge.snapshot("w1:p1")!);
});

test("events keep the bridge's copy current and reach it in order", async () => {
  const dir = root();
  const { host: session, agent } = await host(dir, "w1:p1");
  const { relay: bridge, events, changes } = relay(dir);
  await until(() => bridge.list().length === 1, "the host");
  const before = changes();
  await bridge.act("w1:p1", { action: "send", text: "hello" });
  expect(agent.written.at(-1)).toMatchObject({
    type: "user",
    message: { content: "hello" },
  });
  agent.say({
    type: "stream_event",
    event: { type: "message_start", message: { id: "m1" } },
  });
  agent.say({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  });
  agent.say({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hi" },
    },
  });
  agent.say({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  });
  agent.say({ type: "result", subtype: "success", is_error: false });
  await until(
    () => bridge.snapshot("w1:p1")?.info.status === "idle" && events.length > 3,
    "the turn",
  );
  expect(bridge.snapshot("w1:p1")).toEqual(session.store.snapshot());
  expect(bridge.snapshot("w1:p1")!.items).toMatchObject([
    { type: "user", text: "hello" },
    { type: "assistant", text: "Hi", streaming: false },
  ]);
  const seqs = events.map((event) => event.seq);
  expect(seqs).toEqual(seqs.map((_, index) => seqs[0]! + index));
  // Status changes (running, idle) are announced; other events are not.
  expect(changes() - before).toBe(2);
});

test("a host's refusal comes back as the action's error", async () => {
  const dir = root();
  await host(dir, "w1:p1");
  const { relay: bridge } = relay(dir);
  await until(() => bridge.list().length === 1, "the host");
  await expect(
    bridge.act("w1:p1", { action: "set_mode", mode: "bogus" }),
  ).rejects.toThrow("unknown mode: bogus");
  await expect(bridge.act("w3:p3", { action: "interrupt" })).rejects.toThrow(
    "no agent session in this pane",
  );
});

test("what an action answers comes back, and a host from before it is not asked", async () => {
  const dir = root();
  // The host's CLI configuration holds one stored conversation.
  const config = join(dir, "claude");
  mkdirSync(join(config, "projects", "-work"), { recursive: true });
  const stored = storedClaude();
  stored.prompt("remember mango");
  stored.says("m1", [{ type: "text", text: "ok" }]);
  writeFileSync(
    join(config, "projects", "-work", "abc-1.jsonl"),
    stored.text(),
  );
  const { agent } = await host(dir, "w1:p1", HERDR, {
    CLAUDE_CONFIG_DIR: config,
  });

  // A host of an older build greets without `can_resume`, and would never
  // answer an action it does not know. The build after it resumes but still
  // drops a prompt's images.
  const received: string[] = [];
  const olderHost = async (paneId: string, has: { can_resume?: true }) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.on("data", (chunk) => received.push(String(chunk)));
      socket.write(
        `${JSON.stringify({
          type: "hello",
          protocol: 1,
          pane_id: paneId,
          herdr_socket: HERDR,
          pid: 1,
          snapshot: {
            info: {
              pane_id: paneId,
              kind: "claude",
              status: "idle",
              cwd: "/",
              started_at: 1,
              modes: [],
              ...has,
            },
            items: [],
            approvals: [],
            seq: 0,
          },
        })}\n`,
      );
    });
    cleanups.push(() => void server.close());
    await new Promise<void>((resolve) =>
      server.listen(
        join(dir, agentSocketName(herdrSocketKey(HERDR), paneId)),
        resolve,
      ),
    );
  };
  await olderHost("w1:p2", {});
  await olderHost("w1:p3", { can_resume: true });

  const { relay: bridge, events } = relay(dir);
  await until(() => bridge.list().length === 3, "every host");
  expect(
    bridge.list().map((info) => [info.pane_id, info.can_resume === true]),
  ).toContainEqual(["w1:p1", true]);
  expect(await bridge.act("w1:p1", { action: "interrupt" })).toBeUndefined();
  expect(await bridge.act("w1:p1", { action: "history" })).toEqual([
    { id: "abc-1", title: "remember mango", updated_at: expect.any(Number) },
  ]);
  await bridge.act("w1:p1", { action: "resume", session_id: "abc-1" });
  await until(
    () => events.some((event) => event.type === "reset"),
    "the reset event",
  );
  // The bridge's copy was reset with the host's transcript.
  expect(bridge.snapshot("w1:p1")!.items.map((item) => item.type)).toEqual([
    "user",
    "assistant",
  ]);
  expect(bridge.snapshot("w1:p1")!.info.agent_session_id).toBe("abc-1");
  expect(agent.children).toHaveLength(2);
  await expect(
    bridge.act("w1:p1", { action: "resume", session_id: "../x" }),
  ).rejects.toThrow("not a conversation ID");

  for (const action of [
    { action: "history" },
    { action: "resume", session_id: "abc-1" },
    { action: "set_model", model: "m" },
    { action: "set_effort", effort: "high" },
    { action: "compact" },
    { action: "unqueue", prompt_id: "q1" },
    { action: "send", text: "x", delivery: "queue" },
    { action: "send", text: "x", delivery: "interrupt" },
  ] as const)
    await expect(bridge.act("w1:p2", action)).rejects.toThrow(
      "started by an older Thyra",
    );
  // Nor going back or branching, before hosts said they do.
  for (const pane of ["w1:p2", "w1:p3"])
    for (const action of [
      { action: "rewind", item_id: "u1" },
      { action: "fork" },
    ] as const)
      await expect(bridge.act(pane, action)).rejects.toThrow(
        "this agent session was started by an older Thyra and cannot go back or branch; start a new one",
      );
  // Nor a prompt with images, which it would send without them.
  await expect(
    bridge.act("w1:p2", {
      action: "send",
      text: "look",
      images: [{ path: "/tmp/a.png" }],
    }),
  ).rejects.toThrow(
    "this agent session was started by an older Thyra and cannot take images; start a new one",
  );
  await expect(
    bridge.act("w1:p3", {
      action: "send",
      text: "look",
      images: [{ path: "/tmp/a.png" }],
    }),
  ).rejects.toThrow("cannot take images");
  // Its other actions still reach it, a prompt without images among them.
  void bridge.act("w1:p2", { action: "interrupt" }).catch(() => undefined);
  void bridge
    .act("w1:p2", { action: "send", text: "plain" })
    .catch(() => undefined);
  await until(
    () => received.join("").includes("plain"),
    "the old host's actions",
  );
  expect(received.join("")).not.toMatch(/history|resume|images/);
});

test("a session ends when its host goes away", async () => {
  const dir = root();
  const { host: session } = await host(dir, "w1:p1");
  const { relay: bridge, changes } = relay(dir);
  await until(() => bridge.list().length === 1, "the host");
  const before = changes();
  // An action still waiting for the agent fails instead of hanging.
  const pending = bridge
    .act("w1:p1", { action: "set_mode", mode: "plan" })
    .then(
      () => null,
      (error: Error) => error.message,
    );
  await session.shutdown();
  expect(await pending).toBeString();
  await until(() => bridge.list().length === 0, "the session to end");
  expect(changes()).toBeGreaterThan(before);
  expect(bridge.snapshot("w1:p1")).toBeNull();
});

test("a restarted bridge picks every session up again", async () => {
  const dir = root();
  const { host: session, agent } = await host(dir, "w1:p1");
  const first = relay(dir);
  await until(() => first.relay.list().length === 1, "the host");
  await first.relay.act("w1:p1", { action: "send", text: "before restart" });
  first.relay.stop();
  expect(first.relay.list()).toEqual([]);
  // The host keeps working while no bridge is connected.
  agent.say({ type: "result", subtype: "success", is_error: false });
  const second = relay(dir);
  await until(() => second.relay.list().length === 1, "the host again");
  expect(second.relay.snapshot("w1:p1")).toEqual(session.store.snapshot());
  expect(second.relay.snapshot("w1:p1")).toMatchObject({
    info: { status: "idle" },
    items: [{ type: "user", text: "before restart" }],
  });
});

test("only the served Herdr's panes are sessions", async () => {
  const dir = root();
  await host(dir, "w1:p1", "/other/herdr.sock");
  await host(dir, "w1:p1");
  let served: string | null = HERDR;
  const { relay: bridge } = relay(dir, { herdr: () => served });
  await until(() => bridge.list().length === 1, "the host");
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(bridge.list()).toHaveLength(1);
  // The default connection moved to another Herdr: its sessions replace these.
  served = "/other/herdr.sock";
  await until(
    () => bridge.list().length === 1 && bridge.snapshot("w1:p1") !== null,
    "the other Herdr's host",
  );
  served = null;
  await until(() => bridge.list().length === 0, "no sessions");
});

test("a dead host's socket is removed once it is old enough", async () => {
  const dir = root();
  const stale = agentSocketPath(dir, HERDR, "w4:p4");
  leaveDeadSocket(stale);
  let now = Date.now();
  const { relay: bridge } = relay(dir, { now: () => now });
  await new Promise((resolve) => setTimeout(resolve, 100));
  // It may be a host between bind and listen: left alone at first.
  expect(existsSync(stale)).toBe(true);
  expect(bridge.list()).toEqual([]);
  now += 60_000;
  await until(() => !existsSync(stale), "the stale socket to go");
});

test("a host that lies about its pane or talks nonsense is dropped", async () => {
  const dir = root();
  const key = herdrSocketKey(HERDR);
  const servers: net.Server[] = [];
  cleanups.push(() => {
    for (const server of servers) server.close();
  });
  const serve = (pane: string, greeting: string) =>
    new Promise<void>((resolve) => {
      const server = net.createServer((socket) => {
        socket.on("error", () => undefined);
        socket.write(greeting);
      });
      servers.push(server);
      server.listen(join(dir, agentSocketName(key, pane)), resolve);
    });
  const snapshot = (pane: string) => ({
    info: {
      pane_id: pane,
      kind: "claude",
      status: "idle",
      cwd: "/",
      started_at: 1,
      modes: [],
    },
    items: [],
    approvals: [],
    seq: 0,
  });
  const hello = (pane: string, herdr = HERDR, protocol = 1) =>
    `${JSON.stringify({ type: "hello", protocol, pane_id: pane, herdr_socket: herdr, pid: 1, snapshot: snapshot(pane) })}\n`;
  await serve("w1:p1", hello("w1:p2"));
  await serve("w1:p3", hello("w1:p3", "/other/herdr.sock"));
  await serve("w1:p4", hello("w1:p4", HERDR, 99));
  await serve("w1:p5", "garbage\n");
  await serve("w1:p6", hello("w1:p6"));
  await serve(
    "w1:p7",
    `${hello("w1:p7")}${JSON.stringify({ type: "event", event: { pane_id: "w1:p7", seq: 5, type: "approval_resolved", id: "x" } })}\n`,
  );
  const { relay: bridge, events } = relay(dir);
  await until(() => bridge.list().length >= 1, "the honest host");
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(bridge.list().map((info) => info.pane_id)).toContain("w1:p6");
  for (const pane of ["w1:p1", "w1:p2", "w1:p3", "w1:p4", "w1:p5"])
    expect(bridge.snapshot(pane)).toBeNull();
  // An event that skips ahead is never passed on.
  expect(events).toEqual([]);
});

test("a directory open to other users is not trusted", async () => {
  const dir = root();
  await host(dir, "w1:p1");
  chmodSync(dir, 0o755);
  const { relay: bridge } = relay(dir);
  // Starting the relay tightens a directory it owns; loosen it again.
  chmodSync(dir, 0o755);
  await new Promise((resolve) => setTimeout(resolve, 100));
  bridge.rescan();
  await until(() => bridge.list().length === 0, "no sessions");
  chmodSync(dir, 0o700);
  await until(() => bridge.list().length === 1, "the host");
});

test("a host is a session only once Herdr confirms it runs in its pane", async () => {
  const dir = root();
  const { host: session } = await host(dir, "w1:p1");
  let answer: boolean | null = null;
  const asked: [string, number][] = [];
  const {
    relay: bridge,
    events,
    changes,
  } = relay(dir, {
    verifyPane: async (paneId, pid) => {
      asked.push([paneId, pid]);
      return answer;
    },
  });
  // Herdr cannot be asked yet: the host is connected but not a session.
  await until(() => asked.length >= 2, "two checks");
  expect(asked[0]).toEqual(["w1:p1", process.pid]);
  expect(bridge.list()).toEqual([]);
  expect(bridge.snapshot("w1:p1")).toBeNull();
  await expect(bridge.act("w1:p1", { action: "interrupt" })).rejects.toThrow(
    "no agent session in this pane",
  );
  expect(changes()).toBe(0);
  answer = true;
  await until(() => bridge.list().length === 1, "the confirmed session");
  expect(bridge.snapshot("w1:p1")).toEqual(session.store.snapshot());
  expect(changes()).toBe(1);
  expect(events).toEqual([]);
});

test("a host outside its pane is dropped and its socket left alone", async () => {
  const dir = root();
  const { host: session } = await host(dir, "w1:p1");
  let inPane = true;
  let now = Date.now();
  const { relay: bridge } = relay(dir, {
    now: () => now,
    verifyPane: async () => inPane,
  });
  await until(() => bridge.list().length === 1, "the session");
  // The pane moved to another workspace: its ID now names nothing, or
  // another pane. The next periodic check ends the session.
  inPane = false;
  now += 60_000;
  await until(() => bridge.list().length === 0, "the session to end");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(bridge.list()).toEqual([]);
  // The host itself keeps running in its pane.
  expect(existsSync(session.socketPath)).toBe(true);
  expect(session.store.info.status).toBe("idle");
});

test("Herdr's process list decides whether a host is in its pane", async () => {
  const calls: unknown[] = [];
  let reply: () => unknown = () => ({
    process_info: {
      pane_id: "w1:p1",
      shell_pid: 10,
      foreground_processes: [
        { pid: 41, name: "thyra" },
        { pid: 42, name: "claude" },
      ],
    },
  });
  const verify = verifyPaneWithHerdr(async (method, params) => {
    calls.push([method, params]);
    return reply();
  });
  expect(await verify("w1:p1", 41)).toBe(true);
  expect(calls).toEqual([["pane.process_info", { pane_id: "w1:p1" }]]);
  // Another program is in the foreground: the pane is back at its shell.
  expect(await verify("w1:p1", 99)).toBe(false);
  reply = () => {
    throw new Error("pane_not_found: pane not found: w1:p1");
  };
  expect(await verify("w1:p1", 41)).toBe(false);
  // No answer is not a no.
  reply = () => {
    throw new Error("timeout: pane.process_info");
  };
  expect(await verify("w1:p1", 41)).toBeNull();
  reply = () => ({ process_info: { pane_id: "w1:p1" } });
  expect(await verify("w1:p1", 41)).toBeNull();
});
