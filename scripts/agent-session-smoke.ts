/**
 * Checks the bridge's side of agent sessions end to end without a real agent
 * (and without spending quota):
 *
 *   bun scripts/agent-session-smoke.ts [--binary server/thyra] [--port 8931] [--keep]
 *
 * It starts a throwaway Herdr server and a Thyra bridge on a spare port with
 * their own HOME and XDG directories, puts a stand-in `claude` on the panes'
 * PATH, and then acts as a page over the WebSocket: the hello capability,
 * `launcher.launch` with the `gui` view, the session list and its change
 * events, subscribing, a turn with streamed events, a bridge restart under a
 * running session, the history of stored conversations and resuming one in
 * place, a prompt with an uploaded image, and closing the pane.
 *
 * `--binary` runs a compiled executable instead of the source tree, which
 * also checks the command the launcher types. Needs `herdr` on PATH. Nothing
 * of a live Herdr or Thyra is read or written.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Subprocess } from "bun";
import { claudeProjectName } from "../server/src/agent-session/claude-stored";

const { values: options } = parseArgs({
  args: process.argv.slice(2),
  options: {
    binary: { type: "string" },
    port: { type: "string", default: "8931" },
    keep: { type: "boolean", default: false },
  },
});
const port = Number(options.port);
const repo = join(import.meta.dir, "..");
const bridgeCommand = options.binary
  ? [resolve(options.binary)]
  : [process.execPath, join(repo, "server/src/index.ts")];
const standIn = join(repo, "server/src/agent-session/fixtures/fake-claude.ts");

const root = mkdtempSync(join(tmpdir(), "thyra-agent-smoke-"));
const dir = (name: string) => {
  const path = join(root, name);
  Bun.spawnSync(["mkdir", "-p", path]);
  return path;
};
const work = dir("work");
const bin = dir("bin");
// Herdr panes and the bridge share this runtime directory, so the bridge
// finds the hosts' sockets where the hosts put them.
const runtime = dir("run");
chmodSync(runtime, 0o700);
Bun.spawnSync(["git", "init", "-q"], { cwd: work });
await Bun.write(
  join(bin, "claude"),
  `#!/bin/sh\nexec "${process.execPath}" "${standIn}" "$@"\n`,
);
chmodSync(join(bin, "claude"), 0o755);

const inherited: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (value === undefined) continue;
  if (/^(HERDR_|THYRA_|CLAUDE|CODEX_|XDG_)/.test(name)) continue;
  inherited[name] = value;
}
const herdrEnv = {
  ...inherited,
  HOME: dir("herdr-home"),
  XDG_CONFIG_HOME: dir("herdr-xdg"),
  XDG_RUNTIME_DIR: runtime,
  PATH: `${bin}:${inherited.PATH ?? ""}`,
};
const bridgeEnv = {
  ...inherited,
  HOME: dir("thyra-home"),
  XDG_CONFIG_HOME: dir("thyra-xdg"),
  XDG_RUNTIME_DIR: runtime,
  HOST: "127.0.0.1",
  PORT: String(port),
};
// A conversation the stand-in "stored" for the work directory, where a pane's
// Claude Code would keep it.
const storedId = "0a1b2c3d-0000-4000-8000-00000000beef";
const storedDir = join(
  herdrEnv.HOME,
  ".claude",
  "projects",
  claudeProjectName(realpathSync(work)),
);
mkdirSync(storedDir, { recursive: true });
await Bun.write(
  join(storedDir, `${storedId}.jsonl`),
  `${[
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      timestamp: "2026-01-02T03:04:05.000Z",
      message: { role: "user", content: "stored prompt" },
    },
    {
      type: "assistant",
      uuid: "u2",
      parentUuid: "u1",
      timestamp: "2026-01-02T03:04:06.000Z",
      message: {
        id: "msg_stored",
        role: "assistant",
        content: [{ type: "text", text: "stored answer" }],
      },
    },
    { type: "ai-title", aiTitle: "A stored conversation" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`,
);
const herdrSocket = join(herdrEnv.XDG_CONFIG_HOME, "herdr", "herdr.sock");
const herdrClientSocket = join(
  herdrEnv.XDG_CONFIG_HOME,
  "herdr",
  "herdr-client.sock",
);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false> | T | null | false,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

async function herdr(...args: string[]): Promise<string> {
  const child = Bun.spawn(["herdr", ...args], {
    env: herdrEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`herdr ${args.join(" ")}: ${err || out}`);
  return out;
}

const running: { bridge: Subprocess | null } = { bridge: null };
async function startBridge() {
  running.bridge = Bun.spawn(
    [
      ...bridgeCommand,
      "--socket-path",
      herdrSocket,
      "--client-socket-path",
      herdrClientSocket,
    ],
    {
      cwd: options.binary ? root : join(repo, "server"),
      env: bridgeEnv,
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await waitFor("the bridge", () =>
    fetch(`http://127.0.0.1:${port}/api/health`).then(
      (response) => response.ok,
      () => false,
    ),
  );
}

/** A page: the socket's hello, its pushed messages, and RPC calls. */
async function openPage() {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?client_session=smoke-${Date.now()}`,
    { headers: { Origin: `http://127.0.0.1:${port}` } } as never,
  );
  const messages: any[] = [];
  const pending = new Map<string, (message: any) => void>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    messages.push(message);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the WebSocket did not open"));
  });
  const hello = await waitFor("the hello", () =>
    messages.find((message) => message.hello),
  );
  let nextId = 1;
  const call = (method: string, params: Record<string, unknown> = {}) => {
    const id = `r${nextId++}`;
    ws.send(
      JSON.stringify({
        id,
        method,
        params,
        connection_id: hello.default_connection_id,
      }),
    );
    return new Promise<any>((resolve, reject) =>
      pending.set(id, (message) =>
        message.error
          ? reject(new Error(message.error.message))
          : resolve(message.result),
      ),
    );
  };
  await waitFor("the connection to be ready", () =>
    call("workspace.list").then(
      () => true,
      () => false,
    ),
  );
  return {
    hello,
    call,
    pushed: (event: string) =>
      messages.filter((message) => message.event === event),
    close: () => ws.close(),
  };
}

const herdrServer = Bun.spawn(["herdr", "server"], {
  env: herdrEnv,
  stdout: "ignore",
  stderr: "ignore",
});
try {
  await waitFor(
    "the throwaway Herdr",
    () => existsSync(herdrSocket) && existsSync(herdrClientSocket),
  );
  await startBridge();
  let page = await openPage();
  check(
    "the hello announces agent_sessions",
    page.hello.capabilities?.agent_sessions === true,
  );
  check(
    "no sessions at first",
    (await page.call("agent_session.list")).sessions.length === 0,
  );

  const launched = await page.call("launcher.launch", {
    path: work,
    agent: "claude",
    view: "gui",
  });
  const pane = launched.pane_id as string;
  check(
    "the launcher's gui view types the host command",
    launched.view === "gui" &&
      launched.command === `${bridgeCommand.join(" ")} agent claude`,
    launched.command,
  );
  await waitFor("the session to be announced", () =>
    page
      .pushed("agent_session.changed")
      .some((message) =>
        message.data.sessions.some((info: any) => info.pane_id === pane),
      ),
  );
  check("agent_session.changed announces the new session", true, pane);
  await waitFor("the agent to be ready", async () =>
    (await page.call("agent_session.list")).sessions.some(
      (info: any) => info.pane_id === pane && info.status === "idle",
    ),
  );

  const snapshot = await page.call("agent_session.subscribe", {
    pane_id: pane,
  });
  check(
    "subscribing returns the snapshot",
    snapshot.info.pane_id === pane && snapshot.info.kind === "claude",
    `status ${snapshot.info.status}, seq ${snapshot.seq}`,
  );
  const announced = page.pushed("agent_session.changed").length;
  await page.call("agent_session.send", { pane_id: pane, text: "hello" });
  const answered = (text: string) => () =>
    page
      .pushed("agent_session.event")
      .some(
        (message) =>
          message.data.type === "item" &&
          message.data.item.type === "assistant" &&
          message.data.item.text === text &&
          !message.data.item.streaming,
      );
  await waitFor("the turn", answered("You said: hello"));
  const events = page.pushed("agent_session.event");
  const seqs = events.map((message) => message.data.seq as number);
  check(
    "events carry the connection and continue the snapshot's numbering",
    events.every(
      (message) =>
        message.connection_id === page.hello.default_connection_id &&
        typeof message.connection_generation === "number",
    ) && seqs.every((seq, index) => seq === snapshot.seq + 1 + index),
    `seq ${seqs[0]}..${seqs.at(-1)}`,
  );
  check(
    "streamed text is relayed as deltas",
    events.some((message) => message.data.type === "delta"),
  );
  await waitFor(
    "the turn's status to be announced",
    () => page.pushed("agent_session.changed").length > announced,
  );
  check("status changes are announced to the page", true);
  await page.call("agent_session.set_mode", { pane_id: pane, mode: "plan" });
  const shown = JSON.parse(await herdr("pane", "get", pane)).result.pane;
  check(
    "Herdr shows the pane as the agent",
    shown.agent === "claude",
    `agent=${shown.agent} status=${shown.agent_status}`,
  );
  const refusal = await page
    .call("agent_session.send", { pane_id: "w9:p9", text: "x" })
    .then(
      () => "",
      (error: Error) => error.message,
    );
  check(
    "a pane without a session is refused",
    refusal.includes("no agent session"),
    refusal,
  );

  page.close();
  running.bridge?.kill("SIGTERM");
  await running.bridge?.exited;
  await startBridge();
  page = await openPage();
  const restored = await waitFor("the session after the restart", async () =>
    (await page.call("agent_session.list")).sessions.find(
      (info: any) => info.pane_id === pane,
    ),
  );
  const transcript = await page.call("agent_session.subscribe", {
    pane_id: pane,
  });
  check(
    "the session survives a bridge restart with its transcript",
    restored.mode === "plan" &&
      transcript.items.some(
        (item: any) =>
          item.type === "assistant" && item.text === "You said: hello",
      ),
    `${transcript.items.length} items`,
  );
  await page.call("agent_session.send", { pane_id: pane, text: "again" });
  await waitFor("the turn after the restart", answered("You said: again"));
  check("the session keeps working after the restart", true);

  check("the session says it can resume", restored.can_resume === true);
  const history = await page.call("agent_session.history", { pane_id: pane });
  check(
    "history lists the directory's stored conversation by its title",
    history.sessions.length === 1 &&
      history.sessions[0].id === storedId &&
      history.sessions[0].title === "A stored conversation",
    JSON.stringify(history.sessions),
  );
  const malformed = await page
    .call("agent_session.resume", { pane_id: pane, session_id: "../x" })
    .then(
      () => "",
      (error: Error) => error.message,
    );
  check(
    "a session ID that is not a plain ID is refused",
    malformed.includes("conversation ID"),
    malformed,
  );
  await page.call("agent_session.resume", {
    pane_id: pane,
    session_id: storedId,
  });
  const reset = await waitFor("the reset event", () =>
    page
      .pushed("agent_session.event")
      .find((message) => message.data.type === "reset"),
  );
  check(
    "resuming replaces the transcript with the stored conversation's",
    reset.data.items.length === 2 &&
      reset.data.items[0].text === "stored prompt" &&
      reset.data.items[0].at === Date.parse("2026-01-02T03:04:05.000Z") &&
      reset.data.items[1].text === "stored answer",
    `${reset.data.items.length} items`,
  );
  await waitFor("the resumed session to be ready", async () =>
    (await page.call("agent_session.list")).sessions.some(
      (info: any) =>
        info.pane_id === pane &&
        info.status === "idle" &&
        info.agent_session_id === storedId,
    ),
  );
  await page.call("agent_session.send", { pane_id: pane, text: "resumed" });
  await waitFor("the turn after resuming", answered("You said: resumed"));
  const continued = await page.call("agent_session.subscribe", {
    pane_id: pane,
  });
  check(
    "the session continues the stored conversation under its ID",
    continued.info.agent_session_id === storedId &&
      continued.info.status !== "exited" &&
      continued.items.map((item: any) => item.text).join("|") ===
        "stored prompt|stored answer|resumed|You said: resumed",
    continued.items.map((item: any) => item.text).join("|"),
  );
  check(
    "the conversation the session is in is not in its own history",
    (await page.call("agent_session.history", { pane_id: pane })).sessions
      .length === 0,
  );

  // A prompt with an image: uploaded as a page uploads one, then attached
  // by the path the upload got. The upload lands in the real /tmp.
  const uploaded = (await (
    await fetch(`http://127.0.0.1:${port}/api/upload-image`, {
      method: "POST",
      headers: { Origin: `http://127.0.0.1:${port}`, "x-image-ext": "png" },
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    })
  ).json()) as { path?: string; error?: string };
  try {
    check(
      "an image uploads to the host",
      typeof uploaded.path === "string",
      uploaded.path ?? uploaded.error,
    );
    await page.call("agent_session.send", {
      pane_id: pane,
      text: "look at [Image #1]",
      images: [{ path: uploaded.path }],
    });
    await waitFor(
      "the turn with an image",
      answered("You said: look at [Image #1] <image/png>"),
    );
    const pictured = await page.call("agent_session.subscribe", {
      pane_id: pane,
    });
    check(
      "the agent gets the image, and the prompt's item names it",
      pictured.items.some(
        (item: any) =>
          item.type === "user" &&
          item.text === "look at [Image #1]" &&
          item.images?.[0]?.path === uploaded.path,
      ),
    );
    const foreign = await page
      .call("agent_session.send", {
        pane_id: pane,
        text: "look",
        images: [{ path: "/etc/hostname" }],
      })
      .then(
        () => "",
        (error: Error) => error.message,
      );
    check(
      "a file that was not uploaded cannot be attached",
      foreign.includes("image 1 is not an uploaded image"),
      foreign,
    );
  } finally {
    if (uploaded.path) rmSync(uploaded.path, { force: true });
  }

  await herdr("pane", "close", pane);
  await waitFor(
    "the session to end",
    async () => (await page.call("agent_session.list")).sessions.length === 0,
  );
  check("closing the pane ends the session", true);
  const left = await Array.fromAsync(
    new Bun.Glob("*.sock").scan(join(runtime, "thyra", "agents")),
  );
  check("the host removed its socket", left.length === 0, left.join(", "));
  page.close();
} catch (error) {
  check("the smoke test completed", false, (error as Error).message);
} finally {
  await herdr("server", "stop").catch(() => undefined);
  running.bridge?.kill("SIGKILL");
  herdrServer.kill("SIGKILL");
  if (options.keep) console.log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
console.log(failed === 0 ? "\nall checks passed" : `\n${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
