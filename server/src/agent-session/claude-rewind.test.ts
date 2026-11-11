import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentItem } from "../../../shared/agentSession";
import { ClaudeAdapter, claudeArgv, claudeConversationArgs } from "./claude";
import { claudeEntryParent } from "./claude-stored";
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

/** A session in `/work` whose CLI configuration holds these conversations. */
function start(args: string[] = [], stored: Record<string, string> = {}) {
  const config = mkdtempSync(join(tmpdir(), "thyra-crw-"));
  roots.push(config);
  const dir = join(config, "projects", "-work");
  mkdirSync(dir, { recursive: true });
  for (const [id, content] of Object.entries(stored))
    writeFileSync(join(dir, `${id}.jsonl`), content);
  const agent = fakeAgent();
  const { store, events } = sessionStore("claude");
  const adapter = new ClaudeAdapter({
    store,
    cwd: "/work",
    args,
    env: { CLAUDE_CONFIG_DIR: config },
    spawn: agent.spawn,
    onExit: () => undefined,
  });
  adapter.start();
  return { agent, adapter, store, events, dir };
}

async function idle(session: ReturnType<typeof start>) {
  const request = session.agent.written.findLast(
    (message) => message.request?.subtype === "initialize",
  )!;
  session.agent.say({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: request.request_id,
      response: { current_permission_mode: "default" },
    },
  });
  await until(() => session.store.info.status === "idle", "an idle session");
  return session;
}

/** Answer the control request written last. */
function answer(
  agent: ReturnType<typeof fakeAgent>,
  response: Record<string, unknown>,
) {
  const request = agent.written.findLast(
    (message) => message.type === "control_request",
  )!;
  agent.say({
    type: "control_response",
    response: { subtype: "success", request_id: request.request_id, response },
  });
}

/** Three prompts, each answered; returns the file and each prompt's UUID. */
function threeTurns() {
  const file = storedClaude();
  const uuids: string[] = [];
  for (const word of ["apple", "banana", "cherry"]) {
    uuids.push(file.prompt(`remember ${word}`));
    file.says(`m-${word}`, [{ type: "text", text: `OK ${word}` }]);
  }
  return { file, uuids };
}

const texts = (items: AgentItem[]) =>
  items.map((item) =>
    item.type === "user" || item.type === "assistant"
      ? `${item.type}: ${item.text}`
      : item.type,
  );
const refs = (items: AgentItem[]) =>
  items.flatMap((item) => (item.type === "user" ? [item.ref ?? null] : []));

test("--resume-session-at is part of the choice of conversation", () => {
  expect(
    claudeConversationArgs([
      "--model",
      "haiku",
      "--resume",
      "abc-1",
      "--fork-session",
      "--resume-session-at",
      "uuid-3",
    ]),
  ).toEqual({
    others: ["--model", "haiku"],
    resume: "abc-1",
    continues: false,
    at: "uuid-3",
    identity: ["--fork-session", "--resume-session-at", "uuid-3"],
  });
  expect(claudeConversationArgs(["--resume-session-at=uuid-4"])).toMatchObject({
    at: "uuid-4",
    identity: ["--resume-session-at=uuid-4"],
  });
});

test("restored prompts carry their UUIDs; a copy ends where it was cut", async () => {
  const { file, uuids } = threeTurns();
  // A prompt queued into a turn is part of that turn: no point of its own.
  file.add({
    type: "attachment",
    attachment: {
      type: "queued_command",
      commandMode: "prompt",
      prompt: "and also this",
    },
  });
  const whole = await idle(
    start(["--resume", "abc-1"], { "abc-1": file.text() }),
  );
  expect(refs(whole.store.snapshot().items)).toEqual([...uuids, null]);
  whole.agent.exit();

  // `--resume-session-at` the message before the second prompt.
  const parent = await claudeEntryParent(
    join(whole.dir, "abc-1.jsonl"),
    uuids[1]!,
  );
  expect(parent).toBe("uuid-2");
  const copy = await idle(
    start(
      ["--resume", "abc-1", "--fork-session", "--resume-session-at", parent!],
      { "abc-1": file.text() },
    ),
  );
  expect(copy.agent.argv).toEqual(
    claudeArgv([
      "--fork-session",
      "--resume-session-at",
      "uuid-2",
      "--resume",
      "abc-1",
    ]),
  );
  expect(texts(copy.store.snapshot().items)).toEqual([
    "user: remember apple",
    "assistant: OK apple",
  ]);
  copy.agent.exit();
  const missing = start(["--resume", "abc-1", "--resume-session-at", "nope"], {
    "abc-1": file.text(),
  });
  await idle(missing);
  expect(texts(missing.store.snapshot().items)).toEqual(["notice"]);
  missing.agent.exit();
});

test("a rewind the CLI stored ends the restored conversation", async () => {
  const { file } = threeTurns();
  // What the CLI writes when it rewinds to before the second prompt.
  file.note({
    type: "last-prompt",
    leafUuid: "uuid-2",
    explicit: true,
    rewound: true,
    cutUuid: "uuid-3",
  });
  const session = await idle(
    start(["--resume", "abc-1"], { "abc-1": file.text() }),
  );
  expect(texts(session.store.snapshot().items)).toEqual([
    "user: remember apple",
    "assistant: OK apple",
  ]);
  session.agent.exit();
  // A later prompt continues from the cut, and the chain is followed again.
  file.continueFrom("uuid-2");
  file.prompt("remember date");
  const later = await idle(
    start(["--resume", "abc-1"], { "abc-1": file.text() }),
  );
  expect(texts(later.store.snapshot().items)).toEqual([
    "user: remember apple",
    "assistant: OK apple",
    "user: remember date",
  ]);
  later.agent.exit();
  // A rewind to the start leaves nothing.
  const empty = storedClaude();
  empty.prompt("hello");
  empty.note({ type: "last-prompt", leafUuid: null, rewound: true });
  const none = await idle(
    start(["--resume", "abc-2"], { "abc-2": empty.text() }),
  );
  expect(none.store.snapshot().items).toEqual([]);
  none.agent.exit();
});

test("a rewind asks the running CLI to drop the prompt and what follows", async () => {
  const { file, uuids } = threeTurns();
  const session = await idle(
    start(["--resume", "abc-1"], { "abc-1": file.text() }),
  );
  const { agent, adapter, store } = session;
  const third = store
    .snapshot()
    .items.findLast((item) => item.type === "user")!;
  const second = store
    .snapshot()
    .items.filter((item) => item.type === "user")[1]!;

  const rewound = adapter.rewind(second.id);
  await settle();
  expect(agent.written.at(-1)).toMatchObject({
    type: "control_request",
    request: {
      subtype: "rewind_conversation",
      target_message_uuid: uuids[1],
      // The CLI checks that the client saw its latest prompt.
      last_seen_user_message_uuid: uuids[2],
    },
  });
  // The CLI is still closing the turn: asked again a moment later.
  answer(agent, {
    rewound: false,
    error: "turn running",
    reason: "turn_running",
  });
  await until(
    () =>
      agent.written.filter(
        (message) => message.request?.subtype === "rewind_conversation",
      ).length === 2,
    "a second request",
  );
  answer(agent, {
    rewound: true,
    targetMessageUuid: uuids[1],
    prefillText: "remember banana",
  });
  await rewound;
  expect(texts(store.snapshot().items)).toEqual([
    "user: remember apple",
    "assistant: OK apple",
  ]);
  expect(third.type).toBe("user");

  // A refusal is the CLI's reason, and the transcript stays.
  const first = store.snapshot().items[0]!;
  const refused = adapter.rewind(first.id);
  await settle();
  answer(agent, { rewound: false, error: "stale target" });
  await expect(refused).rejects.toThrow(
    "Claude Code did not go back: stale target",
  );
  expect(store.snapshot().items).toHaveLength(2);

  // A prompt sent while idle can be gone back to; one sent into a turn not.
  await adapter.send("remember elder");
  await adapter.send("and fig");
  expect(refs(store.snapshot().items).slice(1)).toEqual([
    agent.written.filter((message) => message.type === "user")[0]!.uuid,
    null,
  ]);
  await expect(adapter.rewind(first.id)).rejects.toThrow("a turn is running");
  agent.exit();
});

test("a branch resumes a copy, cut before the prompt it was taken at", async () => {
  const { file, uuids } = threeTurns();
  const session = await idle(
    start(["--model", "haiku", "--resume", "abc-1"], { "abc-1": file.text() }),
  );
  const { adapter, store } = session;
  const prompts = store.snapshot().items.filter((item) => item.type === "user");
  expect(await adapter.forkArgs()).toEqual([
    "--model",
    "haiku",
    "--resume",
    "abc-1",
    "--fork-session",
  ]);
  expect(await adapter.forkArgs(prompts[2]!.id)).toEqual([
    "--model",
    "haiku",
    "--resume",
    "abc-1",
    "--fork-session",
    "--resume-session-at",
    "uuid-4",
  ]);
  expect(uuids[2]).toBe("uuid-5");
  // Before the first prompt there is nothing to copy: a new conversation.
  expect(await adapter.forkArgs(prompts[0]!.id)).toEqual(["--model", "haiku"]);
  // A prompt the CLI has not stored cannot be branched at.
  store.upsertItem({ id: "x", type: "user", text: "x", ref: "unknown" });
  await expect(adapter.forkArgs("x")).rejects.toThrow("has not stored");
  session.agent.exit();

  // A session with nothing said yet branches into a new one.
  const fresh = await idle(start(["--model", "haiku"]));
  expect(await fresh.adapter.forkArgs()).toEqual(["--model", "haiku"]);
  fresh.agent.exit();
});
