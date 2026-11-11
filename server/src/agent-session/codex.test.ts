import { expect, test } from "bun:test";
import type { AgentItem } from "../../../shared/agentSession";
import {
  CodexAdapter,
  codexArgsWithoutThread,
  codexItem,
  codexThreadItems,
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
  expect(() => parseCodexArgs(["-s", "open"])).toThrow("unknown sandbox");
  expect(() => parseCodexArgs(["-a"])).toThrow("needs a value");
});

test("resume takes a thread ID or --last, with options on either side", () => {
  expect(
    parseCodexArgs(["--yolo", "resume", "0a1b-2c3d", "-m", "gpt-x"]),
  ).toEqual({
    serverArgs: [],
    thread: {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "gpt-x",
    },
    resume: { id: "0a1b-2c3d" },
  });
  expect(parseCodexArgs(["resume", "-m", "gpt-x", "0a1b-2c3d"]).resume).toEqual(
    { id: "0a1b-2c3d" },
  );
  expect(parseCodexArgs(["resume", "--last", "-a", "never"])).toEqual({
    serverArgs: [],
    thread: { approvalPolicy: "never" },
    resume: { last: true },
  });
  // The terminal UI's picker: the page offers the list instead.
  expect(parseCodexArgs(["resume"])).toEqual({ serverArgs: [], thread: {} });
  expect(parseCodexArgs(["resume", "--yolo"]).resume).toBeUndefined();
  // Not an ID, a second thread, a prompt, or a flag of the terminal UI.
  expect(() => parseCodexArgs(["resume", "../x"])).toThrow("not a thread ID");
  expect(() => parseCodexArgs(["resume", "a1", "b2"])).toThrow(
    "does not support the argument b2",
  );
  expect(() => parseCodexArgs(["resume", "a1", "--last"])).toThrow(
    "does not support the argument --last",
  );
  expect(() => parseCodexArgs(["resume", "--all"])).toThrow("does not support");
  expect(() => parseCodexArgs(["--last"])).toThrow("does not support");
  expect(() => parseCodexArgs(["resume", "a1", "fork", "b2"])).toThrow(
    "does not support the argument fork",
  );
});

test("fork takes a thread ID and the turn the copy ends at", () => {
  expect(
    parseCodexArgs(["-m", "gpt-x", "fork", "a1", "--last-turn", "t-2"]),
  ).toEqual({
    serverArgs: [],
    thread: { model: "gpt-x" },
    fork: { id: "a1", lastTurn: "t-2" },
  });
  expect(parseCodexArgs(["fork", "a1", "--last-turn=t-2"]).fork).toEqual({
    id: "a1",
    lastTurn: "t-2",
  });
  expect(parseCodexArgs(["fork", "a1", "--yolo"]).fork).toEqual({ id: "a1" });
  expect(() => parseCodexArgs(["fork"])).toThrow("fork needs a thread ID");
  expect(() => parseCodexArgs(["fork", "--last"])).toThrow("needs a thread ID");
  expect(() => parseCodexArgs(["fork", "a1", "--last-turn", "-x"])).toThrow(
    "--last-turn needs a turn ID",
  );
  expect(() => parseCodexArgs(["--last-turn", "t1"])).toThrow(
    "does not support",
  );
  expect(() => parseCodexArgs(["fork", "a1", "resume", "b2"])).toThrow(
    "does not support the argument resume",
  );
  // What a copy starts with: everything but the choice of thread.
  expect(
    codexArgsWithoutThread([
      "-m",
      "x",
      "resume",
      "a1",
      "--yolo",
      "fork",
      "b2",
      "--last-turn",
      "t1",
      "--last-turn=t2",
    ]),
  ).toEqual(["-m", "x", "--yolo"]);
  expect(
    codexArgsWithoutThread(["resume", "--last", "-s", "read-only"]),
  ).toEqual(["-s", "read-only"]);
  expect(codexArgsWithoutThread(["resume", "-a", "never"])).toEqual([
    "-a",
    "never",
  ]);
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

test("a prompt's images go to Codex as local image input", async () => {
  const { agent, adapter, store } = await ready();
  const upload = (n: number) => ({
    path: `/tmp/herdr-img-179442179712${n}-${String(n).repeat(32)}.png`,
    mediaType: "image/png" as const,
  });
  const text = "what is in [Image #1] and [Image #2]?";
  const sent = adapter.send(text, [upload(1), upload(2)]);
  await settle();
  // Codex reads the files itself: the turn names them, after the text.
  expect(agent.written.at(-1)).toEqual({
    id: 3,
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [
        { type: "text", text, text_elements: [] },
        { type: "localImage", path: upload(1).path },
        { type: "localImage", path: upload(2).path },
      ],
    },
  });
  agent.say({ id: 3, result: { turn: { id: "turn-1" } } });
  await sent;
  const echo = (id: string, content: unknown[]) =>
    agent.say({
      method: "item/started",
      params: {
        threadId: "thread-1",
        item: { type: "userMessage", id, content },
      },
    });
  // Codex lists the prompt back with its images; it is the host's own.
  echo("um-1", [
    { type: "text", text, text_elements: [] },
    { type: "localImage", detail: null, path: upload(1).path },
    { type: "localImage", detail: null, path: upload(2).path },
  ]);
  expect(store.snapshot().items).toMatchObject([
    {
      id: "user-1",
      type: "user",
      text,
      images: [{ path: upload(1).path }, { path: upload(2).path }],
    },
  ]);
  expect(store.snapshot().items).toHaveLength(1);

  // During the turn a prompt with an image steers it like any other, and
  // with an image the text may be empty: no empty text item is sent.
  const steered = adapter.send("", [upload(3)]);
  await settle();
  expect(agent.written.at(-1)).toEqual({
    id: 4,
    method: "turn/steer",
    params: {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "localImage", path: upload(3).path }],
    },
  });
  agent.say({ id: 4, result: {} });
  await steered;
  echo("um-2", [{ type: "localImage", detail: null, path: upload(3).path }]);
  expect(store.snapshot().items).toHaveLength(2);
  expect(store.snapshot().items[1]).toMatchObject({
    id: "user-2",
    text: "",
    images: [{ path: upload(3).path }],
  });

  // A prompt from another client shows the images a page could have
  // attached, and no other file's path.
  echo("um-3", [
    { type: "text", text: "from the terminal UI", text_elements: [] },
    { type: "localImage", detail: null, path: upload(4).path },
    { type: "localImage", detail: null, path: "/home/user/secret.png" },
    { type: "image", url: "https://example.com/a.png" },
  ]);
  expect(store.snapshot().items[2]).toEqual({
    id: "um-3",
    type: "user",
    text: "from the terminal UI",
    images: [{ path: upload(4).path }],
    at: expect.any(Number),
  });
  // Without images a prompt is the text item it always was.
  const plain = adapter.send("plain");
  await settle();
  expect(agent.written.at(-1)!.params.input).toEqual([
    { type: "text", text: "plain", text_elements: [] },
  ]);
  agent.say({ id: agent.written.at(-1)!.id, result: {} });
  await plain;
  expect(store.snapshot().items.at(-1)).not.toHaveProperty("images");

  // A stored thread restores the same way.
  expect(
    codexThreadItems(
      [
        {
          id: "t1",
          status: "completed",
          startedAt: 1700000000,
          items: [
            {
              type: "userMessage",
              id: "u1",
              content: [
                { type: "localImage", path: upload(5).path },
                { type: "localImage", path: "/etc/passwd" },
              ],
            },
          ],
        },
      ],
      "/work",
    ),
  ).toEqual([
    {
      id: "u1",
      type: "user",
      text: "",
      images: [{ path: upload(5).path }],
      ref: "t1",
      at: 1700000000000,
    },
  ]);
  agent.exit();
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

/** Two stored turns as `thread/turns/list` returns them, newest first. */
const STORED_TURNS = [
  {
    id: "turn-2",
    status: "interrupted",
    startedAt: 1700000100,
    completedAt: 1700000109,
    items: [
      {
        type: "userMessage",
        id: "u2",
        startedAtMs: 1700000100500,
        content: [{ type: "text", text: "now deploy" }],
      },
      {
        type: "commandExecution",
        id: "c2",
        startedAtMs: 1700000101000,
        command: "/bin/bash -lc 'make deploy'",
        status: "inProgress",
        commandActions: [],
      },
    ],
  },
  {
    id: "turn-1",
    status: "completed",
    startedAt: 1700000000,
    completedAt: 1700000009,
    items: [
      {
        type: "userMessage",
        id: "u1",
        startedAtMs: 1700000000500,
        content: [{ type: "text", text: "remember mango" }],
      },
      { type: "reasoning", id: "r1", summary: [], content: [] },
      {
        type: "commandExecution",
        id: "c1",
        startedAtMs: 1700000002000,
        command: "/bin/bash -lc 'echo mango'",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "mango\n",
        commandActions: [],
      },
      {
        type: "fileChange",
        id: "f1",
        status: "completed",
        changes: [
          { path: "/work/a.txt", kind: { type: "add" }, diff: "mango" },
        ],
      },
      {
        type: "agentMessage",
        id: "a1",
        startedAtMs: 1700000004000,
        text: "I will remember mango.",
      },
    ],
  },
];

const RESTORED = [
  "user: remember mango",
  "shell[done] echo mango",
  "apply_patch[done] a.txt",
  "assistant: I will remember mango.",
  "user: now deploy",
  "shell[failed] make deploy",
  "notice: Interrupted.",
];

const lines = (items: AgentItem[]) =>
  items.map((item) =>
    item.type === "tool"
      ? `${item.name}[${item.status}] ${item.title}`
      : item.type === "plan"
        ? "plan"
        : `${item.type}: ${item.text}`,
  );

test("a stored thread's turns map like their notifications did", () => {
  const items = codexThreadItems(STORED_TURNS.toReversed(), "/work");
  expect(lines(items)).toEqual(RESTORED);
  // Items keep the time they started at; one without takes the last known.
  expect(items.map((item) => item.at)).toEqual([
    1700000000500, 1700000002000, 1700000002000, 1700000004000, 1700000100500,
    1700000101000, 1700000109000,
  ]);
  expect(items[1]).toMatchObject({ command: "echo mango", output: "mango\n" });
  expect(items[2]).toMatchObject({
    kind: "edit",
    diffs: [{ path: "/work/a.txt", patch: "@@ -0,0 +1,1 @@\n+mango" }],
  });
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);

  // A failed turn says why; one stopped by a denial shows the denial only.
  expect(
    lines(
      codexThreadItems(
        [
          {
            id: "t1",
            status: "failed",
            error: { message: "quota" },
            items: [],
          },
          {
            id: "t2",
            status: "interrupted",
            items: [
              {
                type: "commandExecution",
                id: "c9",
                command: "rm -rf /",
                status: "declined",
              },
            ],
          },
          { id: "t3", status: "inProgress", items: [{ type: "sleep" }] },
          "not a turn",
        ],
        "/work",
      ),
    ),
  ).toEqual(["notice: quota", "shell[denied] rm -rf /"]);

  // Older history has no times: items take the first one there is.
  const untimed = codexThreadItems(
    [
      {
        id: "t1",
        status: "completed",
        items: [{ type: "agentMessage", id: "a1", text: "early" }],
      },
      {
        id: "t2",
        status: "completed",
        startedAt: 1700000000,
        items: [{ type: "agentMessage", id: "a2", text: "later" }],
      },
    ],
    "/work",
  );
  expect(untimed.map((item) => item.at)).toEqual([
    1700000000000, 1700000000000,
  ]);
  const before = Date.now();
  const never = codexThreadItems(
    [{ id: "t1", items: [{ type: "agentMessage", id: "a1", text: "x" }] }],
    "/work",
  );
  expect(never[0]!.at).toBeGreaterThanOrEqual(before);
});

/** Answer the request written last. */
function answer(agent: ReturnType<typeof fakeAgent>, result: unknown) {
  agent.say({ id: agent.written.at(-1)!.id, result });
}

test("starting with resume continues the thread with the session's settings", async () => {
  const session = start(["--yolo", "-m", "gpt-x", "resume", "thread-9"]);
  const { agent, store, events } = session;
  agent.say({ id: 1, result: {} });
  await settle();
  // Its turns are read newest first, a page at a time.
  expect(agent.written.at(-1)).toEqual({
    id: 2,
    method: "thread/turns/list",
    params: {
      threadId: "thread-9",
      limit: 20,
      sortDirection: "desc",
      itemsView: "full",
    },
  });
  answer(agent, { data: [STORED_TURNS[0]], nextCursor: "page-2" });
  await settle();
  expect(agent.written.at(-1)!.params).toMatchObject({ cursor: "page-2" });
  answer(agent, { data: [STORED_TURNS[1]], nextCursor: null });
  await settle();
  // The arguments' overrides apply to the resumed thread too; without
  // `-C` it keeps the directory it was stored with.
  expect(agent.written.at(-1)).toEqual({
    id: 4,
    method: "thread/resume",
    params: {
      threadId: "thread-9",
      excludeTurns: true,
      model: "gpt-x",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  expect(store.info.status).toBe("starting");
  answer(agent, {
    thread: { id: "thread-9", turns: [] },
    model: "gpt-x",
    cwd: "/work",
    approvalPolicy: "never",
    sandbox: { type: "dangerFullAccess" },
  });
  await settle();
  expect(store.info).toMatchObject({
    status: "idle",
    agent_session_id: "thread-9",
    model: "gpt-x",
    mode: "never",
  });
  expect(lines(store.snapshot().items)).toEqual(RESTORED);
  expect(events.filter((event) => event.type === "reset")).toHaveLength(1);
  expect(agent.written.some((line) => line.method === "thread/start")).toBe(
    false,
  );

  // The next prompt goes to the resumed thread.
  const sent = session.adapter.send("and now?");
  await settle();
  expect(agent.written.at(-1)).toMatchObject({
    method: "turn/start",
    params: { threadId: "thread-9" },
  });
  answer(agent, { turn: { id: "turn-3" } });
  await sent;
  agent.exit();
});

test("resume --last continues the directory's newest thread, or starts one", async () => {
  const session = start(["resume", "--last", "-C", "/repo"]);
  const { agent, store } = session;
  agent.say({ id: 1, result: {} });
  await settle();
  // From Codex's index: repairing it from the rollout files takes too long.
  expect(agent.written.at(-1)).toEqual({
    id: 2,
    method: "thread/list",
    params: {
      cwd: "/repo",
      limit: 1,
      sortKey: "updated_at",
      sortDirection: "desc",
      useStateDbOnly: true,
    },
  });
  answer(agent, {
    data: [
      { id: "thread-7", preview: "remember mango", updatedAt: 1700000009 },
    ],
  });
  await settle();
  expect(agent.written.at(-1)).toMatchObject({
    method: "thread/turns/list",
    params: { threadId: "thread-7" },
  });
  // The thread resumes even when its earlier messages cannot be read.
  agent.say({
    id: agent.written.at(-1)!.id,
    error: { code: -32601, message: "unknown method" },
  });
  await settle();
  expect(agent.written.at(-1)).toEqual({
    id: 4,
    method: "thread/resume",
    params: { threadId: "thread-7", excludeTurns: true, cwd: "/repo" },
  });
  answer(agent, { thread: { id: "thread-7" }, cwd: "/repo" });
  await settle();
  expect(store.info).toMatchObject({
    status: "idle",
    agent_session_id: "thread-7",
    cwd: "/repo",
  });
  expect(lines(store.snapshot().items)).toEqual([
    "notice: The earlier messages of thread-7 could not be read (unknown method).",
  ]);
  agent.exit();

  const fresh = start(["resume", "--last"]);
  fresh.agent.say({ id: 1, result: {} });
  await settle();
  answer(fresh.agent, { data: [] });
  await settle();
  expect(fresh.agent.written.at(-1)).toEqual({
    id: 3,
    method: "thread/start",
    params: { cwd: "/work" },
  });
  answer(fresh.agent, { thread: { id: "thread-new" } });
  await settle();
  expect(fresh.store.info).toMatchObject({
    status: "idle",
    agent_session_id: "thread-new",
  });
  expect(lines(fresh.store.snapshot().items)).toEqual([
    "notice: No thread is stored for this directory; this is a new one.",
  ]);
  fresh.agent.exit();

  // A thread that cannot be resumed is a failed start.
  const refused = start(["resume", "thread-9"]);
  refused.agent.say({ id: 1, result: {} });
  await settle();
  answer(refused.agent, { data: [] });
  await settle();
  refused.agent.say({
    id: refused.agent.written.at(-1)!.id,
    error: {
      code: -32600,
      message: "thread thread-9 already has an active writer",
    },
  });
  await settle();
  refused.agent.exit({ code: null, signal: "SIGTERM" });
  expect(refused.store.info).toMatchObject({
    status: "exited",
    error:
      "codex did not start a thread: thread thread-9 already has an active writer",
  });
});

test("history lists the directory's threads without the session's own", async () => {
  const early = start();
  await expect(early.adapter.history()).rejects.toThrow("still starting");
  early.agent.exit();

  const { agent, adapter } = await ready();
  const listed = adapter.history();
  await settle();
  expect(agent.written.at(-1)).toMatchObject({
    method: "thread/list",
    params: { cwd: "/work", limit: 31, useStateDbOnly: true },
  });
  answer(agent, {
    data: [
      { id: "thread-1", preview: "the session's own", updatedAt: 1700000300 },
      { id: "t-named", name: "Fix login", preview: "p", updatedAt: 1700000200 },
      {
        id: "t-plain",
        name: null,
        preview: "first prompt\nmore",
        updatedAt: 17,
      },
      // Never prompted: not a conversation.
      { id: "t-empty", name: null, preview: "", updatedAt: 1700000000 },
      { preview: "no id" },
    ],
  });
  expect(await listed).toEqual([
    { id: "t-named", title: "Fix login", updated_at: 1700000200000 },
    { id: "t-plain", title: "first prompt", updated_at: 17000 },
  ]);
  agent.exit();
});

test("resuming in place switches threads on the same server", async () => {
  const session = await ready(["--yolo"]);
  const { agent, adapter, store, events } = session;
  expect(agent.written.at(-1)!.params).toMatchObject({
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
  await adapter.setMode("untrusted");
  const before = events.length;
  const resumed = adapter.resume("thread-9");
  // A prompt cannot slip in between the two threads.
  await expect(adapter.send("too early")).rejects.toThrow("being resumed");
  await expect(adapter.resume("thread-8")).rejects.toThrow(
    "already being resumed",
  );
  await settle();
  answer(agent, { data: STORED_TURNS, nextCursor: null });
  await settle();
  // A `--yolo` session stays one after resuming.
  expect(agent.written.at(-1)).toEqual({
    id: 4,
    method: "thread/resume",
    params: {
      threadId: "thread-9",
      excludeTurns: true,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  answer(agent, {
    thread: { id: "thread-9" },
    model: "gpt-test",
    cwd: "/work",
    approvalPolicy: "never",
  });
  await resumed;
  expect(agent.children).toHaveLength(1);
  expect(events.slice(before).map((event) => event.type)).toEqual([
    "reset",
    "info",
  ]);
  // The thread the session left is let go of, so other clients can open it.
  expect(agent.written.at(-1)).toEqual({
    id: 5,
    method: "thread/unsubscribe",
    params: { threadId: "thread-1" },
  });
  answer(agent, { status: "unsubscribed" });
  expect(store.info).toMatchObject({
    status: "idle",
    agent_session_id: "thread-9",
    mode: "never",
  });
  expect(lines(store.snapshot().items)).toEqual(RESTORED);

  // The old thread's notifications no longer count; the new one's do.
  agent.say({
    method: "thread/tokenUsage/updated",
    params: { threadId: "thread-1", tokenUsage: { last: { totalTokens: 1 } } },
  });
  expect(store.info.usage).toBeUndefined();
  agent.say({
    method: "thread/tokenUsage/updated",
    params: { threadId: "thread-9", tokenUsage: { last: { totalTokens: 9 } } },
  });
  expect(store.info.usage).toEqual({ context_tokens: 9 });

  // The mode chosen for the old thread does not ride on the new one's turn.
  const sent = adapter.send("and now?");
  await settle();
  expect(agent.written.at(-1)).toMatchObject({
    method: "turn/start",
    params: { threadId: "thread-9" },
  });
  expect(agent.written.at(-1)!.params.approvalPolicy).toBeUndefined();
  answer(agent, { turn: { id: "turn-3" } });
  await sent;

  // Refused while a turn runs.
  await expect(adapter.resume("thread-8")).rejects.toThrow("a turn is running");
  agent.say({
    method: "turn/completed",
    params: {
      threadId: "thread-9",
      turn: { id: "turn-3", status: "completed" },
    },
  });
  expect(store.info.status).toBe("idle");

  // A refusal from Codex leaves the session in the thread it was in.
  const refused = adapter.resume("thread-8");
  await settle();
  answer(agent, { data: [] });
  await settle();
  agent.say({
    id: agent.written.at(-1)!.id,
    error: {
      code: -32600,
      message: "thread thread-8 already has an active writer",
    },
  });
  await expect(refused).rejects.toThrow("already has an active writer");
  expect(store.info).toMatchObject({
    status: "idle",
    agent_session_id: "thread-9",
  });
  expect(store.snapshot().items.length).toBeGreaterThan(RESTORED.length);
  // And prompts are taken again.
  const again = adapter.send("still here");
  await settle();
  expect(agent.written.at(-1)).toMatchObject({
    method: "turn/start",
    params: { threadId: "thread-9" },
  });
  answer(agent, { turn: { id: "turn-4" } });
  await again;
  agent.exit();
});

test("prompts that start a turn can be rewound to with thread/revert", async () => {
  const session = await ready();
  const { agent, store, adapter } = session;
  const turn = async (prompt: string, id: string) => {
    const sent = adapter.send(prompt);
    await settle();
    answer(agent, { turn: { id } });
    await sent;
    agent.say({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id, status: "completed" } },
    });
    await settle();
  };
  await turn("first", "turn-1");
  await turn("second", "turn-2");
  const prompts = store.snapshot().items.filter((item) => item.type === "user");
  expect(prompts.map((item) => item.type === "user" && item.ref)).toEqual([
    "turn-1",
    "turn-2",
  ]);

  const rewound = adapter.rewind(prompts[1]!.id);
  await settle();
  expect(agent.written.at(-1)).toMatchObject({
    method: "thread/revert",
    params: { threadId: "thread-1", beforeTurnId: "turn-2" },
  });
  // A prompt waits while the thread is being cut.
  await expect(adapter.send("too early")).rejects.toThrow("being resumed");
  answer(agent, { thread: { id: "thread-1" } });
  await rewound;
  expect(lines(store.snapshot().items)).toEqual(["user: first"]);

  // Not while a turn runs, and only to prompts that started one.
  const running = adapter.send("third");
  await settle();
  answer(agent, { turn: { id: "turn-3" } });
  await running;
  await expect(adapter.rewind(prompts[0]!.id)).rejects.toThrow(
    "a turn is running",
  );
  agent.say({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-3", status: "completed" },
    },
  });
  await settle();
  await expect(adapter.rewind("nope")).rejects.toThrow("not in the transcript");
  agent.exit();
});

test("a branch names the thread and the turn before the prompt", async () => {
  const session = await ready(["-m", "gpt-x"]);
  const { agent, store, adapter } = session;
  // Nothing said yet: a branch is a new session.
  expect(await adapter.forkArgs()).toEqual(["-m", "gpt-x"]);
  store.upsertItem({ id: "p1", type: "user", text: "a", ref: "turn-1" });
  store.upsertItem({ id: "p2", type: "user", text: "b", ref: "turn-2" });
  store.upsertItem({ id: "p3", type: "user", text: "c" });
  expect(await adapter.forkArgs()).toEqual(["-m", "gpt-x", "fork", "thread-1"]);
  let args = adapter.forkArgs("p2");
  await settle();
  expect(agent.written.at(-1)).toMatchObject({
    method: "thread/turns/list",
    params: {
      threadId: "thread-1",
      sortDirection: "desc",
      itemsView: "notLoaded",
    },
  });
  answer(agent, {
    data: [{ id: "turn-2" }, { id: "turn-1" }],
    nextCursor: null,
  });
  expect(await args).toEqual([
    "-m",
    "gpt-x",
    "fork",
    "thread-1",
    "--last-turn",
    "turn-1",
  ]);
  // Before the first turn there is nothing to copy.
  args = adapter.forkArgs("p1");
  await settle();
  answer(agent, {
    data: [{ id: "turn-2" }, { id: "turn-1" }],
    nextCursor: null,
  });
  expect(await args).toEqual(["-m", "gpt-x"]);
  // A prompt taken into a running turn has no point of its own.
  await expect(adapter.forkArgs("p3")).rejects.toThrow("cannot go back");
  agent.exit();
});

test("starting on a copy continues the thread through a turn", async () => {
  const session = start([
    "-m",
    "gpt-x",
    "fork",
    "thread-9",
    "--last-turn",
    "turn-1",
  ]);
  const { agent, store } = session;
  agent.say({ id: 1, result: {} });
  await settle();
  expect(agent.written.at(-1)).toEqual({
    id: 2,
    method: "thread/fork",
    params: {
      threadId: "thread-9",
      lastTurnId: "turn-1",
      excludeTurns: true,
      model: "gpt-x",
    },
  });
  answer(agent, {
    thread: { id: "thread-10" },
    model: "gpt-x",
    cwd: "/work",
    approvalPolicy: "on-request",
  });
  await settle();
  expect(agent.written.at(-1)).toMatchObject({
    method: "thread/turns/list",
    params: { threadId: "thread-10" },
  });
  answer(agent, { data: [STORED_TURNS[1]], nextCursor: null });
  await settle();
  expect(store.info).toMatchObject({
    status: "idle",
    agent_session_id: "thread-10",
  });
  expect(lines(store.snapshot().items)).toEqual(RESTORED.slice(0, 4));
  expect(store.snapshot().items[0]).toMatchObject({ ref: "turn-1" });
  agent.exit();
});
