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
 * running session, and closing the pane.
 *
 * `--binary` runs a compiled executable instead of the source tree, which
 * also checks the command the launcher types. Needs `herdr` on PATH. Nothing
 * of a live Herdr or Thyra is read or written.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Subprocess } from "bun";

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
