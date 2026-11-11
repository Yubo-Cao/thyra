/**
 * Drives real agent sessions end to end, outside the automated suite:
 *
 *   bun scripts/agent-session-probe.ts [claude] [codex] [--herdr] [--keep] [--trace]
 *
 * For each agent it starts `thyra agent <kind>` in a throwaway Git repository,
 * connects to the host's socket as the bridge would, and checks a turn that
 * edits a file and runs a command (answering the approvals), streaming,
 * interrupting, mode changes and a denied approval, then prints the
 * normalized transcript.
 *
 * With `--herdr` the host runs in a pane of a throwaway Herdr server, and the
 * probe also checks what Herdr shows for that pane (agent name; idle, working
 * and blocked) at each step. `--trace` keeps every protocol line the agent
 * and the host exchanged.
 *
 * The agents run with the real login in HOME and spend real quota (a few
 * small turns each). Nothing else is shared with a live installation: the
 * host gets a socket directory in the temporary root, and either a made-up
 * pane and a Herdr socket that does not exist, or the throwaway Herdr's.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AGENT_TRACE_ENV } from "../server/src/agent-session/agent-process";
import type {
  AgentAction,
  HostMessage,
} from "../server/src/agent-session/link";
import {
  AGENT_SOCKET_DIR_ENV,
  agentSocketPath,
} from "../server/src/agent-session/paths";
import { SessionMirror } from "../server/src/agent-session/transcript";
import { shQuote } from "../server/src/utils/process-utils";
import type {
  AgentApproval,
  AgentItem,
  AgentSessionEvent,
  AgentSessionKind,
  AgentSessionSnapshot,
} from "../shared/agentSession";

const { values: options, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    herdr: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
  },
  allowPositionals: true,
});
const kinds = (
  positionals.length > 0 ? positionals : ["claude", "codex"]
) as AgentSessionKind[];

/** Arguments that keep the probe small and make the agents ask. */
const AGENT_ARGS: Record<AgentSessionKind, string[]> = {
  // Project settings only: a user-level hook or plugin that answers
  // permission prompts would leave nothing to approve.
  claude: ["--model", "haiku", "--setting-sources", "project,local"],
  codex: ["-a", "untrusted", "-s", "read-only"],
};
/** Each agent is told to use its file-editing tool, not a shell redirect. */
const EDIT_PROMPT: Record<AgentSessionKind, string> = {
  claude:
    "Use the Write tool to create a file named notes.txt containing exactly two lines, alpha and beta.",
  codex:
    "Use apply_patch to create a file named notes.txt containing exactly two lines, alpha and beta.",
};
const ENTRY = join(import.meta.dir, "../server/src/index.ts");
const TURN_TIMEOUT_MS = 180_000;

type Check = { name: string; ok: boolean; detail?: string };
type HerdrPane = { agent?: string; agent_status?: string };

/** A running host, started directly or in a pane of a throwaway Herdr. */
type Launched = {
  socketPath: string;
  /** What Herdr shows for the host's pane (`--herdr` only). */
  herdrPane?: () => Promise<HerdrPane>;
  /** End the host; resolves with its exit code when that is known. */
  stop(): Promise<number | null>;
  /** What the host printed in its pane. */
  paneLog(): Promise<string>;
  cleanup(): Promise<void>;
};

function isolatedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // A live Herdr or Thyra, and the session this probe may be run from.
    if (/^(HERDR_|THYRA_|CLAUDE|CODEX_)/.test(name)) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false> | T | null | false,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

/** The host as a child process with a made-up pane and no Herdr. */
function launchDirect(
  kind: AgentSessionKind,
  root: string,
  work: string,
  hostEnv: Record<string, string>,
): Launched {
  const herdrSocket = join(root, "no-herdr.sock");
  const paneId = "w1:p1";
  const host = Bun.spawn(
    [process.execPath, ENTRY, "agent", kind, ...AGENT_ARGS[kind]],
    {
      cwd: work,
      env: isolatedEnv({
        ...hostEnv,
        HERDR_PANE_ID: paneId,
        HERDR_SOCKET_PATH: herdrSocket,
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const terminal = Promise.all([
    new Response(host.stdout).text(),
    new Response(host.stderr).text(),
  ]).then((parts) => parts.join(""));
  return {
    socketPath: agentSocketPath(
      hostEnv[AGENT_SOCKET_DIR_ENV]!,
      herdrSocket,
      paneId,
    ),
    async stop() {
      host.kill("SIGTERM");
      return Promise.race([host.exited, Bun.sleep(8000).then(() => null)]);
    },
    paneLog: () => terminal,
    async cleanup() {
      host.kill("SIGKILL");
    },
  };
}

/** The host typed into a pane of a Herdr server started for this probe. */
async function launchInHerdr(
  kind: AgentSessionKind,
  root: string,
  work: string,
  hostEnv: Record<string, string>,
): Promise<Launched> {
  const herdrRoot = join(root, `${kind}-herdr`);
  const env = isolatedEnv({
    HOME: join(herdrRoot, "home"),
    XDG_CONFIG_HOME: join(herdrRoot, "xdg"),
  });
  Bun.spawnSync(["mkdir", "-p", env.HOME!, env.XDG_CONFIG_HOME!]);
  const herdrSocket = join(env.XDG_CONFIG_HOME!, "herdr", "herdr.sock");
  const server = Bun.spawn(["herdr", "server"], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  const herdr = async (...args: string[]) => {
    const child = Bun.spawn(["herdr", ...args], {
      env,
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
  };
  await waitFor("the throwaway Herdr", () => existsSync(herdrSocket));
  const created = JSON.parse(
    await herdr("workspace", "create", "--cwd", work, "--label", "probe"),
  );
  const paneId = created.result.root_pane.pane_id as string;
  // The pane's shell has the throwaway HOME; only the host gets the real
  // one, for the agent's login.
  const command = [
    "env",
    `HOME=${homedir()}`,
    ...Object.entries(hostEnv).map(([name, value]) => `${name}=${value}`),
    process.execPath,
    ENTRY,
    "agent",
    kind,
    ...AGENT_ARGS[kind],
  ]
    .map(shQuote)
    .join(" ");
  await herdr("pane", "run", paneId, command);
  const socketPath = agentSocketPath(
    hostEnv[AGENT_SOCKET_DIR_ENV]!,
    herdrSocket,
    paneId,
  );
  return {
    socketPath,
    async herdrPane() {
      const pane = JSON.parse(await herdr("pane", "get", paneId)).result.pane;
      return { agent: pane.agent, agent_status: pane.agent_status };
    },
    async stop() {
      await herdr("pane", "send-keys", paneId, "ctrl+c");
      await waitFor("the host to exit", () => !existsSync(socketPath), 8000);
      return null;
    },
    paneLog: () =>
      herdr("pane", "read", paneId, "--source", "recent", "--lines", "200"),
    async cleanup() {
      await herdr("server", "stop").catch(() => undefined);
      await Promise.race([server.exited, Bun.sleep(3000)]);
      server.kill("SIGKILL");
    },
  };
}

/** The bridge's side of the host link: a mirror of the session and actions. */
async function connect(socketPath: string) {
  const socket = net.createConnection({ path: socketPath });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let mirror: SessionMirror | null = null;
  const events: { at: number; event: AgentSessionEvent }[] = [];
  const waiters = new Set<() => void>();
  const pending = new Map<number, (error?: string) => void>();
  let nextId = 1;
  let buffer = "";
  let closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end === -1) break;
      const message = JSON.parse(buffer.slice(0, end)) as HostMessage;
      buffer = buffer.slice(end + 1);
      if (message.type === "hello")
        mirror = new SessionMirror(message.snapshot);
      else if (message.type === "event") {
        events.push({ at: Date.now(), event: message.event });
        if (!mirror?.apply(message.event))
          throw new Error(`event out of order: seq ${message.event.seq}`);
      } else {
        pending.get(message.id)?.(message.error);
        pending.delete(message.id);
      }
      for (const wake of [...waiters]) wake();
    }
  });
  socket.on("close", () => {
    closed = true;
    for (const wake of [...waiters]) wake();
  });
  const snapshot = (): AgentSessionSnapshot => {
    if (!mirror) throw new Error("no snapshot yet");
    return mirror.snapshot();
  };
  return {
    events,
    snapshot,
    act(action: AgentAction): Promise<void> {
      const id = nextId++;
      socket.write(`${JSON.stringify({ type: "action", id, ...action })}\n`);
      return new Promise((resolve, reject) =>
        pending.set(id, (error) =>
          error ? reject(new Error(error)) : resolve(),
        ),
      );
    },
    /** Wait until the session satisfies a condition. */
    async until<T>(
      what: string,
      probe: (snapshot: AgentSessionSnapshot) => T | null | undefined | false,
      timeoutMs = TURN_TIMEOUT_MS,
    ): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = mirror ? probe(mirror.snapshot()) : null;
        if (value) return value;
        if (closed) throw new Error(`host closed while waiting for ${what}`);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out waiting for ${what}`);
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            waiters.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, Math.min(left, 1000));
          waiters.add(wake);
        });
      }
    },
    close: () => socket.destroy(),
  };
}

function describeItem(item: AgentItem): string {
  const clip = (value: string, limit = 200) =>
    value.length > limit ? `${value.slice(0, limit)}...` : value;
  const flat = (value: string, limit?: number) =>
    clip(value.replaceAll("\n", "\\n"), limit);
  switch (item.type) {
    case "user":
      return `user      ${clip(item.text)}`;
    case "assistant":
      return `assistant ${flat(item.text)}${item.streaming ? " [streaming]" : ""}`;
    case "thinking":
      return `thinking  ${flat(item.text, 80)}`;
    case "tool":
      return [
        `tool      [${item.kind}/${item.status}] ${item.name}: ${clip(item.title)}`,
        ...(item.command ? [`            command: ${clip(item.command)}`] : []),
        ...(item.diffs ?? []).map(
          (diff) => `            diff ${diff.path}: ${flat(diff.patch, 160)}`,
        ),
        ...(item.output
          ? [`            output: ${flat(item.output, 120)}`]
          : []),
      ].join("\n");
    case "plan":
      return `plan      ${item.entries.map((entry) => `[${entry.status}] ${entry.text}`).join("; ")}`;
    case "notice":
      return `notice    (${item.level}) ${clip(item.text)}`;
  }
}

const indented = (text: string) => text.replace(/^/gm, "    ");

async function probe(kind: AgentSessionKind, root: string): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`,
    );
  };
  const work = join(root, `${kind}-work`);
  const socketDir = join(root, "sockets");
  Bun.spawnSync(["mkdir", "-p", work]);
  Bun.spawnSync(["git", "init", "-q"], { cwd: work });
  const hostEnv = {
    [AGENT_SOCKET_DIR_ENV]: socketDir,
    ...(options.trace
      ? { [AGENT_TRACE_ENV]: join(root, `${kind}-trace.ndjson`) }
      : {}),
  };
  const launched = options.herdr
    ? await launchInHerdr(kind, root, work, hostEnv)
    : launchDirect(kind, root, work, hostEnv);
  /** Check what Herdr shows for the pane, once it has caught up. */
  const herdrShows = async (name: string, statuses: string[]) => {
    if (!launched.herdrPane) return;
    let seen: HerdrPane = {};
    const ok = await waitFor(
      name,
      async () => {
        seen = await launched.herdrPane!();
        return (
          seen.agent === kind && statuses.includes(seen.agent_status ?? "")
        );
      },
      8000,
    ).catch(() => false);
    check(
      `Herdr shows ${name}`,
      ok,
      `agent=${seen.agent} status=${seen.agent_status}`,
    );
  };
  try {
    await waitFor("the host socket", () => existsSync(launched.socketPath));
    const link = await connect(launched.socketPath);
    const approved: AgentApproval[] = [];
    /** Answer every approval of a turn the same way until it ends. */
    const answerUntilIdle = async (
      answer: "allow" | "deny",
      onFirstApproval?: () => Promise<void>,
    ) => {
      for (;;) {
        const state = await link.until(
          "an approval or the end of the turn",
          (s) =>
            s.approvals.length > 0 || s.info.status === "idle" ? s : null,
        );
        const approval = state.approvals[0];
        if (!approval) return;
        if (approved.length === 0) await onFirstApproval?.();
        approved.push(approval);
        const option = approval.options.find((o) => o.kind === answer);
        if (!option) throw new Error(`no ${answer} option offered`);
        await link.act({
          action: "approve",
          approval_id: approval.id,
          option_id: option.id,
        });
        await link.until("the approval to resolve", (s) =>
          s.approvals.every((open) => open.id !== approval.id),
        );
      }
    };

    await link.until("the agent to be ready", (s) => s.info.status === "idle");
    const ready = link.snapshot().info;
    check(
      "session starts idle with modes",
      ready.modes.length > 0,
      `mode=${ready.mode ?? "?"} modes=${ready.modes.map((m) => m.id).join(",")}`,
    );
    await herdrShows("the agent idle", ["idle", "done"]);

    console.log("  turn 1: edit a file and run a command, approving");
    await link.act({
      action: "send",
      text: `${EDIT_PROMPT[kind]} Then run the shell command \`cat notes.txt\`. Reply with one short sentence.`,
    });
    check(
      "send turns the session running",
      link.snapshot().info.status !== "idle",
    );
    await answerUntilIdle("allow", () =>
      herdrShows("the agent blocked on the approval", ["blocked"]),
    );
    const first = link.snapshot();
    const tools = first.items.filter((item) => item.type === "tool");
    const edit = tools.find((item) => item.kind === "edit");
    const command = tools.find(
      (item) => item.kind === "command" || item.kind === "read",
    );
    check(
      "approvals were requested and answered",
      approved.length >= 1,
      approved.map((a) => a.title).join(" | "),
    );
    check(
      "approval points at its tool item",
      approved.some((a) => a.item_id && tools.some((t) => t.id === a.item_id)),
    );
    check(
      "edit tool carries a diff",
      !!edit?.diffs?.[0]?.patch.includes("+alpha"),
      edit ? `${edit.name} ${edit.status}` : "no edit item",
    );
    check(
      "command tool carries command and output",
      !!command?.command && !!command.output?.includes("alpha"),
      command ? `${command.name} ${command.status}` : "no command item",
    );
    check(
      "file was written",
      existsSync(join(work, "notes.txt")) &&
        readFileSync(join(work, "notes.txt"), "utf8").includes("alpha"),
    );
    check(
      "assistant text arrived",
      first.items.some((item) => item.type === "assistant" && !item.streaming),
    );
    check(
      "usage and session ID are reported",
      (first.info.usage?.context_tokens ?? 0) > 0 &&
        !!first.info.agent_session_id,
      JSON.stringify(first.info.usage ?? {}),
    );
    await herdrShows("the agent idle after the turn", ["idle", "done"]);

    console.log("  turn 2: streaming, then interrupt");
    const before = link.events.length;
    await link.act({
      action: "send",
      text: "Write the numbers 1 to 60, one per line, each followed by a five word sentence. Do not use any tools.",
    });
    const deltasSince = () =>
      link.events.slice(before).filter((e) => e.event.type === "delta");
    await link.until("streamed text", () => deltasSince().length >= 6);
    await herdrShows("the agent working", ["working"]);
    const interruptAt = Date.now();
    await link.act({ action: "interrupt" });
    await link.until(
      "idle after interrupt",
      (s) => s.info.status === "idle",
      20_000,
    );
    const deltas = deltasSince();
    const gaps = deltas
      .slice(1)
      .map((e, i) => e.at - deltas[i]!.at)
      .sort((a, b) => a - b);
    const sizes = deltas.map((e) =>
      e.event.type === "delta" ? e.event.text.length : 0,
    );
    check(
      "text streamed as several delta events",
      deltas.length >= 6,
      `${deltas.length} deltas, median gap ${gaps[Math.floor(gaps.length / 2)] ?? 0} ms, mean size ${Math.round(sizes.reduce((sum, size) => sum + size, 0) / deltas.length)} chars`,
    );
    check(
      "interrupt returned the session to idle",
      true,
      `${Date.now() - interruptAt} ms`,
    );
    const second = link.snapshot();
    check(
      "no item is left streaming",
      second.items.every(
        (item) =>
          (item.type !== "assistant" && item.type !== "thinking") ||
          !item.streaming,
      ),
    );
    const interruptedText = second.items.findLast(
      (item) => item.type === "assistant",
    );
    check(
      "the interrupted answer is partial",
      interruptedText?.type === "assistant" &&
        !/\b60\b/.test(interruptedText.text),
    );
    const seq = link.snapshot().seq;
    await link.act({ action: "interrupt" });
    await Bun.sleep(300);
    check("interrupt while idle changes nothing", link.snapshot().seq === seq);

    console.log("  modes");
    const original = second.info.mode;
    const reached: string[] = [];
    const refusedModes: string[] = [];
    for (const mode of second.info.modes) {
      if (mode.id === original) continue;
      try {
        await link.act({ action: "set_mode", mode: mode.id });
        await link.until(
          `mode ${mode.id}`,
          (s) => s.info.mode === mode.id,
          10_000,
        );
        reached.push(mode.id);
      } catch (error) {
        refusedModes.push(`${mode.id}: ${(error as Error).message}`);
      }
    }
    check(
      "set_mode reaches every other mode",
      refusedModes.length === 0 && reached.length > 0,
      refusedModes.join("; ") || reached.join(", "),
    );
    if (original) {
      await link.act({ action: "set_mode", mode: original });
      await link.until(
        "the original mode",
        (s) => s.info.mode === original,
        10_000,
      );
    }
    const refused = await link.act({ action: "set_mode", mode: "none" }).then(
      () => false,
      () => true,
    );
    check("an unknown mode is refused", refused);

    console.log("  turn 3: deny an approval");
    approved.length = 0;
    await link.act({
      action: "send",
      text: "Run the shell command `touch denied.txt` and nothing else.",
    });
    await answerUntilIdle("deny");
    const third = link.snapshot();
    check("the denied turn asked for approval", approved.length >= 1);
    check(
      "the denied tool is marked denied",
      third.items.some(
        (item) => item.type === "tool" && item.status === "denied",
      ),
    );
    check(
      "the denied command did not run",
      !existsSync(join(work, "denied.txt")),
    );
    check("session is idle after the denial", third.info.status === "idle");

    console.log("\n  transcript:");
    for (const item of third.items) console.log(indented(describeItem(item)));
    console.log(`\n  info: ${JSON.stringify(third.info)}`);

    const log = options.herdr ? await launched.paneLog() : "";
    const code = await launched.stop().catch(() => undefined);
    check(
      "the host exits when asked",
      code !== undefined,
      code === null ? undefined : `exit code ${code}`,
    );
    check("the host removed its socket", !existsSync(launched.socketPath));
    if (launched.herdrPane) {
      let seen: HerdrPane = {};
      const released = await waitFor(
        "the pane to be released",
        async () => {
          seen = await launched.herdrPane!();
          return !seen.agent;
        },
        8000,
      ).catch(() => false);
      check(
        "Herdr shows no agent after the host exits",
        released,
        `agent=${seen.agent}`,
      );
    }
    link.close();
    console.log("\n  pane log:");
    console.log(indented(log || (await launched.paneLog())));
  } catch (error) {
    check("probe completed", false, (error as Error).message);
    await launched.stop().catch(() => undefined);
    console.log(indented(await launched.paneLog().catch(() => "")));
  } finally {
    await launched.cleanup();
  }
  return checks;
}

const root = mkdtempSync(join(tmpdir(), "thyra-agent-probe-"));
let failed = 0;
try {
  for (const kind of kinds) {
    console.log(`\n== ${kind}${options.herdr ? " (in Herdr)" : ""} ==`);
    const checks = await probe(kind, root);
    failed += checks.filter((check) => !check.ok).length;
  }
} finally {
  if (options.keep || options.trace) console.log(`\nkept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
console.log(failed === 0 ? "\nall checks passed" : `\n${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
