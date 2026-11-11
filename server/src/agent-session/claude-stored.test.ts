import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeProjectDir,
  claudeProjectName,
  listClaudeSessions,
  readClaudeConversation,
  type StoredEntry,
  storedCommand,
  storedPrompt,
} from "./claude-stored";
import { storedClaude } from "./test-support";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "thyra-cs-")));
  roots.push(root);
  return root;
}

/** Write a conversation file, last written `age` seconds ago. */
function store(dir: string, id: string, content: string, age = 0): string {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, content);
  const when = new Date(Date.parse("2026-03-01T00:00:00Z") - age * 1000);
  utimesSync(path, when, when);
  return path;
}

async function entriesOf(path: string, itemLimit?: number) {
  const entries: StoredEntry[] = [];
  for await (const entry of readClaudeConversation(path, itemLimit))
    entries.push(entry);
  return entries;
}

/** What an entry shows: its prompt, its text, or the tool call it is about. */
function gist(entry: StoredEntry): string {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return `${entry.type}/${entry.subtype}`;
  const block = content[0] as Record<string, string>;
  return block.text ?? `${block.type}:${block.id ?? block.tool_use_id}`;
}

test("a directory's conversations are named as the CLI names them", () => {
  // Every character outside letters and digits becomes a dash.
  expect(claudeProjectName("/home/u/.config/a_b c-d")).toBe(
    "-home-u--config-a-b-c-d",
  );
  expect(claudeProjectName("/tmp/café/中")).toBe("-tmp-caf---");
  // Past 200 characters the name is cut and ends in a hash of the path
  // (this pair was made by the CLI itself).
  const long = `/tmp/thyra-resume-probe-long/${"x".repeat(90)}/${"y_".repeat(45)}/tail.dir`;
  expect(claudeProjectName(long)).toBe(
    `-tmp-thyra-resume-probe-long-${"x".repeat(90)}-${"y-".repeat(40)}-c6qjqh`,
  );
  expect(claudeProjectName(long)).toHaveLength(207);
});

test("conversations are looked up under the CLI's configuration, by the real path", () => {
  const root = tempDir();
  const real = join(root, "real.dir");
  mkdirSync(real);
  symlinkSync(real, join(root, "link"));
  const name = claudeProjectName(real);
  expect(name.endsWith("-real-dir")).toBe(true);
  expect(
    claudeProjectDir(join(root, "link"), { CLAUDE_CONFIG_DIR: "/cfg" }),
  ).toBe(join("/cfg", "projects", name));
  expect(claudeProjectDir(real, { HOME: "/home/u" })).toBe(
    join("/home/u", ".claude", "projects", name),
  );
  // A directory that is gone is named as given.
  expect(claudeProjectDir("/gone/dir", { CLAUDE_CONFIG_DIR: "/cfg" })).toBe(
    "/cfg/projects/-gone-dir",
  );

  // A long name is found by its first 200 characters when another build
  // gave it another hash.
  const long = join(root, "d".repeat(210));
  mkdirSync(long);
  const config = join(root, "config");
  const other = `${claudeProjectName(long).slice(0, 201)}zzzz`;
  mkdirSync(join(config, "projects", other), { recursive: true });
  expect(claudeProjectDir(long, { CLAUDE_CONFIG_DIR: config })).toBe(
    join(config, "projects", other),
  );
});

test("only what the user typed counts as a prompt", () => {
  const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
    type: "user",
    message: { role: "user", content },
    ...extra,
  });
  expect(storedPrompt(user("fix the bug"))).toBe("fix the bug");
  expect(storedPrompt(user("fix", { origin: { kind: "human" } }))).toBe("fix");
  // What an IDE attached is not part of the prompt; an image is named.
  expect(
    storedPrompt(
      user([
        { type: "text", text: "<ide_opened_file>a.ts</ide_opened_file>" },
        { type: "image", source: {} },
        { type: "text", text: "what is this?" },
      ]),
    ),
  ).toBe("[image]\nwhat is this?");
  for (const entry of [
    user("injected", { isMeta: true }),
    user("summary", { isCompactSummary: true }),
    user("sub-agent prompt", { isSidechain: true }),
    user("<task-notification>done</task-notification>", {
      origin: { kind: "task-notification" },
    }),
    user("a task finished", { origin: { kind: "task-notification" } }),
    user("<local-command-stdout>ok</local-command-stdout>"),
    user("<command-name>/model</command-name>"),
    user("<bash-input>ls</bash-input>"),
    user("<system-reminder>note</system-reminder>"),
    user([{ type: "text", text: "[Request interrupted by user]" }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
    user([{ type: "text", text: "<ide_selection>x</ide_selection>" }]),
    user("   "),
    { type: "assistant", message: { content: "hello" } },
  ])
    expect(storedPrompt(entry)).toBeNull();

  expect(
    storedCommand(
      user(
        "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>the last commit</command-args>",
      ),
    ),
  ).toBe("/review the last commit");
  expect(storedCommand(user("<command-name>/compact</command-name>"))).toBe(
    "/compact",
  );
  expect(storedCommand(user("fix the bug"))).toBeNull();
});

test("history lists a directory's conversations newest first, each by its title", () => {
  const dir = tempDir();

  const renamed = storedClaude();
  renamed.prompt("first prompt of the renamed one");
  renamed.note({
    type: "ai-title",
    aiTitle: "Generated title",
    sessionId: "a",
  });
  renamed.note({ type: "custom-title", customTitle: "My own title" });
  renamed.says("m1", [{ type: "text", text: "ok" }]);
  renamed.note({ type: "ai-title", aiTitle: "A later generated title" });
  store(dir, "11111111-aaaa", renamed.text(), 10);

  const titled = storedClaude();
  titled.prompt("first prompt of the titled one");
  titled.note({ type: "ai-title", aiTitle: "An older title" });
  titled.note({ type: "ai-title", aiTitle: "Fix the login flow" });
  store(dir, "22222222-bbbb", titled.text(), 20);

  // No title: the first thing the user typed, past everything that was not.
  const untitled = storedClaude();
  untitled.add({ type: "attachment", attachment: { type: "hook" } });
  untitled.add({
    type: "user",
    isMeta: true,
    message: { role: "user", content: [{ type: "image", source: {} }] },
  });
  untitled.prompt("injected context", { isMeta: true });
  untitled.prompt("<command-name>/model</command-name>");
  untitled.prompt("<local-command-stdout>Set model</local-command-stdout>");
  untitled.add({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "image", source: {} },
        { type: "text", text: "  explain the build\nand the tests  " },
      ],
    },
  });
  untitled.says("m1", [{ type: "text", text: "sure" }]);
  untitled.prompt("a later prompt");
  untitled.note({ type: "last-prompt", lastPrompt: "a later prompt" });
  store(dir, "33333333-cccc", untitled.text(), 30);

  // The first prompt lies past the part of the file that is read: the
  // latest prompt, which the CLI keeps at the end, names it instead.
  const deep = storedClaude();
  deep.add({ type: "attachment", attachment: { pad: "x".repeat(80_000) } });
  deep.prompt("the first prompt, far into the file");
  deep.result("t1", "y".repeat(400_000));
  deep.note({ type: "last-prompt", lastPrompt: "now run the tests" });
  deep.says("m9", [{ type: "text", text: "z".repeat(20_000) }]);
  store(dir, "44444444-dddd", deep.text(), 40);

  // Not conversations of the user's: never prompted, a sub-agent's file
  // (by its entries, and by the name older builds give it), other files.
  const silent = storedClaude();
  silent.prompt("injected", { isMeta: true });
  silent.prompt("<command-name>/exit</command-name>");
  silent.note({ type: "last-prompt", lastPrompt: "" });
  store(dir, "55555555-eeee", silent.text(), 1);
  const side = storedClaude();
  side.prompt("do the sub-task", { isSidechain: true });
  side.note({ type: "ai-title", aiTitle: "A sub-agent" });
  store(dir, "66666666-ffff", side.text(), 2);
  store(dir, "agent-a1b2c3", untitled.text(), 3);
  store(dir, "77777777-0000", "", 4);
  writeFileSync(join(dir, "notes.txt"), "not a conversation");
  writeFileSync(join(dir, "..hidden.jsonl"), untitled.text());
  mkdirSync(join(dir, "11111111-aaaa"));
  mkdirSync(join(dir, "memory.jsonl"));

  const sessions = listClaudeSessions(dir);
  expect(sessions.map((session) => [session.id, session.title])).toEqual([
    ["11111111-aaaa", "My own title"],
    ["22222222-bbbb", "Fix the login flow"],
    ["33333333-cccc", "explain the build"],
    ["44444444-dddd", "now run the tests"],
  ]);
  expect(sessions[0]!.updated_at).toBe(
    Date.parse("2026-03-01T00:00:00Z") - 10_000,
  );

  // Without the conversation the session is in, and no more than asked for.
  expect(
    listClaudeSessions(dir, { exclude: "11111111-aaaa", limit: 2 }).map(
      (session) => session.id,
    ),
  ).toEqual(["22222222-bbbb", "33333333-cccc"]);
  expect(listClaudeSessions(join(dir, "missing"))).toEqual([]);
});

test("a transcript is the chain that ends at the last entry", async () => {
  const dir = tempDir();
  const file = storedClaude();
  file.note({ type: "session-owner", sessionId: "s" });
  file.add({ type: "attachment", attachment: { type: "hook" } });
  const first = file.prompt("first");
  file.prompt("skill body", { isMeta: true });
  file.says("m1", [{ type: "text", text: "answer one" }]);
  // A branch the user rewound away from.
  file.prompt("abandoned prompt");
  file.says("m2", [{ type: "text", text: "abandoned answer" }]);
  file.continueFrom(first);
  file.add({ type: "attachment", attachment: { type: "hook" } });
  file.prompt("second");
  file.note({ type: "api-request-blob", message: { uuid: "not-an-entry" } });
  // A sub-agent's messages, as older builds wrote them into the same file.
  const answer = file.says("m3", [{ type: "text", text: "answer two" }]);
  file.says("m4", [{ type: "text", text: "sub-agent" }], { isSidechain: true });
  file.continueFrom(answer);
  file.add({ type: "system", subtype: "turn_duration", durationMs: 5 });
  file.add({ type: "system", subtype: "informational", content: "note" });
  const path = store(dir, "chain", file.text());

  const entries = await entriesOf(path);
  expect(entries.map(gist)).toEqual([
    "first",
    "second",
    "answer two",
    "system/informational",
  ]);
  expect(entries[0]!.timestamp).toBe("2026-01-02T03:04:07.000Z");

  // An empty file and one without a conversation hold nothing.
  expect(await entriesOf(store(dir, "empty", ""))).toEqual([]);
  expect(
    await entriesOf(store(dir, "notes", '{"type":"mode"}\nnot json\n')),
  ).toEqual([]);
  await expect(entriesOf(join(dir, "missing.jsonl"))).rejects.toThrow();
});

test("the history before a compaction is part of the transcript", async () => {
  const dir = tempDir();
  const file = storedClaude();
  file.prompt("before one");
  const kept = file.says("m1", [{ type: "text", text: "answer one" }]);
  // A boundary starts a new chain and names where the old one ended.
  file.continueFrom(null);
  file.add({
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    logicalParentUuid: kept,
  });
  file.prompt("the summary", {
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  });
  file.prompt("after one");
  const head = file.says("m2", [{ type: "text", text: "answer two" }]);
  // A boundary may name an entry written after it; the head of the kept
  // messages then leads back.
  file.continueFrom(null);
  file.add({
    type: "system",
    subtype: "compact_boundary",
    logicalParentUuid: "uuid-9",
    compactMetadata: { preservedSegment: { headUuid: head } },
  });
  file.prompt("the second summary", { isCompactSummary: true });
  file.prompt("after two");
  const path = store(dir, "compacted", file.text());

  expect((await entriesOf(path)).map(gist)).toEqual([
    "before one",
    "answer one",
    "system/compact_boundary",
    "the summary",
    "after one",
    "answer two",
    "system/compact_boundary",
    "the second summary",
    "after two",
  ]);
});

test("results of parallel tool calls are found beside the chain", async () => {
  const dir = tempDir();
  const file = storedClaude();
  file.prompt("do both");
  const one = file.calls("t1", "Read", { file_path: "/a" });
  const two = file.calls("t2", "Read", { file_path: "/b" });
  // Each result hangs off its own call, so the first result is not an
  // ancestor of what follows.
  file.continueFrom(one);
  file.result("t1", "contents of a");
  // A call on a branch the user rewound away from, with its result.
  file.calls("t9", "Bash", { command: "make" });
  file.result("t9", "never shown");
  file.continueFrom(two);
  file.result("t2", "contents of b");
  file.says("m3", [{ type: "text", text: "done" }]);
  const path = store(dir, "parallel", file.text());

  expect((await entriesOf(path)).map(gist)).toEqual([
    "do both",
    "tool_use:t1",
    "tool_use:t2",
    "tool_result:t1",
    "tool_result:t2",
    "done",
  ]);
});

test("only the entries of the newest items are read, whatever the file's size", async () => {
  const dir = tempDir();
  const file = storedClaude();
  for (let turn = 1; turn <= 40; turn++) {
    file.prompt(`prompt ${turn}`);
    // Request records make up most of a real file, and results can be
    // longer than the pieces the file is read in.
    file.note({ type: "api-request-blob", message: "r".repeat(50_000) });
    file.calls(`t${turn}`, "Bash", { command: `echo ${turn}` });
    file.result(`t${turn}`, turn === 39 ? "o".repeat(2_500_000) : "ok", {
      toolUseResult: { stdout: "é".repeat(turn === 40 ? 700_000 : 1) },
    });
    file.says(`m${turn}`, [{ type: "text", text: `answer ${turn}` }]);
  }
  // The file ends without a newline, as one still being written may.
  const path = store(dir, "long", file.text().trimEnd());

  const all = await entriesOf(path);
  expect(all).toHaveLength(160);
  expect(gist(all[0]!)).toBe("prompt 1");
  expect(gist(all.at(-1)!)).toBe("answer 40");
  const big = all.find((entry) => gist(entry) === "tool_result:t39")!;
  expect(
    (big.message as { content: { content: string }[] }).content[0]!.content,
  ).toHaveLength(2_500_000);
  expect((all.at(-2)!.toolUseResult as { stdout: string }).stdout).toBe(
    "é".repeat(700_000),
  );

  // Ten items' worth: the entries they come from and a margin, not the file.
  const newest = await entriesOf(path, 10);
  expect(newest.length).toBeLessThan(24);
  expect(newest.length).toBeGreaterThanOrEqual(10);
  expect(gist(newest.at(-1)!)).toBe("answer 40");
  expect(newest).toEqual(all.slice(-newest.length));
});
