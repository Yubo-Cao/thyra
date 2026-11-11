import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentItem } from "../../../shared/agentSession";
import { ClaudeAdapter, claudeArgv, claudeModels } from "./claude";
import { checkPromptImages } from "./prompt-images";
import {
  fakeAgent,
  loadFixture,
  sessionStore,
  settle,
  tinyImage,
  uploadedImage,
} from "./test-support";
import { SessionMirror } from "./transcript";

function start(args: string[] = []) {
  const agent = fakeAgent();
  const { store, events } = sessionStore("claude");
  const exits: (string | undefined)[] = [];
  const adapter = new ClaudeAdapter({
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

/** Start a session and answer its `initialize` request. */
async function ready(mode = "default") {
  const session = start();
  session.agent.say({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: session.agent.written[0]!.request_id,
      response: { current_permission_mode: mode },
    },
  });
  await settle();
  return session;
}

const tools = (items: AgentItem[]) =>
  items.filter((item) => item.type === "tool");

/**
 * Replay a recorded session: every line the CLI wrote is fed in, and at each
 * line the host wrote the matching action is taken and must produce that
 * same line.
 */
async function replay(name: string, session: ReturnType<typeof start>) {
  const { agent, adapter } = session;
  const uuids = new Map<string, string>();
  const failures: unknown[] = [];
  let cursor = 0;
  for (const { direction, message } of loadFixture(name)) {
    if (direction === "out") {
      let line = JSON.stringify(message);
      for (const [recorded, actual] of uuids)
        line = line.replaceAll(recorded, actual);
      agent.say(JSON.parse(line));
      await settle();
      continue;
    }
    if (message.type === "user") {
      void adapter.send(message.message.content).catch((e) => failures.push(e));
    } else if (message.type === "control_response") {
      const response = message.response.response;
      void adapter
        .approve(
          message.response.request_id,
          response.behavior === "deny"
            ? "deny"
            : response.updatedPermissions
              ? "allow_always"
              : "allow",
        )
        .catch((e) => failures.push(e));
    } else if (message.request.subtype === "interrupt") {
      void adapter.interrupt().catch((e) => failures.push(e));
    } else if (message.request.subtype === "set_permission_mode") {
      void adapter.setMode(message.request.mode).catch((e) => failures.push(e));
    }
    await settle();
    // Reading the settings is a side request a recording does not hold.
    const written = sent(agent)[cursor++];
    expect(written).toBeDefined();
    if (message.type === "user") {
      uuids.set(message.uuid, written!.uuid);
      expect({ ...written, uuid: "", session_id: "" }).toEqual({
        ...message,
        uuid: "",
        session_id: "",
      });
    } else {
      expect(written).toEqual(message);
    }
  }
  expect(sent(agent)).toHaveLength(cursor);
  expect(failures).toEqual([]);
}

const sent = (agent: ReturnType<typeof fakeAgent>) =>
  agent.written.filter((line) => line.request?.subtype !== "get_settings");

test("the command line asks for permissions unless the user chose otherwise", () => {
  expect(claudeArgv(["--model", "haiku"])).toEqual([
    "claude",
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--replay-user-messages",
    "--verbose",
    "--permission-prompt-tool",
    "stdio",
    "--allow-dangerously-skip-permissions",
    "--model",
    "haiku",
  ]);
  // The permission mode is the user's own choice: settings or command line.
  expect(claudeArgv([])).not.toContain("--permission-mode");
  const bypass = claudeArgv(["--dangerously-skip-permissions"]);
  expect(bypass).not.toContain("--permission-mode");
  expect(bypass).not.toContain("--allow-dangerously-skip-permissions");
  // No API key or auth switch is ever added.
  expect(claudeArgv([]).join(" ")).not.toMatch(/api|key|bare|auth/i);
});

test("a recorded session replays into the same transcript", async () => {
  const session = start();
  const { store, events, agent } = session;
  expect(store.info.status).toBe("starting");
  const mirror = new SessionMirror(store.snapshot());
  const started = mirror.seq;
  await replay("claude-session", session);
  const { info, items, approvals } = store.snapshot();

  expect(info).toMatchObject({
    status: "idle",
    mode: "default",
    model: "claude-haiku-5-5",
    cwd: "/work",
    usage: { context_window: 1000000 },
  });
  expect(info.agent_session_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(info.usage!.context_tokens).toBeGreaterThan(1000);
  expect(info.modes.map((mode) => mode.id)).toEqual([
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
  ]);
  expect(approvals).toEqual([]);

  expect(items.filter((item) => item.type === "user")).toHaveLength(3);
  const [write, cat, touch] = tools(items);
  expect(write).toMatchObject({
    kind: "edit",
    name: "Write",
    title: "notes.txt",
    status: "done",
    diffs: [
      { path: "/work/notes.txt", patch: "@@ -0,0 +1,2 @@\n+alpha\n+beta" },
    ],
  });
  expect(cat).toMatchObject({
    kind: "command",
    name: "Bash",
    title: "cat notes.txt",
    command: "cat notes.txt",
    status: "done",
    output: "alpha\nbeta",
  });
  expect(touch).toMatchObject({
    kind: "command",
    command: "touch denied.txt",
    status: "denied",
  });
  const texts = items.filter((item) => item.type === "assistant");
  expect(texts.every((item) => !item.streaming)).toBe(true);
  // The interrupted answer stops where the stream was cut.
  expect(texts.at(-1)!.text.startsWith("1. ")).toBe(true);
  expect(texts.at(-1)!.text).not.toContain("60.");
  expect(
    items.filter((item) => item.type === "notice").map((item) => item.text),
  ).toEqual(["Interrupted."]);

  // Approvals pointed at their tool items and were resolved.
  const asked = events.flatMap((event) =>
    event.type === "approval" ? [event.approval] : [],
  );
  expect(asked.map((approval) => [approval.title, approval.item_id])).toEqual([
    ["Write: notes.txt", write!.id],
    ["Bash: touch denied.txt", touch!.id],
  ]);
  expect(asked[0]!.options.map((option) => option.kind)).toEqual([
    "allow",
    "allow_always",
    "deny",
  ]);
  expect(
    events.filter((event) => event.type === "approval_resolved"),
  ).toHaveLength(2);
  // The session visited every status a page shows.
  const statuses = events.flatMap((event) =>
    event.type === "info" ? [event.info.status] : [],
  );
  expect(statuses).toContain("running");
  expect(statuses).toContain("awaiting_approval");
  expect(statuses.at(-1)).toBe("idle");
  // Text arrived as deltas, and events alone rebuild the snapshot.
  expect(events.some((event) => event.type === "delta")).toBe(true);
  for (const event of events.filter((event) => event.seq > started))
    expect(mirror.apply(event)).toBe(true);
  expect(mirror.snapshot()).toEqual(store.snapshot());
  agent.exit();
});

test("edits show the patch Claude reports, hidden thinking shows nothing", async () => {
  const session = start();
  const { agent, store } = session;
  // Recorded before prompts were acknowledged: only the CLI's side replays.
  for (const { direction, message } of loadFixture("claude-edits"))
    if (direction === "out") agent.say(message);
  const { items, info } = store.snapshot();
  expect(
    tools(items).map((item) => [item.name, item.kind, item.status]),
  ).toEqual([
    ["Write", "edit", "done"],
    ["Read", "read", "done"],
    ["Edit", "edit", "done"],
    ["Bash", "command", "done"],
    ["Bash", "command", "done"],
  ]);
  expect(tools(items)[2]!.diffs).toEqual([
    {
      path: "/work/notes.txt",
      patch: "@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma",
    },
  ]);
  expect(items.some((item) => item.type === "thinking")).toBe(false);
  expect(items.at(-1)).toMatchObject({ type: "assistant", text: "pineapple" });
  // Without acknowledgements each result ends the turn.
  expect(info).toMatchObject({ status: "idle", mode: "plan" });
  agent.exit();
});

test("a prompt sent during a turn keeps the session running until its own turn ends", async () => {
  const { agent, adapter, store } = await ready();
  await adapter.send("first");
  const first = agent.written.at(-1)!;
  agent.say({
    type: "command_lifecycle",
    command_uuid: first.uuid,
    state: "started",
  });
  agent.say({
    type: "system",
    subtype: "init",
    model: "m",
    permissionMode: "default",
  });
  await adapter.send("second");
  const second = agent.written.at(-1)!;
  expect(second).toMatchObject({
    type: "user",
    message: { role: "user", content: "second" },
  });
  // The CLI has not read the second prompt when the first turn ends.
  agent.say({
    type: "result",
    subtype: "success",
    is_error: false,
    queued_turn_count: 0,
  });
  expect(store.info.status).toBe("running");
  agent.say({
    type: "command_lifecycle",
    command_uuid: second.uuid,
    state: "started",
  });
  agent.say({
    type: "result",
    subtype: "success",
    is_error: false,
    queued_turn_count: 0,
  });
  expect(store.info.status).toBe("idle");
  // A queued prompt the CLI reports is waited for as well.
  await adapter.send("third");
  agent.say({
    type: "command_lifecycle",
    command_uuid: agent.written.at(-1)!.uuid,
    state: "started",
  });
  agent.say({
    type: "result",
    subtype: "success",
    is_error: false,
    queued_turn_count: 1,
  });
  expect(store.info.status).toBe("running");
  agent.say({
    type: "result",
    subtype: "success",
    is_error: false,
    queued_turn_count: 0,
  });
  expect(store.info.status).toBe("idle");
  // A prompt cancelled while it waited ends nothing but itself.
  await adapter.send("fourth");
  agent.say({
    type: "command_lifecycle",
    command_uuid: agent.written.at(-1)!.uuid,
    state: "cancelled",
  });
  expect(store.info.status).toBe("idle");
  agent.exit();
});

test("a prompt's images go to the CLI as image blocks after its text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thyra-ci-"));
  try {
    const { agent, adapter, store } = await ready();
    const [png, webp] = await checkPromptImages([
      { path: uploadedImage(dir) },
      { path: uploadedImage(dir, tinyImage("webp"), "png") },
    ]);
    const block = (media_type: string, format: "png" | "webp") => ({
      type: "image",
      source: {
        type: "base64",
        media_type,
        data: tinyImage(format).toString("base64"),
      },
    });
    const text = "what is in [Image #1]?";

    // The same text twice, with different images: two prompts of their own.
    await adapter.send(text, [png!]);
    const first = agent.written.at(-1)!;
    expect(first).toMatchObject({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "text", text }, block("image/png", "png")],
      },
    });
    await adapter.send(text, [webp!, png!]);
    const second = agent.written.at(-1)!;
    expect(second.message.content).toEqual([
      { type: "text", text },
      block("image/webp", "webp"),
      block("image/png", "png"),
    ]);
    expect(second.uuid).not.toBe(first.uuid);
    expect(store.snapshot().items).toMatchObject([
      { type: "user", text, images: [{ path: png!.path }] },
      {
        type: "user",
        text,
        images: [{ path: webp!.path }, { path: png!.path }],
      },
    ]);

    // The CLI acknowledges each prompt by its ID. Its echo holds the image
    // as the CLI shrank it, not as it was sent, and is not shown again.
    const echo = (uuid: string) =>
      agent.say({
        type: "user",
        isReplay: true,
        uuid,
        message: {
          role: "user",
          content: [
            { type: "text", text },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "eA==",
              },
            },
          ],
        },
      });
    agent.say({
      type: "command_lifecycle",
      command_uuid: first.uuid,
      state: "started",
    });
    echo(first.uuid);
    agent.say({ type: "result", subtype: "success", is_error: false });
    // The second prompt has not been taken yet: its turn is still to come.
    expect(store.info.status).toBe("running");
    agent.say({
      type: "command_lifecycle",
      command_uuid: second.uuid,
      state: "started",
    });
    echo(second.uuid);
    agent.say({ type: "result", subtype: "success", is_error: false });
    expect(store.info.status).toBe("idle");
    expect(store.snapshot().items).toHaveLength(2);

    // With an image the text may be empty: no empty text block is sent.
    await adapter.send("", [png!]);
    expect(agent.written.at(-1)!.message.content).toEqual([
      block("image/png", "png"),
    ]);
    expect(store.snapshot().items.at(-1)).toMatchObject({
      type: "user",
      text: "",
      images: [{ path: png!.path }],
    });
    // Without images a prompt is the plain string it always was.
    await adapter.send("plain");
    expect(agent.written.at(-1)!.message.content).toBe("plain");
    expect(store.snapshot().items.at(-1)).not.toHaveProperty("images");

    // A file gone since it was checked refuses the prompt: nothing is
    // sent and nothing is shown.
    rmSync(webp!.path);
    const written = agent.written.length;
    const shown = store.snapshot().items.length;
    await expect(adapter.send("look", [png!, webp!])).rejects.toThrow(
      "image 2 is no longer on the host",
    );
    expect(agent.written).toHaveLength(written);
    expect(store.snapshot().items).toHaveLength(shown);
    agent.exit();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interrupt does nothing when idle and settles a stuck session", async () => {
  const { agent, adapter, store } = await ready();
  const before = agent.written.length;
  await adapter.interrupt();
  expect(agent.written).toHaveLength(before);
  await adapter.send("go");
  const interrupted = adapter.interrupt();
  expect(agent.written.at(-1)).toMatchObject({
    type: "control_request",
    request: { subtype: "interrupt" },
  });
  agent.say({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: agent.written.at(-1)!.request_id,
      response: { still_queued: [] },
    },
  });
  await interrupted;
  agent.say({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_streaming",
    errors: ["diagnostic"],
  });
  expect(store.info.status).toBe("idle");
  // An interrupted turn is not an error to show.
  expect(store.snapshot().items.some((item) => item.type === "notice")).toBe(
    false,
  );
  agent.exit();
});

test("always-allow sends the CLI's own suggestions back", async () => {
  const { agent, adapter, store } = await ready();
  await adapter.send("edit");
  const suggestions = [
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ];
  agent.say({
    type: "assistant",
    message: {
      id: "msg_1",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Edit",
          input: { file_path: "/work/a.txt", old_string: "a", new_string: "b" },
        },
      ],
    },
  });
  agent.say({
    type: "control_request",
    request_id: "req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Edit",
      input: { file_path: "/work/a.txt", old_string: "a", new_string: "b" },
      permission_suggestions: suggestions,
      tool_use_id: "toolu_1",
      decision_reason: "Edits need approval",
    },
  });
  const [approval] = store.approvals;
  expect(approval).toMatchObject({
    id: "req-1",
    item_id: "toolu_1",
    title: "Edit: a.txt",
    detail: "Edits need approval",
    options: [
      { id: "allow", kind: "allow" },
      { id: "allow_always", label: "Allow all edits this session" },
      { id: "deny", kind: "deny" },
    ],
  });
  expect(store.item("toolu_1")).toMatchObject({ status: "pending" });
  expect(store.info.status).toBe("awaiting_approval");
  await expect(adapter.approve("req-1", "nope")).rejects.toThrow("unknown");
  await adapter.approve("req-1", "allow_always");
  expect(agent.written.at(-1)).toEqual({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "req-1",
      response: {
        behavior: "allow",
        updatedInput: {
          file_path: "/work/a.txt",
          old_string: "a",
          new_string: "b",
        },
        updatedPermissions: suggestions,
        toolUseID: "toolu_1",
      },
    },
  });
  expect(store.item("toolu_1")).toMatchObject({ status: "running" });
  expect(store.info.status).toBe("running");
  await expect(adapter.approve("req-1", "allow")).rejects.toThrow(
    "no longer pending",
  );
  agent.exit();
});

test("a prompt the CLI withdraws is resolved without an answer", async () => {
  const { agent, adapter, store } = await ready();
  await adapter.send("run");
  agent.say({
    type: "control_request",
    request_id: "req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls" },
      tool_use_id: "toolu_sub",
      agent_id: "agent-7",
    },
  });
  // No item for a sub-agent's tool: the approval stands alone.
  expect(store.approvals[0]).toEqual({
    id: "req-1",
    title: "Bash: ls",
    detail: "Requested by a sub-agent.",
    options: [
      { id: "allow", label: "Allow", kind: "allow" },
      { id: "deny", label: "Deny", kind: "deny" },
    ],
  });
  const before = agent.written.length;
  agent.say({ type: "control_cancel_request", request_id: "req-1" });
  expect(store.approvals).toEqual([]);
  expect(agent.written).toHaveLength(before);
  agent.exit();
});

test("requests this host cannot serve are refused, not left waiting", async () => {
  const { agent } = await ready();
  agent.say({
    type: "control_request",
    request_id: "req-9",
    request: { subtype: "request_user_dialog", dialog_kind: "x", payload: {} },
  });
  expect(agent.written.at(-1)).toEqual({
    type: "control_response",
    response: {
      subtype: "error",
      request_id: "req-9",
      error: "request_user_dialog is not supported by this client",
    },
  });
  agent.exit();
});

test("a single-choice question becomes an approval whose options answer it", async () => {
  const { agent, adapter, store } = await ready();
  await adapter.send("ask");
  const input = {
    questions: [
      {
        question: "Which database?",
        header: "DB",
        multiSelect: false,
        options: [
          { label: "SQLite", description: "A file" },
          { label: "Postgres", description: "A server" },
        ],
      },
    ],
  };
  agent.say({
    type: "control_request",
    request_id: "req-q",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input,
      tool_use_id: "toolu_q",
    },
  });
  expect(store.approvals[0]).toMatchObject({
    title: "Which database?",
    detail: "SQLite: A file\nPostgres: A server",
    options: [
      { id: "answer-1", label: "SQLite", kind: "allow" },
      { id: "answer-2", label: "Postgres", kind: "allow" },
      { id: "deny", label: "Skip", kind: "deny" },
    ],
  });
  await adapter.approve("req-q", "answer-2");
  expect(agent.written.at(-1)!.response.response).toEqual({
    behavior: "allow",
    updatedInput: { ...input, answers: { "Which database?": "Postgres" } },
    toolUseID: "toolu_q",
  });
  // Several questions cannot be shown: the agent is told to ask in text.
  agent.say({
    type: "control_request",
    request_id: "req-many",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: { questions: [input.questions[0], input.questions[0]] },
      tool_use_id: "toolu_q2",
    },
  });
  expect(store.approvals).toEqual([]);
  expect(agent.written.at(-1)!.response.response).toMatchObject({
    behavior: "deny",
  });
  expect(agent.written.at(-1)!.response.response.interrupt).toBeUndefined();
  agent.exit();
});

test("todo lists are one plan per turn and sub-agents fold into their task", async () => {
  const { agent, adapter, store } = await ready();
  await adapter.send("plan it");
  const todo = (status: string) => ({
    type: "assistant",
    message: {
      id: "msg_1",
      content: [
        {
          type: "tool_use",
          id: `toolu_todo_${status}`,
          name: "TodoWrite",
          input: {
            todos: [
              {
                content: "Read the code",
                status: "completed",
                activeForm: "Reading",
              },
              { content: "Write the fix", status, activeForm: "Writing" },
            ],
          },
        },
      ],
    },
  });
  agent.say(todo("pending"));
  agent.say(todo("in_progress"));
  agent.say({
    type: "assistant",
    message: {
      id: "msg_2",
      content: [
        {
          type: "tool_use",
          id: "toolu_task",
          name: "Task",
          input: {
            description: "Find usages",
            subagent_type: "Explore",
            prompt: "look",
          },
        },
      ],
    },
  });
  // The sub-agent's own messages name the Task call as their parent.
  agent.say({
    type: "stream_event",
    parent_tool_use_id: "toolu_task",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "sub text" },
    },
  });
  agent.say({
    type: "assistant",
    parent_tool_use_id: "toolu_task",
    message: {
      id: "msg_sub",
      content: [
        { type: "text", text: "sub-agent thinking aloud" },
        {
          type: "tool_use",
          id: "toolu_sub_1",
          name: "Grep",
          input: { pattern: "foo" },
        },
      ],
    },
  });
  agent.say({
    type: "user",
    parent_tool_use_id: "toolu_task",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_sub_1",
          content: "3 matches",
        },
      ],
    },
  });
  let items = store.snapshot().items;
  expect(items.map((item) => item.type)).toEqual(["user", "plan", "tool"]);
  expect(items[1]).toMatchObject({
    entries: [
      { text: "Read the code", status: "done" },
      { text: "Write the fix", status: "in_progress" },
    ],
  });
  expect(items[2]).toMatchObject({
    kind: "task",
    name: "Task",
    title: "Find usages",
    status: "running",
    output: "Grep: foo",
  });
  agent.say({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_task",
          content: [{ type: "text", text: "Found 3 usages." }],
        },
      ],
    },
  });
  items = store.snapshot().items;
  expect(items[2]).toMatchObject({ status: "done", output: "Found 3 usages." });
  expect(items).toHaveLength(3);
  agent.exit();
});

test("turn errors, retries and limits become notices", async () => {
  const { agent, adapter, store } = await ready();
  await adapter.send("go");
  agent.say({
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 10,
    error_status: 529,
  });
  agent.say({
    type: "system",
    subtype: "api_retry",
    attempt: 2,
    max_retries: 10,
    error_status: 529,
  });
  agent.say({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: 1794646800 },
  });
  agent.say({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed" },
  });
  agent.say({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: {},
  });
  agent.say({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "API Error: overloaded",
    queued_turn_count: 0,
  });
  expect(
    store
      .snapshot()
      .items.filter((item) => item.type === "notice")
      .map((item) => [item.level, item.text]),
  ).toEqual([
    ["info", "The API request failed (HTTP 529); retrying (attempt 2 of 10)."],
    [
      "error",
      "The usage limit was reached. It resets at 2026-11-14T09:00:00.000Z.",
    ],
    ["info", "Conversation compacted."],
    ["error", "API Error: overloaded"],
  ]);
  expect(store.info.status).toBe("idle");
  agent.exit();
});

test("mode changes go through the control protocol and report refusals", async () => {
  const { agent, adapter, store } = await ready();
  await expect(adapter.setMode("dontAsk")).rejects.toThrow("unknown mode");
  const change = adapter.setMode("bypassPermissions");
  const request = agent.written.at(-1)!;
  expect(request.request).toEqual({
    subtype: "set_permission_mode",
    mode: "bypassPermissions",
  });
  agent.say({
    type: "control_response",
    response: {
      subtype: "error",
      request_id: request.request_id,
      error: "Cannot set permission mode to bypassPermissions",
    },
  });
  await expect(change).rejects.toThrow("Cannot set permission mode");
  expect(store.info.mode).toBe("default");
  // The CLI also announces changes made on its side.
  agent.say({
    type: "system",
    subtype: "status",
    status: null,
    permissionMode: "plan",
  });
  expect(store.info.mode).toBe("plan");
  agent.exit();
});

test("a crash ends the session with its reason and closes what was open", async () => {
  const { agent, adapter, store, exits } = await ready();
  await adapter.send("go");
  agent.say({
    type: "stream_event",
    event: { type: "message_start", message: { id: "msg_1" } },
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
      delta: { type: "text_delta", text: "partial" },
    },
  });
  agent.say({
    type: "control_request",
    request_id: "req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls" },
      tool_use_id: "t",
    },
  });
  agent.exit({ code: 1, stderr: "boom\nfatal: out of memory" });
  expect(store.info).toMatchObject({
    status: "exited",
    error: "claude exited with code 1: boom fatal: out of memory",
  });
  expect(exits).toEqual([store.info.error]);
  expect(store.approvals).toEqual([]);
  expect(store.snapshot().items.at(-1)).toMatchObject({
    type: "assistant",
    text: "partial",
    streaming: false,
  });
  await expect(adapter.send("again")).rejects.toThrow("exited");
  await expect(adapter.interrupt()).resolves.toBeUndefined();
});

test("a requested stop and a missing program are told apart", async () => {
  const stopped = await ready();
  stopped.adapter.stop();
  expect(stopped.agent.killed).toEqual(["SIGTERM"]);
  stopped.agent.exit({ code: null, signal: "SIGTERM" });
  expect(stopped.store.info.status).toBe("exited");
  expect(stopped.store.info.error).toBeUndefined();
  expect(stopped.exits).toEqual([undefined]);

  const { store } = sessionStore("claude");
  const exits: (string | undefined)[] = [];
  new ClaudeAdapter({
    store,
    cwd: "/work",
    args: [],
    env: {},
    spawn: () => {
      throw new Error("ENOENT: claude");
    },
    onExit: (error) => exits.push(error),
  }).start();
  expect(store.info).toMatchObject({
    status: "exited",
    error: "could not start claude: ENOENT: claude",
  });
  expect(exits).toEqual([store.info.error]);
});

test("models are the ones initialize lists, one per model they resolve to", () => {
  expect(
    claudeModels([
      {
        value: "default",
        resolvedModel: "claude-opus-5-5",
        displayName: "Default (recommended)",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
      {
        value: "opus",
        resolvedModel: "claude-opus-5-5",
        displayName: "Opus 5.5",
        description: "For complex work",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
      { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "H" },
      { value: "sonnet", displayName: "S" },
      { displayName: "nameless" },
      "junk",
    ]),
  ).toEqual([
    {
      id: "claude-opus-5-5",
      label: "Opus 5.5",
      description: "For complex work",
      efforts: ["low", "high"],
    },
    { id: "claude-haiku-5-5", label: "H" },
    { id: "sonnet", label: "S" },
  ]);
});

test("the model and effort are read before the first turn and changed over control requests", async () => {
  const { agent, adapter, store } = start();
  const answer = (response: Record<string, unknown>) =>
    agent.say({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: agent.written.at(-1)!.request_id,
        response,
      },
    });
  answer({
    current_permission_mode: "default",
    models: [
      {
        value: "opus",
        resolvedModel: "claude-opus-5-5",
        displayName: "Opus",
        supportsEffort: true,
        supportedEffortLevels: ["low", "max"],
      },
      { value: "haiku", resolvedModel: "claude-haiku-4-5", displayName: "H" },
    ],
  });
  await settle();
  expect(agent.written.at(-1)).toMatchObject({
    request: { subtype: "get_settings" },
  });
  const settings = (model: string, effort: string) =>
    answer({ applied: { model, effort } });
  settings("claude-opus-5-5", "low");
  await settle();
  expect(store.info).toMatchObject({
    status: "idle",
    model: "claude-opus-5-5",
    effort: "low",
    efforts: ["low", "max"],
  });
  expect(store.info.models?.map((model) => model.id)).toEqual([
    "claude-opus-5-5",
    "claude-haiku-4-5",
  ]);

  await expect(adapter.setEffort("medium")).rejects.toThrow("unknown effort");
  const effort = adapter.setEffort("max");
  await settle();
  expect(agent.written.at(-1)).toMatchObject({
    type: "control_request",
    request: {
      subtype: "apply_flag_settings",
      settings: { effortLevel: "max" },
    },
  });
  answer({});
  await settle();
  settings("claude-opus-5-5", "max");
  await effort;
  expect(store.info.effort).toBe("max");

  await expect(adapter.setModel("gpt")).rejects.toThrow("unknown model");
  const model = adapter.setModel("claude-haiku-4-5");
  await settle();
  expect(agent.written.at(-1)).toMatchObject({
    request: { subtype: "set_model", model: "claude-haiku-4-5" },
  });
  answer({ model: "claude-haiku-4-5" });
  await settle();
  settings("claude-haiku-4-5", "max");
  await model;
  // A model without effort levels shows none.
  expect(store.info.model).toBe("claude-haiku-4-5");
  expect(store.info.effort).toBeUndefined();
  expect(store.info.efforts).toBeUndefined();

  // Compacting is the CLI's own command, sent as a prompt.
  await adapter.compact();
  expect(agent.written.at(-1)).toMatchObject({
    type: "user",
    message: { content: "/compact" },
  });
  agent.exit();
});
