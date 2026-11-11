import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentItem,
  AgentSessionEvent,
} from "../../../shared/agentSession";
import { ClaudeAdapter, claudeArgv, claudeConversationArgs } from "./claude";
import {
  fakeAgent,
  sessionStore,
  settle,
  storedClaude,
  until,
} from "./test-support";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/**
 * A session in `/work` whose CLI configuration holds these conversations,
 * the first written last.
 */
function start(args: string[] = [], stored: Record<string, string> = {}) {
  const config = mkdtempSync(join(tmpdir(), "thyra-cr-"));
  roots.push(config);
  const dir = join(config, "projects", "-work");
  mkdirSync(dir, { recursive: true });
  Object.entries(stored).forEach(([id, content], index) => {
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(path, content);
    const when = new Date(Date.parse("2026-03-01T00:00:00Z") - index * 60_000);
    utimesSync(path, when, when);
  });
  const agent = fakeAgent();
  const { store, events } = sessionStore("claude");
  const exits: (string | undefined)[] = [];
  const adapter = new ClaudeAdapter({
    store,
    cwd: "/work",
    args,
    env: { CLAUDE_CONFIG_DIR: config },
    spawn: agent.spawn,
    onExit: (error) => exits.push(error),
  });
  adapter.start();
  return { agent, adapter, store, events, exits, dir };
}

/** Answer the `initialize` request of the process started last. */
function initialize(agent: ReturnType<typeof fakeAgent>, mode = "default") {
  const request = agent.written.findLast(
    (message) => message.request?.subtype === "initialize",
  )!;
  agent.say({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: request.request_id,
      response: { current_permission_mode: mode },
    },
  });
}

async function idle(session: ReturnType<typeof start>) {
  initialize(session.agent);
  await until(() => session.store.info.status === "idle", "an idle session");
  return session;
}

/** A short conversation: one prompt, one command, one answer. */
function conversation(word: string) {
  const file = storedClaude();
  file.prompt(`remember ${word}`);
  file.calls(`t-${word}`, "Bash", { command: `echo ${word}` });
  file.result(`t-${word}`, word);
  file.says(`m-${word}`, [{ type: "text", text: `I will remember ${word}.` }]);
  return file.text();
}

const texts = (items: AgentItem[]) =>
  items.map((item) =>
    item.type === "tool"
      ? `${item.name}[${item.status}] ${item.title}`
      : item.type === "plan"
        ? `plan ${item.entries.map((entry) => entry.status).join(",")}`
        : `${item.type}: ${item.text}`,
  );

const kinds = (events: AgentSessionEvent[]) =>
  events.map((event) =>
    event.type === "info" ? `info:${event.info.status}` : event.type,
  );

test("the arguments that choose a conversation are told from the rest", () => {
  expect(
    claudeConversationArgs([
      "--model",
      "haiku",
      "--resume",
      "abc-1",
      "--dangerously-skip-permissions",
    ]),
  ).toEqual({
    others: ["--model", "haiku", "--dangerously-skip-permissions"],
    resume: "abc-1",
    continues: false,
    identity: [],
  });
  expect(claudeConversationArgs(["-r", "abc-1"]).resume).toBe("abc-1");
  expect(claudeConversationArgs(["--resume=abc-1"]).resume).toBe("abc-1");
  // Without an ID it is the terminal UI's picker, which a session has not.
  for (const bare of [["--resume"], ["-r"], ["--resume", "--model", "haiku"]])
    expect(claudeConversationArgs(bare)).toEqual({
      others: bare.slice(1),
      continues: false,
      identity: [],
    });
  expect(claudeConversationArgs(["-c", "--verbose"])).toMatchObject({
    continues: true,
    others: ["--verbose"],
  });
  expect(claudeConversationArgs(["--continue"]).continues).toBe(true);
  expect(
    claudeConversationArgs([
      "--resume",
      "abc-1",
      "--fork-session",
      "--session-id",
      "new-1",
      "--session-id=new-2",
    ]),
  ).toEqual({
    others: [],
    resume: "abc-1",
    continues: false,
    identity: ["--fork-session", "--session-id", "new-1", "--session-id=new-2"],
  });
});

test("a stored conversation reads as it did when it was live", async () => {
  const file = storedClaude();
  file.prompt("add a note", { origin: { kind: "human" } });
  file.says("m1", [{ type: "thinking", thinking: "", signature: "hidden" }]);
  file.says("m1", [{ type: "text", text: "I'll write it." }]);
  file.calls("t1", "Write", {
    file_path: "/work/notes.txt",
    content: "alpha\n",
  });
  file.result("t1", "File created successfully", {
    toolUseResult: { type: "create", filePath: "/work/notes.txt" },
  });
  file.calls("t2", "Edit", {
    file_path: "/work/notes.txt",
    old_string: "alpha",
    new_string: "beta",
  });
  // The result's patch, with the file's real line numbers, wins.
  file.result("t2", "The file has been updated", {
    toolUseResult: {
      filePath: "/work/notes.txt",
      structuredPatch: [
        {
          oldStart: 7,
          oldLines: 1,
          newStart: 7,
          newLines: 1,
          lines: ["-alpha", "+beta"],
        },
      ],
    },
  });
  file.calls("t3", "TodoWrite", {
    todos: [
      { content: "write", status: "completed" },
      { content: "test", status: "in_progress" },
    ],
  });
  file.result("t3", "Todos have been modified");
  file.calls("t4", "Bash", { command: "npm test", description: "Run tests" });
  file.add({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t4",
          content: "1 failing",
          is_error: true,
        },
      ],
    },
  });
  file.calls("t5", "Bash", { command: "rm -rf build" });
  file.add({
    type: "user",
    toolDenialKind: "user-rejected",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t5",
          content: "The user doesn't want to proceed",
          is_error: true,
        },
      ],
    },
  });
  // A denial stops the turn; it does not read as an interruption.
  file.add({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: "[Request interrupted by user for tool use]" },
      ],
    },
  });
  const second = file.prompt("carry on");
  file.says("m2", [{ type: "text", text: "Working." }], {
    isSidechain: true,
  });
  file.continueFrom(second);
  file.prompt("expanded skill text", { isMeta: true });
  file.calls("t6", "Bash", { command: "sleep 100" });
  file.add({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "[Request interrupted by user]" }],
    },
  });
  file.prompt(
    "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>",
  );
  const before = file.prompt(
    "<local-command-stdout>Compacted</local-command-stdout>",
  );
  file.continueFrom(null);
  file.add({
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    logicalParentUuid: before,
  });
  file.prompt("This session is being continued from a previous one.", {
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  });
  file.prompt("and now?");
  file.says("m3", [{ type: "text", text: "API Error: overloaded" }], {
    isApiErrorMessage: true,
    error: "server_error",
  });
  file.calls("t7", "Read", { file_path: "/work/notes.txt" });
  const dir = mkdtempSync(join(tmpdir(), "thyra-cr-"));
  roots.push(dir);
  const path = join(dir, "stored.jsonl");
  writeFileSync(path, file.text());

  const { items, nextLocalId, turn } = await ClaudeAdapter.storedTranscript(
    path,
    "/work",
  );
  expect(texts(items)).toEqual([
    "user: add a note",
    "assistant: I'll write it.",
    "Write[done] notes.txt",
    "Edit[done] notes.txt",
    "plan done,in_progress",
    "Bash[failed] npm test",
    "Bash[denied] rm -rf build",
    "user: carry on",
    // A call that never got a result did not finish.
    "Bash[failed] sleep 100",
    "notice: Interrupted.",
    "user: /compact",
    "notice: Conversation compacted.",
    "user: and now?",
    "assistant: API Error: overloaded",
    "notice: Claude reported an error: server_error",
    "Read[failed] notes.txt",
  ]);
  const tools = items.filter((item) => item.type === "tool");
  expect(tools[0]).toMatchObject({
    kind: "edit",
    output: "File created successfully",
    diffs: [{ path: "/work/notes.txt", patch: "@@ -0,0 +1,1 @@\n+alpha" }],
  });
  expect(tools[1]!.diffs).toEqual([
    { path: "/work/notes.txt", patch: "@@ -7,1 +7,1 @@\n-alpha\n+beta" },
  ]);
  expect(tools[2]).toMatchObject({
    kind: "command",
    command: "npm test",
    output: "1 failing",
  });
  // Nothing restored is still streaming, and every item has the time its
  // entry was written at, in order.
  expect(
    items.some(
      (item) =>
        (item.type === "assistant" || item.type === "thinking") &&
        item.streaming,
    ),
  ).toBe(false);
  expect(items[0]!.at).toBe(Date.parse("2026-01-02T03:04:06.000Z"));
  expect(tools[0]!.at).toBe(Date.parse("2026-01-02T03:04:09.000Z"));
  expect(items.at(-1)!.at).toBe(file.time);
  expect(items.map((item) => item.at)).toEqual(
    items.map((item) => item.at).toSorted((a, b) => a - b),
  );
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  // Items made after the restore do not reuse an ID.
  expect(nextLocalId).toBeGreaterThan(1);
  expect(turn).toBeGreaterThan(1);
});

test("starting with --resume shows the conversation before the first prompt", async () => {
  const session = start(["--model", "haiku", "--resume", "abc-1"], {
    "abc-1": conversation("mango"),
  });
  const { agent, adapter, store, events } = session;
  expect(agent.argv).toEqual(
    claudeArgv(["--model", "haiku", "--resume", "abc-1"]),
  );
  // A prompt sent at once waits for the transcript instead of being lost.
  const sent = adapter.send("what was the word?");
  initialize(agent);
  await sent;
  expect(texts(store.snapshot().items)).toEqual([
    "user: remember mango",
    "Bash[done] echo mango",
    "assistant: I will remember mango.",
    "user: what was the word?",
  ]);
  expect(store.info.agent_session_id).toBe("abc-1");
  expect(events.filter((event) => event.type === "reset")).toHaveLength(1);
  // The session was never idle with an empty transcript.
  const order = kinds(events);
  expect(order.indexOf("reset")).toBeLessThan(order.indexOf("item"));
  expect(order.slice(0, order.indexOf("reset"))).not.toContain("info:idle");
  expect(agent.written.at(-1)).toMatchObject({
    type: "user",
    session_id: "abc-1",
  });
  agent.exit();

  // Both other spellings; a fork continues under an ID the CLI reports.
  const short = await idle(
    start(["-r", "abc-1"], { "abc-1": conversation("a") }),
  );
  expect(short.agent.argv.slice(-2)).toEqual(["--resume", "abc-1"]);
  expect(short.store.snapshot().items).toHaveLength(3);
  short.agent.exit();
  const fork = await idle(
    start(["--resume=abc-1", "--fork-session"], {
      "abc-1": conversation("a"),
    }),
  );
  expect(fork.agent.argv.slice(-3)).toEqual([
    "--fork-session",
    "--resume",
    "abc-1",
  ]);
  expect(fork.store.snapshot().items).toHaveLength(3);
  expect(fork.store.info.agent_session_id).toBeUndefined();
  fork.agent.exit();
});

test("a conversation that cannot be read still resumes, and says so", async () => {
  const { agent, store, events } = await idle(
    start(["--resume", "gone-1"], { "abc-1": conversation("a") }),
  );
  expect(agent.argv.slice(-2)).toEqual(["--resume", "gone-1"]);
  expect(events.some((event) => event.type === "reset")).toBe(false);
  expect(store.snapshot().items).toMatchObject([
    { type: "notice", level: "info" },
  ]);
  expect(texts(store.snapshot().items)[0]).toContain(
    "The earlier messages of gone-1 could not be read",
  );
  agent.exit();

  // A value that is no ID (a title, a search) is the CLI's to resolve.
  const named = await idle(start(["--resume", "my saved chat"]));
  expect(named.agent.argv.slice(-2)).toEqual(["--resume", "my saved chat"]);
  expect(named.store.snapshot().items).toEqual([]);
  named.agent.exit();
});

test("--continue names the newest conversation, or starts a new one and says so", async () => {
  const session = await idle(
    start(["-c", "--model", "haiku"], {
      "new-1": conversation("newest"),
      "old-1": conversation("older"),
    }),
  );
  // What is shown is what the CLI is told to continue.
  expect(session.agent.argv).toEqual(
    claudeArgv(["--model", "haiku", "--resume", "new-1"]),
  );
  expect(texts(session.store.snapshot().items)[0]).toBe(
    "user: remember newest",
  );
  expect(session.store.info.agent_session_id).toBe("new-1");
  session.agent.exit();

  const fresh = await idle(start(["--continue", "--model", "haiku"]));
  expect(fresh.agent.argv).toEqual(claudeArgv(["--model", "haiku"]));
  expect(texts(fresh.store.snapshot().items)).toEqual([
    "notice: No conversation is stored for this directory; this is a new one.",
  ]);
  fresh.agent.exit();

  // The terminal UI's picker: the page offers the list instead.
  const picker = await idle(
    start(["--resume", "--model", "haiku"], { "abc-1": conversation("a") }),
  );
  expect(picker.agent.argv).toEqual(claudeArgv(["--model", "haiku"]));
  expect(picker.store.snapshot().items).toEqual([]);
  picker.agent.exit();
});

test("history lists the directory's conversations without the session's own", async () => {
  const { agent, adapter } = await idle(
    start([], {
      "new-1": conversation("newest"),
      "old-1": conversation("older"),
    }),
  );
  expect(await adapter.history()).toEqual([
    {
      id: "new-1",
      title: "remember newest",
      updated_at: Date.parse("2026-03-01T00:00:00Z"),
    },
    {
      id: "old-1",
      title: "remember older",
      updated_at: Date.parse("2026-03-01T00:00:00Z") - 60_000,
    },
  ]);
  // The CLI names its conversation with its first message.
  agent.say({ type: "system", subtype: "status", session_id: "old-1" });
  expect((await adapter.history()).map((entry) => entry.id)).toEqual(["new-1"]);
  agent.exit();
});

test("resuming in place replaces the CLI process and the transcript", async () => {
  const session = await idle(
    start(
      ["--model", "haiku", "--continue", "--dangerously-skip-permissions"],
      {
        "new-1": conversation("newest"),
        "old-1": conversation("older"),
      },
    ),
  );
  const { agent, adapter, store, events, exits } = session;
  const first = agent.children[0]!;
  const before = events.length;

  await adapter.resume("old-1");
  // The earlier choice of conversation is replaced; everything else stays.
  expect(agent.children).toHaveLength(2);
  expect(agent.argv).toEqual(
    claudeArgv([
      "--model",
      "haiku",
      "--dangerously-skip-permissions",
      "--resume",
      "old-1",
    ]),
  );
  expect(first.killed).toEqual(["SIGTERM"]);
  expect(kinds(events.slice(before))).toEqual([
    "reset",
    "info:idle",
    "info:starting",
  ]);
  expect(events[before]).toMatchObject({ type: "reset" });
  expect(store.info).toMatchObject({
    status: "starting",
    agent_session_id: "old-1",
  });
  expect(texts(store.snapshot().items)).toEqual([
    "user: remember older",
    "Bash[done] echo older",
    "assistant: I will remember older.",
  ]);

  // The process that was replaced is no longer heard, and its end is not
  // the session's.
  first.say({ type: "system", subtype: "status", session_id: "new-1" });
  first.say({
    type: "assistant",
    message: { id: "late", content: [{ type: "text", text: "late" }] },
  });
  first.exit({ code: null, signal: "SIGTERM" });
  expect(store.info).toMatchObject({
    status: "starting",
    agent_session_id: "old-1",
  });
  expect(store.snapshot().items).toHaveLength(3);
  expect(exits).toEqual([]);

  initialize(agent, "bypassPermissions");
  await settle();
  expect(store.info).toMatchObject({
    status: "idle",
    mode: "bypassPermissions",
  });
  await adapter.send("and now?");
  expect(agent.written.at(-1)).toMatchObject({
    type: "user",
    session_id: "old-1",
    message: { content: "and now?" },
  });
  // New items do not collide with restored ones.
  const ids = store.snapshot().items.map((item) => item.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect((await adapter.history()).map((entry) => entry.id)).toEqual(["new-1"]);

  // Refused while a turn runs, and while it waits on an approval.
  await expect(adapter.resume("new-1")).rejects.toThrow("a turn is running");
  agent.say({
    type: "control_request",
    request_id: "perm-1",
    request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
  });
  await expect(adapter.resume("new-1")).rejects.toThrow("an approval is open");
  expect(agent.children).toHaveLength(2);
  agent.say({ type: "result", subtype: "success", is_error: false });
  expect(store.info.status).toBe("idle");

  // An ID nothing is stored for is refused and changes nothing.
  await expect(adapter.resume("gone-1")).rejects.toThrow(
    "no conversation gone-1 is stored for this directory",
  );
  expect(agent.children).toHaveLength(2);
  expect(store.info).toMatchObject({
    status: "idle",
    agent_session_id: "old-1",
  });

  // Again: one `--resume`, the newest choice.
  await adapter.resume("new-1");
  expect(agent.children).toHaveLength(3);
  expect(agent.argv.filter((arg) => arg === "--resume")).toHaveLength(1);
  expect(agent.argv.at(-1)).toBe("new-1");
  expect(texts(store.snapshot().items)[0]).toBe("user: remember newest");
  expect(store.snapshot().approvals).toEqual([]);

  // Stopping reaches the current process and one that has not ended yet.
  adapter.stop();
  expect(agent.children[1]!.killed).toEqual(["SIGTERM", "SIGTERM"]);
  expect(agent.children[2]!.killed).toEqual(["SIGTERM"]);
  agent.children[1]!.exit();
  agent.exit();
  expect(exits).toEqual([undefined]);
});

test("a conversation the CLI cannot resume ends the session with the reason", async () => {
  const { agent, adapter, store, exits } = await idle(
    start([], { "abc-1": conversation("a") }),
  );
  await adapter.resume("abc-1");
  agent.children[0]!.exit({ code: null, signal: "SIGTERM" });
  agent.exit({
    code: 1,
    stderr: "No conversation found with session ID: abc-1",
  });
  const error =
    "claude exited with code 1: No conversation found with session ID: abc-1";
  expect(store.info).toMatchObject({ status: "exited", error });
  expect(exits).toEqual([error]);
  // The transcript that was read stays readable.
  expect(store.snapshot().items).toHaveLength(3);
  await expect(adapter.resume("abc-1")).rejects.toThrow("has exited");
});
