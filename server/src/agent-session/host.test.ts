import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentSessionKind } from "../../../shared/agentSession";
import { createHerdrReporter } from "./herdr-report";
import { type AgentHost, startAgentHost } from "./host";
import { agentSocketPath } from "./paths";
import {
  connectToHost,
  fakeAgent,
  leaveDeadSocket,
  settle,
  socketRoot,
  storedClaude,
  tinyImage,
  until,
  uploadedImage,
} from "./test-support";

const HERDR = "/nonexistent/herdr.sock";
const roots: string[] = [];
const hosts: AgentHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function hostFor(
  kind: AgentSessionKind = "claude",
  overrides: Partial<Parameters<typeof startAgentHost>[0]> = {},
) {
  const root = overrides.socketDir ?? socketRoot();
  if (!overrides.socketDir) roots.push(root);
  const agent = fakeAgent();
  const terminal: string[] = [];
  const reports: [string, Record<string, unknown>][] = [];
  const host = await startAgentHost({
    kind,
    args: [],
    paneId: "w1:p1",
    herdrSocketPath: HERDR,
    cwd: "/work",
    socketDir: root,
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", PATH: "/bin" },
    write: (text) => terminal.push(text),
    spawn: agent.spawn,
    reporter: createHerdrReporter({
      paneId: "w1:p1",
      kind,
      request: async (method, params) => {
        reports.push([method, params]);
      },
    }),
    ...overrides,
  });
  hosts.push(host);
  // The fake exits when the host asks it to.
  agent.hooks.onKill = (child, signal) =>
    queueMicrotask(() => child.exit({ code: null, signal }));
  return { host, agent, root, terminal, reports };
}

/** Answer Claude's `initialize` so the session becomes idle. */
function initialize(agent: ReturnType<typeof fakeAgent>) {
  agent.say({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: agent.written[0]!.request_id,
      response: { current_permission_mode: "default" },
    },
  });
}

test("a host listens on the pane's private socket and greets with a snapshot", async () => {
  const { host, agent, root } = await hostFor();
  expect(host.socketPath).toBe(agentSocketPath(root, HERDR, "w1:p1"));
  expect(statSync(root).mode & 0o777).toBe(0o700);
  expect(statSync(host.socketPath).mode & 0o777).toBe(0o600);
  // The agent runs without the variable Herdr's own hooks key on.
  expect(agent.env).toEqual({
    HERDR_PANE_ID: "w1:p1",
    PATH: "/bin",
    HERDR_AGENT: "claude",
  });
  const link = await connectToHost(host.socketPath);
  const hello = await until(() => link.messages[0], "the greeting");
  expect(hello).toMatchObject({
    type: "hello",
    protocol: 1,
    pane_id: "w1:p1",
    herdr_socket: HERDR,
    pid: process.pid,
    snapshot: {
      info: {
        pane_id: "w1:p1",
        kind: "claude",
        status: "starting",
        cwd: "/work",
      },
      items: [],
      approvals: [],
    },
  });
  initialize(agent);
  await settle();
  await until(() => link.messages.length >= 3, "the first events");
  // Events continue the snapshot's numbering without a gap.
  expect(
    link.messages
      .slice(1)
      .map((message) =>
        message.type === "event"
          ? [
              message.event.seq,
              message.event.type === "info" && message.event.info.status,
            ]
          : null,
      ),
  ).toEqual([
    [hello.type === "hello" ? hello.snapshot.seq + 1 : 0, "starting"],
    [hello.type === "hello" ? hello.snapshot.seq + 2 : 0, "idle"],
  ]);
  link.close();
});

test("actions reach the agent and report refusals", async () => {
  const { host, agent } = await hostFor();
  initialize(agent);
  const link = await connectToHost(host.socketPath);
  expect(await link.act({ action: "send", text: "hello agent" })).toBeNull();
  expect(agent.written.at(-1)).toMatchObject({
    type: "user",
    message: { role: "user", content: "hello agent" },
  });
  expect(host.store.info.status).toBe("running");
  expect(await link.act({ action: "send", text: "   " })).toBe("empty prompt");
  expect(
    await link.act({ action: "send", text: "x".repeat(256 * 1024 + 1) }),
  ).toBe("the prompt is too long");
  expect(await link.act({ action: "set_mode", mode: "nope" })).toBe(
    "unknown mode: nope",
  );
  expect(
    await link.act({ action: "approve", approval_id: "a", option_id: "allow" }),
  ).toBe("this approval is no longer pending");
  // Lines that are not actions are ignored; the link stays usable.
  link.write('{"type":"nonsense"}\nnot json\n');
  agent.say({ type: "result", subtype: "success", is_error: false });
  const written = agent.written.length;
  // Nothing runs: interrupting is accepted and does nothing.
  expect(await link.act({ action: "interrupt" })).toBeNull();
  expect(agent.written).toHaveLength(written);
  link.close();
});

test("a prompt's images are checked on the host before the agent gets them", async () => {
  const { host, agent, root, terminal } = await hostFor();
  initialize(agent);
  const link = await connectToHost(host.socketPath);
  const png = uploadedImage(root);
  const gif = uploadedImage(root, tinyImage("gif"), "png");
  const before = agent.written.length;

  // One bad image refuses the whole prompt, and nothing is sent.
  const notImage = uploadedImage(root, Buffer.from("plain text"));
  for (const [images, refusal] of [
    [
      [{ path: png }, { path: notImage }],
      "image 2 is not a PNG, JPEG, GIF or WebP file",
    ],
    [[{ path: `${png}.gone` }], "image 1 is no longer on the host"],
    [[{ path: "" }], "image 1 is no longer on the host"],
    [
      Array.from({ length: 11 }, () => ({ path: png })),
      "a prompt takes at most 10 images",
    ],
  ] as const)
    expect(
      await link.act({ action: "send", text: "look", images: [...images] }),
    ).toBe(refusal);
  expect(await link.act({ action: "send", text: "  ", images: [] })).toBe(
    "empty prompt",
  );
  expect(agent.written).toHaveLength(before);
  expect(host.store.snapshot().items).toEqual([]);
  expect(host.store.info.status).toBe("idle");

  expect(
    await link.act({
      action: "send",
      text: "compare [Image #1] with [Image #2]",
      images: [{ path: png }, { path: gif }],
    }),
  ).toBeNull();
  // The agent gets the files' bytes, typed by what they are.
  expect(agent.written.at(-1)!.message.content).toEqual([
    { type: "text", text: "compare [Image #1] with [Image #2]" },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: tinyImage("png").toString("base64"),
      },
    },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/gif",
        data: tinyImage("gif").toString("base64"),
      },
    },
  ]);
  expect(host.store.snapshot().items).toMatchObject([
    {
      type: "user",
      text: "compare [Image #1] with [Image #2]",
      images: [{ path: png }, { path: gif }],
    },
  ]);
  expect(terminal.join("")).toContain(
    "> compare [Image #1] with [Image #2] [2 images]\n",
  );
  // With an image the text may be empty.
  expect(
    await link.act({ action: "send", text: "", images: [{ path: png }] }),
  ).toBeNull();
  expect(agent.written.at(-1)!.message.content).toMatchObject([
    { type: "image" },
  ]);
  link.close();
});

test("history and resume are served over the link", async () => {
  const root = socketRoot();
  roots.push(root);
  const config = join(root, "claude");
  mkdirSync(join(config, "projects", "-work"), { recursive: true });
  const stored = storedClaude();
  stored.prompt("remember mango");
  stored.says("m1", [{ type: "text", text: "I will." }]);
  stored.note({ type: "ai-title", aiTitle: "Remember a fruit" });
  writeFileSync(
    join(config, "projects", "-work", "abc-1.jsonl"),
    stored.text(),
  );
  const { host, agent, terminal } = await hostFor("claude", {
    socketDir: join(root, "sockets"),
    env: { CLAUDE_CONFIG_DIR: config },
  });
  initialize(agent);
  const link = await connectToHost(host.socketPath);
  const hello = await until(() => link.messages[0], "the greeting");
  // Pages ask for history only from hosts that say they serve it.
  expect(hello).toMatchObject({
    protocol: 1,
    snapshot: { info: { can_resume: true, can_attach_images: true } },
  });
  expect(await link.ask({ action: "history" })).toEqual({
    error: null,
    value: [
      {
        id: "abc-1",
        title: "Remember a fruit",
        updated_at: expect.any(Number),
      },
    ],
  });
  // Other actions answer without a value.
  expect(await link.ask({ action: "interrupt" })).toEqual({ error: null });

  expect(await link.ask({ action: "resume", session_id: "abc-1" })).toEqual({
    error: null,
  });
  const events = link.messages.flatMap((message) =>
    message.type === "event" ? [message.event] : [],
  );
  const reset = events.find((event) => event.type === "reset");
  expect(reset).toMatchObject({
    type: "reset",
    items: [
      { type: "user", text: "remember mango" },
      { type: "assistant", text: "I will." },
    ],
  });
  expect(host.store.info).toMatchObject({
    status: "starting",
    agent_session_id: "abc-1",
  });
  expect(agent.children).toHaveLength(2);
  expect(agent.argv.slice(-2)).toEqual(["--resume", "abc-1"]);
  // The replaced process ending is not the session ending.
  await settle();
  expect(host.store.info.status).toBe("starting");
  expect(terminal.join("")).toContain("- resumed abc-1 (2 items)\n");
  expect(terminal.join("")).not.toContain("remember mango");

  // Refusals come back as the action's error.
  expect(await link.act({ action: "resume", session_id: "gone-1" })).toBe(
    "no conversation gone-1 is stored for this directory",
  );
  for (const id of ["../abc-1", "--help", "a b", ""])
    expect(await link.act({ action: "resume", session_id: id })).toBe(
      "not a conversation ID",
    );
  expect(agent.children).toHaveLength(2);
  link.close();
});

test("a late connection gets the current session and only later events", async () => {
  const { host, agent } = await hostFor();
  initialize(agent);
  await settle();
  const first = await connectToHost(host.socketPath);
  await first.act({ action: "send", text: "one" });
  const second = await connectToHost(host.socketPath);
  const hello = await until(() => second.messages[0], "the greeting");
  expect(hello.type === "hello" && hello.snapshot.items).toMatchObject([
    { type: "user", text: "one" },
  ]);
  agent.say({ type: "system", subtype: "status", permissionMode: "plan" });
  await until(() => second.messages[1], "an event");
  expect(second.messages[1]).toMatchObject({
    type: "event",
    event: { type: "info", info: { mode: "plan" } },
  });
  // Both links saw the same event.
  expect(first.messages.at(-1)).toEqual(second.messages[1]!);
  first.close();
  second.close();
});

test("a second host in the same pane is refused; a dead host's socket is replaced", async () => {
  const { host, root } = await hostFor();
  await expect(hostFor("claude", { socketDir: root })).rejects.toThrow(
    "already running in pane w1:p1",
  );
  expect(existsSync(host.socketPath)).toBe(true);
  // Another pane of the same Herdr, and the same pane of another Herdr, are free.
  const other = await hostFor("codex", { socketDir: root, paneId: "w1:p2" });
  expect(other.host.socketPath).not.toBe(host.socketPath);

  const dead = socketRoot();
  roots.push(dead);
  const path = agentSocketPath(dead, HERDR, "w1:p1");
  leaveDeadSocket(path);
  expect(existsSync(path)).toBe(true);
  const revived = await hostFor("claude", { socketDir: dead });
  const link = await connectToHost(revived.host.socketPath);
  await until(() => link.messages[0], "the greeting");
  link.close();
});

test("shutdown stops the agent, releases the pane and removes the socket", async () => {
  const { host, agent, reports, terminal } = await hostFor();
  initialize(agent);
  const link = await connectToHost(host.socketPath);
  await until(() => link.messages[0], "the greeting");
  await host.shutdown();
  expect(agent.killed).toEqual(["SIGTERM"]);
  expect(existsSync(host.socketPath)).toBe(false);
  await until(() => link.isClosed(), "the link to close");
  expect(link.messages.at(-1)).toMatchObject({
    type: "event",
    event: { type: "info", info: { status: "exited" } },
  });
  expect(host.store.info.error).toBeUndefined();
  expect(reports.at(-1)![0]).toBe("pane.release_agent");
  expect(terminal.join("")).toContain("- agent exited");
  // Shutting down twice is harmless.
  await host.shutdown();
});

test("a crashed agent leaves the transcript readable until the host is closed", async () => {
  const { host, agent, terminal, reports } = await hostFor();
  initialize(agent);
  const link = await connectToHost(host.socketPath);
  await link.act({ action: "send", text: "work" });
  agent.exit({ code: 2, stderr: "segfault" });
  await settle();
  expect(host.store.info).toMatchObject({
    status: "exited",
    error: "claude exited with code 2: segfault",
  });
  expect(existsSync(host.socketPath)).toBe(true);
  const later = await connectToHost(host.socketPath);
  const hello = await until(() => later.messages[0], "the greeting");
  expect(hello.type === "hello" && hello.snapshot).toMatchObject({
    info: { status: "exited", error: "claude exited with code 2: segfault" },
    items: [{ type: "user", text: "work" }],
  });
  expect(await later.act({ action: "send", text: "more" })).toBe(
    "the agent has exited",
  );
  expect(terminal.join("")).toContain(
    "! agent exited: claude exited with code 2: segfault",
  );
  expect(terminal.join("")).toContain("Press Ctrl+C to close");
  expect(reports.at(-1)![0]).toBe("pane.release_agent");
  link.close();
  later.close();
});

test("an agent that ends on its own ends the host", async () => {
  const { host, agent } = await hostFor();
  initialize(agent);
  agent.exit({ code: 0 });
  await host.closed;
  expect(existsSync(host.socketPath)).toBe(false);
});

test("an agent that cannot start fails the host with the reason", async () => {
  const root = socketRoot();
  roots.push(root);
  const host = await startAgentHost({
    kind: "claude",
    args: [],
    paneId: "w1:p1",
    herdrSocketPath: HERDR,
    cwd: "/work",
    socketDir: root,
    spawn: () => {
      throw new Error("Executable not found in $PATH: claude");
    },
  });
  expect(host.failedToStart).toBe(true);
  expect(host.store.info.error).toContain("could not start claude");
  await host.closed;
  expect(existsSync(join(root, "x"))).toBe(false);
  expect(existsSync(host.socketPath)).toBe(false);
  // Arguments the agent adapter refuses fail before anything is created.
  await expect(
    startAgentHost({
      kind: "codex",
      args: ["--search"],
      paneId: "w1:p1",
      herdrSocketPath: HERDR,
      cwd: "/work",
      socketDir: root,
    }),
  ).rejects.toThrow("does not support the argument --search");
});

test("Herdr hears idle, working, blocked with its reason, and the release", async () => {
  const { host, agent, reports } = await hostFor();
  initialize(agent);
  await settle();
  const link = await connectToHost(host.socketPath);
  await link.act({ action: "send", text: "go" });
  agent.say({
    type: "control_request",
    request_id: "req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "rm x" },
      tool_use_id: "t1",
    },
  });
  await settle();
  await link.act({
    action: "approve",
    approval_id: "req-1",
    option_id: "allow",
  });
  agent.say({
    type: "result",
    subtype: "success",
    is_error: false,
    queued_turn_count: 0,
  });
  await settle();
  await host.shutdown();
  expect(
    reports.map(([method, params]) => [method, params.state, params.message]),
  ).toEqual([
    ["pane.report_agent", "idle", undefined],
    ["pane.report_agent", "working", undefined],
    ["pane.report_agent", "blocked", "Bash: rm x"],
    ["pane.report_agent", "working", undefined],
    ["pane.report_agent", "idle", undefined],
    ["pane.release_agent", undefined, undefined],
  ]);
  for (const [, params] of reports)
    expect(params).toMatchObject({
      pane_id: "w1:p1",
      source: "thyra:agent",
      agent: "claude",
    });
  const seqs = reports.map(([, params]) => params.seq as number);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
  link.close();
});

test("the pane shows a plain running log", async () => {
  const { host, agent, terminal } = await hostFor();
  initialize(agent);
  const link = await connectToHost(host.socketPath);
  await link.act({ action: "send", text: "fix the bug\nplease" });
  const stream = (event: Record<string, unknown>) =>
    agent.say({ type: "stream_event", event });
  stream({ type: "message_start", message: { id: "msg_1" } });
  stream({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Looking" },
  });
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: " now." },
  });
  stream({ type: "content_block_stop", index: 0 });
  agent.say({
    type: "assistant",
    message: {
      id: "msg_1",
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "Bash",
          input: { command: "make test" },
        },
      ],
    },
  });
  agent.say({
    type: "control_request",
    request_id: "req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "make test" },
      tool_use_id: "t1",
    },
  });
  await settle();
  await link.act({
    action: "approve",
    approval_id: "req-1",
    option_id: "deny",
  });
  agent.say({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          is_error: true,
          content: "rejected",
        },
      ],
    },
  });
  agent.say({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_tools",
  });
  await settle();
  host.store.flushDeltas();
  expect(terminal.join("")).toBe(
    [
      "thyra agent: claude session in /work (pane w1:p1)",
      "",
      "> fix the bug",
      "  please",
      "",
      "Looking now.",
      "* Bash: make test",
      "? approval needed: Bash: make test (answer in Thyra)",
      "  denied: make test",
      "",
    ].join("\n"),
  );
  link.close();
});
