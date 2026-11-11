import { expect, test } from "bun:test";
import type { AgentItem } from "../../../shared/agentSession";
import {
  CodexAdapter,
  codexItem,
  parseCodexArgs,
  unwrapShellCommand,
} from "./codex";
import { fakeAgent, loadFixture, sessionStore, settle } from "./test-support";
import { SessionMirror } from "./transcript";

function start(args: string[] = []) {
  const agent = fakeAgent();
  const { store, events } = sessionStore("codex");
  const exits: (string | undefined)[] = [];
  const adapter = new CodexAdapter({
    store,
    cwd: "/work",
    args,
    env: {},
    spawn: agent.spawn,
    onExit: (error) => exits.push(error),
  });
  adapter.start();
  return { agent, adapter, store, events, exits };
}

/** Start a session and answer `initialize` and `thread/start`. */
async function ready(args: string[] = []) {
  const session = start(args);
  const { agent } = session;
  agent.say({ id: 1, result: { userAgent: "codex" } });
  await settle();
  agent.say({
    id: 2,
    result: {
      thread: { id: "thread-1" },
      model: "gpt-test",
      cwd: "/work",
      approvalPolicy: "on-request",
    },
  });
  await settle();
  return session;
}

const tools = (items: AgentItem[]) =>
  items.filter((item) => item.type === "tool");

/**
 * Replay a recorded session: the server's lines are fed in, and at each line
 * the host wrote the matching action is taken and must write that line.
 */
async function replay(name: string, session: ReturnType<typeof start>) {
  const { agent, adapter } = session;
  const failures: unknown[] = [];
  let cursor = 0;
  for (const { direction, message } of loadFixture(name)) {
    if (direction === "out") {
      agent.say(message);
      await settle();
      continue;
    }
    if (message.method === "turn/start" || message.method === "turn/steer") {
      // A mode chosen with set_mode is not a line of its own: it shows as
      // the approval policy of the next turn.
      if (message.params.approvalPolicy)
        await adapter.setMode(message.params.approvalPolicy);
      void adapter
        .send(message.params.input[0].text)
        .catch((e) => failures.push(e));
    } else if (message.method === "turn/interrupt") {
      void adapter.interrupt().catch((e) => failures.push(e));
    } else if (message.result) {
      const approval = session.store.approval(`codex-${message.id}`)!;
      const decision = message.result.decision;
      const kind =
        decision === "accept"
          ? "allow"
          : decision === "cancel" || decision === "decline"
            ? "deny"
            : "allow_always";
      void adapter
        .approve(approval.id, approval.options.find((o) => o.kind === kind)!.id)
        .catch((e) => failures.push(e));
    }
    await settle();
    expect(agent.written[cursor++]).toEqual(message);
  }
  expect(agent.written).toHaveLength(cursor);
  expect(failures).toEqual([]);
}

test("codex options map to app-server arguments and thread settings", () => {
  expect(
    parseCodexArgs([
      "-m",
      "gpt-x",
      "--sandbox=workspace-write",
      "-a",
      "never",
      "-c",
      "model_reasoning_effort=high",
      "--enable",
      "web_search",
      "-C",
      "/repo",
    ]),
  ).toEqual({
    serverArgs: ["-c", "model_reasoning_effort=high", "--enable", "web_search"],
    thread: {
      model: "gpt-x",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      cwd: "/repo",
    },
  });
  expect(parseCodexArgs(["--yolo"]).thread).toEqual({
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  expect(parseCodexArgs([])).toEqual({ serverArgs: [], thread: {} });
  // Options without an app-server counterpart are refused, not dropped.
  expect(() => parseCodexArgs(["--search"])).toThrow("does not support");
  expect(() => parseCodexArgs(["resume", "abc"])).toThrow("does not support");
  expect(() => parseCodexArgs(["-s", "open"])).toThrow("unknown sandbox");
  expect(() => parseCodexArgs(["-a"])).toThrow("needs a value");
});

test("the shell wrapper around a command is removed", () => {
  expect(unwrapShellCommand("/bin/bash -lc 'cat hello.txt'")).toBe(
    "cat hello.txt",
  );
  expect(unwrapShellCommand('bash -lc "ls -la"')).toBe("ls -la");
  expect(unwrapShellCommand("/usr/bin/zsh -c 'a && b'")).toBe("a && b");
  // Quoting that cannot be undone by eye stays as written.
  expect(unwrapShellCommand(`bash -lc 'echo '\\''hi'\\'''`)).toBe(
    `'echo '\\''hi'\\'''`,
  );
  expect(unwrapShellCommand("git status")).toBe("git status");
});

test("thread items map to transcript items", () => {
  expect(
    codexItem(
      {
        type: "fileChange",
        id: "f1",
        status: "completed",
        changes: [
          { path: "/work/new.txt", kind: { type: "add" }, diff: "hi\n" },
          {
            path: "/work/old.txt",
            kind: { type: "update", move_path: null },
            diff: "--- a/old.txt\n+++ b/old.txt\n@@ -1 +1 @@\n-a\n+b\n",
          },
          { path: "/work/gone.txt", kind: { type: "delete" }, diff: "bye\n" },
        ],
      },
      "/work",
    ),
  ).toEqual({
    id: "f1",
    type: "tool",
    kind: "edit",
    name: "apply_patch",
    title: "new.txt (+2 more)",
    status: "done",
    diffs: [
      { path: "/work/new.txt", patch: "@@ -0,0 +1,1 @@\n+hi" },
      { path: "/work/old.txt", patch: "@@ -1 +1 @@\n-a\n+b" },
      { path: "/work/gone.txt", patch: "@@ -1,1 +0,0 @@\n-bye" },
    ],
  });
  expect(
    codexItem(
      {
        type: "commandExecution",
        id: "c1",
        command: "/bin/bash -lc 'npm test'",
        status: "completed",
        commandActions: [{ type: "unknown", command: "npm test" }],
        aggregatedOutput: "1 failing\n",
        exitCode: 1,
      },
      "/work",
    ),
  ).toMatchObject({
    kind: "command",
    name: "shell",
    title: "npm test",
    command: "npm test",
    status: "failed",
    output: "1 failing\n",
  });
  expect(
    codexItem(
      {
        type: "mcpToolCall",
        id: "m1",
        server: "docs",
        tool: "search",
        status: "completed",
        arguments: { query: "x" },
        result: { content: [{ type: "text", text: "found" }] },
        error: null,
      },
      "/work",
    ),
  ).toMatchObject({
    kind: "other",
    name: "docs.search",
    title: "docs: search",
    status: "done",
    input: '{\n  "query": "x"\n}',
    output: "found",
  });
  expect(
    codexItem(
      { type: "commandExecution", id: "c2", command: "x", status: "declined" },
      "/work",
    ),
  ).toMatchObject({ status: "denied" });
  expect(
    codexItem(
      { type: "reasoning", id: "r", summary: ["a", "b"], content: [] },
      "/work",
    ),
  ).toEqual({ id: "r", type: "thinking", text: "a\n\nb", streaming: false });
  expect(
    codexItem({ type: "reasoning", id: "r", summary: [] }, "/work"),
  ).toBeNull();
  expect(codexItem({ type: "hookPrompt", id: "h" }, "/work")).toBeNull();
});

test("a recorded session replays into the same transcript", async () => {
  const session = start(["-a", "untrusted", "-s", "read-only"]);
  const { store, events, agent } = session;
  expect(agent.argv).toEqual(["codex", "app-server"]);
  const mirror = new SessionMirror(store.snapshot());
  await replay("codex-session", session);
  const { info, items, approvals } = store.snapshot();

  expect(info).toMatchObject({
    status: "idle",
    kind: "codex",
    cwd: "/work",
    model: "gpt-6-astra",
    // Chosen with set_mode in the recording; it holds from the next turn.
    mode: "untrusted",
    usage: { context_window: 258400 },
  });
  expect(info.agent_session_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(info.modes.map((mode) => mode.id)).toEqual([
    "untrusted",
    "on-request",
    "never",
  ]);
  expect(approvals).toEqual([]);

  // Codex lists each prompt as an item; the host's own are shown once.
  expect(items.filter((item) => item.type === "user")).toHaveLength(3);
  const [patch, cat, touch] = tools(items);
  expect(patch).toMatchObject({
    kind: "edit",
    name: "apply_patch",
    title: "notes.txt",
    status: "done",
    diffs: [
      { path: "/work/notes.txt", patch: "@@ -0,0 +1,2 @@\n+alpha\n+beta" },
    ],
  });
  expect(cat).toMatchObject({
    kind: "read",
    name: "shell",
    command: "cat notes.txt",
    status: "done",
    output: "alpha\nbeta\n",
  });
  expect(touch).toMatchObject({
    command: "touch denied.txt",
    status: "denied",
  });
  const texts = items.filter((item) => item.type === "assistant");
  expect(texts.length).toBeGreaterThanOrEqual(3);
  expect(texts.every((item) => !item.streaming)).toBe(true);
  expect(
    items.filter((item) => item.type === "notice").map((item) => item.text),
  ).toEqual(["Interrupted."]);

  const asked = events.flatMap((event) =>
    event.type === "approval" ? [event.approval] : [],
  );
  expect(asked.map((approval) => [approval.title, approval.item_id])).toEqual([
    ["Edit: notes.txt", patch!.id],
    ["Run: cat notes.txt", cat!.id],
    ["Run: touch denied.txt", touch!.id],
  ]);
  expect(asked[1]!.options).toEqual([
    { id: "allow", label: "Allow", kind: "allow" },
    {
      id: "allow_always",
      label: "Always allow cat notes.txt",
      kind: "allow_always",
    },
    { id: "deny", label: "Deny", kind: "deny" },
  ]);
  const statuses = events.flatMap((event) =>
    event.type === "info" ? [event.info.status] : [],
  );
  expect(statuses).toContain("awaiting_approval");
  expect(statuses.at(-1)).toBe("idle");
  expect(events.some((event) => event.type === "delta")).toBe(true);
  for (const event of events) expect(mirror.apply(event)).toBe(true);
  expect(mirror.snapshot()).toEqual(store.snapshot());
  agent.exit();
});

test("a prompt during a turn steers it, and an abandoned answer stops streaming", async () => {
  const session = start(["-a", "untrusted", "-s", "read-only"]);
  await replay("codex-steer", session);
  const { items, info } = session.store.snapshot();
  expect(
    session.agent.written
      .filter((message) => message.method?.startsWith("turn/"))
      .map((message) => message.method),
  ).toEqual(["turn/start", "turn/start", "turn/steer", "turn/interrupt"]);
  expect(
    items.filter((item) => item.type === "user").map((item) => item.text),
  ).toEqual([
    expect.stringContaining("hello.txt"),
    expect.stringContaining("numbers 1 to 80"),
    "Actually stop at 40.",
  ]);
  // The answer the steer cut short and the interrupted one both ended.
  const texts = items.filter((item) => item.type === "assistant");
  expect(texts.length).toBeGreaterThanOrEqual(4);
  expect(texts.every((item) => !item.streaming)).toBe(true);
  expect(info.status).toBe("idle");
  session.agent.exit();
});

test("the session is ready once the thread exists", async () => {
  const session = start(["-m", "gpt-x", "-c", "a=b"]);
  const { agent, store, adapter } = session;
  expect(agent.argv).toEqual(["codex", "app-server", "-c", "a=b"]);
  expect(agent.written[0]).toMatchObject({ id: 1, method: "initialize" });
  await expect(adapter.send("early")).rejects.toThrow("still starting");
  agent.say({ id: 1, result: {} });
  await settle();
  expect(agent.written.slice(1)).toEqual([
    { method: "initialized" },
    { id: 2, method: "thread/start", params: { cwd: "/work", model: "gpt-x" } },
  ]);
  expect(store.info.status).toBe("starting");
  agent.say({
    id: 2,
    result: { thread: { id: "t1" }, model: "gpt-x", approvalPolicy: "never" },
  });
  await settle();
  expect(store.info).toMatchObject({
    status: "idle",
    agent_session_id: "t1",
    model: "gpt-x",
    mode: "never",
  });
  agent.exit();
});

test("a chosen approval policy rides on the next turn", async () => {
  const { agent, adapter, store } = await ready();
  await expect(adapter.setMode("sometimes")).rejects.toThrow("unknown mode");
  await adapter.setMode("never");
  expect(store.info.mode).toBe("never");
  const sent = adapter.send("go");
  await settle();
  expect(agent.written.at(-1)).toEqual({
    id: 3,
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "go", text_elements: [] }],
      approvalPolicy: "never",
    },
  });
  agent.say({ id: 3, result: { turn: { id: "turn-1" } } });
  await sent;
  agent.say({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    },
  });
  // Sent once: later turns keep what the thread now has.
  const next = adapter.send("again");
  await settle();
  expect(agent.written.at(-1)!.params.approvalPolicy).toBeUndefined();
  agent.say({ id: 4, result: { turn: { id: "turn-2" } } });
  await next;
  agent.exit();
});

test("a steer that loses the race starts the next turn instead", async () => {
  const { agent, adapter, store } = await ready();
  const first = adapter.send("one");
  await settle();
  agent.say({ id: 3, result: { turn: { id: "turn-1" } } });
  await first;
  const second = adapter.send("two");
  await settle();
  expect(agent.written.at(-1)).toMatchObject({
    method: "turn/steer",
    params: { expectedTurnId: "turn-1" },
  });
  // The turn completes before the steer is answered: no idle in between.
  agent.say({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    },
  });
  expect(store.info.status).toBe("running");
  agent.say({ id: 4, error: { code: -32600, message: "no active turn" } });
  await settle();
  expect(agent.written.at(-1)).toMatchObject({ id: 5, method: "turn/start" });
  agent.say({ id: 5, result: { turn: { id: "turn-2" } } });
  await second;
  agent.say({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed" },
    },
  });
  expect(store.info.status).toBe("idle");
  expect(store.snapshot().items.some((item) => item.type === "notice")).toBe(
    false,
  );
  agent.exit();
});

test("a prompt that cannot be delivered says so and leaves the session idle", async () => {
  const { agent, adapter, store } = await ready();
  const sent = adapter.send("go");
  await settle();
  agent.say({ id: 3, error: { code: -32000, message: "usage limit reached" } });
  await expect(sent).rejects.toThrow("usage limit reached");
  expect(store.info.status).toBe("idle");
  expect(store.snapshot().items.at(-1)).toMatchObject({
    type: "notice",
    level: "error",
    text: "The prompt was not delivered: usage limit reached",
  });
  await adapter.interrupt();
  expect(agent.written.at(-1)!.method).toBe("turn/start");
  agent.exit();
});

test("sub-agent threads and unknown requests stay out of the transcript", async () => {
  const { agent, adapter, store } = await ready();
  const sent = adapter.send("go");
  await settle();
  agent.say({ id: 3, result: { turn: { id: "turn-1" } } });
  await sent;
  agent.say({
    method: "item/agentMessage/delta",
    params: {
      threadId: "other-thread",
      turnId: "x",
      itemId: "sub",
      delta: "sub-agent text",
    },
  });
  agent.say({
    method: "item/completed",
    params: {
      threadId: "other-thread",
      item: { type: "agentMessage", id: "sub2", text: "sub-agent answer" },
    },
  });
  expect(store.snapshot().items.map((item) => item.type)).toEqual(["user"]);
  agent.say({ id: 70, method: "attestation/generate", params: {} });
  expect(agent.written.at(-1)).toEqual({
    id: 70,
    error: { code: -32601, message: "attestation/generate is not supported" },
  });
  agent.say({
    id: 71,
    method: "mcpServer/elicitation/request",
    params: { threadId: "thread-1" },
  });
  expect(agent.written.at(-1)).toEqual({
    id: 71,
    result: { action: "decline", content: null, _meta: null },
  });
  expect(store.approvals).toEqual([]);
  agent.exit();
});

test("plans, usage, permission requests and failures are shown", async () => {
  const { agent, adapter, store } = await ready();
  const sent = adapter.send("go");
  await settle();
  agent.say({ id: 3, result: { turn: { id: "turn-1" } } });
  await sent;
  agent.say({
    method: "turn/plan/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "inProgress" },
        { step: "Test", status: "pending" },
      ],
    },
  });
  agent.say({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      tokenUsage: {
        total: { totalTokens: 900, outputTokens: 40 },
        last: { totalTokens: 500, outputTokens: 10 },
        modelContextWindow: 1000,
      },
    },
  });
  agent.say({
    id: 9,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "none",
      reason: "needs the network",
      permissions: { network: { enabled: true }, fileSystem: null },
    },
  });
  expect(store.info.status).toBe("awaiting_approval");
  expect(store.approvals[0]).toMatchObject({
    id: "codex-9",
    title: "Grant additional permissions",
    options: [
      { id: "allow", kind: "allow" },
      { id: "allow_session", kind: "allow_always" },
      { id: "deny", kind: "deny" },
    ],
  });
  await adapter.approve("codex-9", "allow_session");
  expect(agent.written.at(-1)).toEqual({
    id: 9,
    result: { permissions: { network: { enabled: true } }, scope: "session" },
  });
  agent.say({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: true,
      error: { message: "stream dropped." },
    },
  });
  agent.say({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "failed",
        error: { message: "model overloaded" },
      },
    },
  });
  const { items, info } = store.snapshot();
  expect(items.find((item) => item.type === "plan")).toMatchObject({
    id: "plan-turn-1",
    entries: [
      { text: "Inspect", status: "done" },
      { text: "Patch", status: "in_progress" },
      { text: "Test", status: "pending" },
    ],
  });
  expect(info.usage).toEqual({
    context_tokens: 500,
    context_window: 1000,
    output_tokens: 40,
  });
  expect(
    items
      .filter((item) => item.type === "notice")
      .map((item) => [item.level, item.text]),
  ).toEqual([
    ["info", "stream dropped. Retrying."],
    ["error", "model overloaded"],
  ]);
  expect(info.status).toBe("idle");
  agent.exit();
});

test("a crash or a thread that never starts ends the session with the reason", async () => {
  const crashed = await ready();
  const sent = crashed.adapter.send("go");
  await settle();
  crashed.agent.exit({ code: null, signal: "SIGKILL", stderr: "" });
  await expect(sent).rejects.toThrow("exited");
  expect(crashed.store.info).toMatchObject({
    status: "exited",
    error: "codex was killed by SIGKILL",
  });
  expect(crashed.exits).toEqual(["codex was killed by SIGKILL"]);

  const refused = start();
  refused.agent.say({
    id: 1,
    error: { code: -32000, message: "not logged in" },
  });
  await settle();
  expect(refused.agent.killed).toEqual(["SIGTERM"]);
  refused.agent.exit({ code: null, signal: "SIGTERM" });
  expect(refused.store.info).toMatchObject({
    status: "exited",
    error: "codex did not start a thread: not logged in",
  });
});
