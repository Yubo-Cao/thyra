import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { agentSocketPath } from "./paths";
import { connectToHost, socketRoot, until } from "./test-support";

const ENTRY = join(import.meta.dir, "..", "index.ts");
const roots: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/**
 * An environment built from nothing: the suite may itself run inside a Herdr
 * pane, and the host must never see that pane or its socket.
 */
function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    // Nor the deployment's own default arguments.
    THYRA_CONFIG_PATH: "/nonexistent/thyra.env",
    ...extra,
  };
}

async function run(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, ENTRY, "agent", ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("outside a Herdr pane it says so and starts nothing", async () => {
  const result = await run(["claude"], baseEnv());
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("must run inside a Herdr pane");
  expect(result.stderr).toContain("HERDR_PANE_ID");
  const half = await run(["codex"], baseEnv({ HERDR_PANE_ID: "w1:p1" }));
  expect(half.code).toBe(1);
  expect(half.stderr).toContain("must run inside a Herdr pane");
});

test("usage for a missing or unknown agent", async () => {
  const missing = await run([], baseEnv());
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain("Usage: thyra agent <claude|codex>");
  expect((await run(["gemini"], baseEnv())).code).toBe(2);
  const help = await run(["--help"], baseEnv());
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("Usage: thyra agent <claude|codex>");
});

test("a real host process serves its pane's socket, reports to Herdr and cleans up", async () => {
  const root = socketRoot();
  roots.push(root);
  const bin = join(root, "bin");
  const work = join(root, "work");
  const sockets = join(root, "s");
  const record = join(root, "started.json");
  mkdirSync(bin);
  mkdirSync(work);
  // `claude` on PATH is the stand-in agent.
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-claude.ts")}" "$@"\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  // A stand-in Herdr records what the host reports.
  const herdrSocket = join(root, "herdr.sock");
  const reports: any[] = [];
  const herdr = net.createServer((socket) => {
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      reports.push(JSON.parse(chunk.toString()));
      socket.end('{"id":"x","result":{"type":"ok"}}\n');
    });
  });
  await new Promise<void>((resolve) => herdr.listen(herdrSocket, resolve));
  cleanups.push(() => herdr.close());

  const host = Bun.spawn(
    [process.execPath, ENTRY, "agent", "claude", "--model", "fake"],
    {
      cwd: work,
      env: baseEnv({
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w3:p2",
        HERDR_SOCKET_PATH: herdrSocket,
        THYRA_AGENT_SOCKET_DIR: sockets,
        FAKE_AGENT_RECORD: record,
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  cleanups.push(() => host.kill("SIGKILL"));
  const terminal = new Response(host.stdout).text();
  const socketPath = agentSocketPath(sockets, herdrSocket, "w3:p2");
  await until(() => existsSync(socketPath), "the host socket", 15_000);
  const link = await connectToHost(socketPath);
  const statusOf = () =>
    link.messages.flatMap((message) =>
      message.type === "hello"
        ? [message.snapshot.info.status]
        : message.type === "event" && message.event.type === "info"
          ? [message.event.info.status]
          : [],
    );
  await until(
    () => statusOf().at(-1) === "idle",
    "the agent to be ready",
    15_000,
  );

  expect(await link.act({ action: "send", text: "hello there" })).toBeNull();
  await until(
    () => statusOf().includes("running") && statusOf().at(-1) === "idle",
    "the turn",
    15_000,
  );
  const items = link.messages.flatMap((message) =>
    message.type === "event" && message.event.type === "item"
      ? [message.event.item]
      : [],
  );
  expect(items.at(-1)).toMatchObject({
    type: "assistant",
    text: "You said: hello there",
    streaming: false,
  });
  expect(
    link.messages.some(
      (message) => message.type === "event" && message.event.type === "delta",
    ),
  ).toBe(true);
  expect(await link.act({ action: "set_mode", mode: "plan" })).toBeNull();

  // The agent ran in the pane's directory, with the caller's arguments last
  // and without the variable Herdr's own hooks act on.
  const started = JSON.parse(readFileSync(record, "utf8"));
  expect(started.argv.slice(-2)).toEqual(["--model", "fake"]);
  expect(started.argv).toContain("--permission-prompt-tool");
  expect(started).toMatchObject({
    cwd: work,
    herdrEnv: null,
    herdrAgent: "claude",
    herdrPane: "w3:p2",
  });

  host.kill("SIGTERM");
  expect(await host.exited).toBe(143);
  expect(existsSync(socketPath)).toBe(false);
  await until(() => link.isClosed(), "the link to close");
  const log = await terminal;
  expect(log).toContain("> hello there");
  expect(log).toContain("You said: hello there");
  expect(log).toContain("- agent exited");
  // The first state may be repeated while Herdr settles; the order holds.
  const states = reports
    .map((report) => `${report.method} ${report.params.state ?? ""}`.trim())
    .filter((state, index, all) => state !== all[index - 1]);
  expect(states).toEqual([
    "pane.report_agent idle",
    "pane.report_agent working",
    "pane.report_agent idle",
    "pane.release_agent",
  ]);
  for (const report of reports)
    expect(report.params).toMatchObject({
      pane_id: "w3:p2",
      source: "thyra:agent",
      agent: "claude",
    });
}, 60_000);

test("a missing agent program fails with the reason", async () => {
  const root = socketRoot();
  roots.push(root);
  const empty = join(root, "bin");
  mkdirSync(empty);
  const result = await run(["claude"], {
    PATH: empty,
    HOME: process.env.HOME ?? "",
    THYRA_CONFIG_PATH: "/nonexistent/thyra.env",
    HERDR_PANE_ID: "w1:p1",
    HERDR_SOCKET_PATH: join(root, "no-herdr.sock"),
    THYRA_AGENT_SOCKET_DIR: join(root, "s"),
  });
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("! agent exited: could not start claude");
  expect(
    existsSync(
      agentSocketPath(join(root, "s"), join(root, "no-herdr.sock"), "w1:p1"),
    ),
  ).toBe(false);
}, 30_000);

test("a session given no arguments takes the deployment's, even typed by hand", async () => {
  const root = socketRoot();
  roots.push(root);
  const config = join(root, "thyra.env");
  // A pane's shell has not the service's environment: the file counts.
  writeFileSync(config, "THYRA_AGENT_CODEX_ARGS='--bogus-default'\n");
  const env = baseEnv({
    THYRA_CONFIG_PATH: config,
    HERDR_PANE_ID: "w1:p1",
    HERDR_SOCKET_PATH: join(root, "no-herdr.sock"),
    THYRA_AGENT_SOCKET_DIR: join(root, "s"),
  });
  const bare = await run(["codex"], env);
  expect(bare.code).toBe(1);
  expect(bare.stdout + bare.stderr).toContain(
    "does not support the argument --bogus-default",
  );
  // So does a resume; arguments that choose anything else replace them.
  const resumed = await run(["codex", "resume", "--last"], env);
  expect(resumed.stdout + resumed.stderr).toContain("--bogus-default");
  // The environment wins over the file.
  const overridden = await run(["codex"], {
    ...env,
    THYRA_AGENT_CODEX_ARGS: "--other-default",
  });
  expect(overridden.stdout + overridden.stderr).toContain(
    "does not support the argument --other-default",
  );
}, 30_000);
