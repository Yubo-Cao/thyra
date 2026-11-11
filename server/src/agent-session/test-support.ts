import { mkdtempSync, readFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSessionEvent,
  AgentSessionKind,
} from "../../../shared/agentSession";
import type { AgentExit, SpawnAgent, SpawnAgentArgs } from "./agent-process";
import type { AgentAction, HostMessage } from "./link";
import { AgentSessionStore } from "./store";

/** One line of a recorded agent conversation: to the agent or from it. */
export type FixtureEntry = {
  direction: "in" | "out";
  message: Record<string, any>;
};

/** A recorded transcript from `fixtures/`, made with `THYRA_AGENT_TRACE`. */
export function loadFixture(name: string): FixtureEntry[] {
  return readFileSync(
    join(import.meta.dir, "fixtures", `${name}.ndjson`),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => {
      const entry = JSON.parse(line) as {
        direction: "in" | "out";
        line: string;
      };
      return { direction: entry.direction, message: JSON.parse(entry.line) };
    });
}

/**
 * An agent process that only records what it is sent. `say`, `exit` and the
 * getters speak for the process started last; `children` holds every one, for
 * sessions that replace their process.
 */
export function fakeAgent() {
  const written: Record<string, any>[] = [];
  const killed: string[] = [];
  type Child = {
    argv: string[];
    env: Record<string, string>;
    killed: string[];
    say(message: unknown): void;
    exit(exit?: Partial<AgentExit>): void;
  };
  const children: Child[] = [];
  const hooks: { onKill?: (child: Child, signal: string) => void } = {};
  const spawn: SpawnAgent = (args: SpawnAgentArgs) => {
    const child = {
      argv: args.argv,
      env: args.env,
      killed: [] as string[],
      say: (message: unknown) => args.onLine(JSON.stringify(message)),
      exit: (exit: Partial<AgentExit> = {}) =>
        args.onExit({ code: 0, signal: null, stderr: "", ...exit }),
    };
    children.push(child);
    return {
      write: (line) => written.push(JSON.parse(line)),
      kill: (signal = "SIGTERM") => {
        child.killed.push(signal);
        killed.push(signal);
        hooks.onKill?.(child, signal);
      },
    };
  };
  return {
    spawn,
    written,
    killed,
    children,
    /** Set `onKill` to decide what a signal does to the process it reaches. */
    hooks,
    get argv() {
      return children.at(-1)?.argv ?? [];
    },
    get env() {
      return children.at(-1)?.env ?? {};
    },
    /** The agent writes one protocol message. */
    say(message: unknown) {
      children.at(-1)?.say(message);
    },
    exit(exit: Partial<AgentExit> = {}) {
      children.at(-1)?.exit(exit);
    },
  };
}

export function sessionStore(kind: AgentSessionKind, cwd = "/work") {
  const events: AgentSessionEvent[] = [];
  const store = new AgentSessionStore({
    info: { pane_id: "w1:p1", kind, cwd, started_at: 1, modes: [] },
    onEvent: (event) => events.push(event),
  });
  return { store, events };
}

/** Let promise continuations (adapter requests and their replies) run. */
export async function settle() {
  for (let round = 0; round < 5; round++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/** A private temporary directory for sockets (short: socket paths are). */
export function socketRoot(): string {
  return mkdtempSync(join(tmpdir(), "thyra-ag-"));
}

/** Leave a socket file nobody listens on, as a killed host does. */
export function leaveDeadSocket(path: string) {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"));`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if (child.signalCode !== "SIGKILL")
    throw new Error("could not leave a dead socket");
}

/** Poll until a condition holds; socket readiness has no event to await. */
export async function until<T>(
  probe: () => T | null | undefined | false,
  what = "condition",
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The bridge's end of a host socket, with what the host sent so far. */
export async function connectToHost(path: string) {
  const socket = net.createConnection({ path });
  const messages: HostMessage[] = [];
  let buffer = "";
  let closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end === -1) break;
      messages.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let nextId = 1;
  /** Send an action and wait for its result. */
  async function ask(
    action: AgentAction,
  ): Promise<{ error: string | null; value?: unknown }> {
    const id = nextId++;
    socket.write(`${JSON.stringify({ type: "action", id, ...action })}\n`);
    const result = await until(
      () =>
        messages.find(
          (message) => message.type === "result" && message.id === id,
        ),
      "an action result",
    );
    return result.type === "result"
      ? { error: result.error ?? null, value: result.value }
      : { error: null };
  }
  return {
    messages,
    isClosed: () => closed,
    ask,
    /** Send an action and wait for its result (the error text, or null). */
    act: async (action: AgentAction) => (await ask(action)).error,
    write: (text: string) => socket.write(text),
    close: () => socket.destroy(),
  };
}

/**
 * Builds the file of a stored Claude Code conversation the way the CLI
 * writes one: each entry names the one before it as its parent, and is
 * stamped a second after it.
 */
export function storedClaude(start = "2026-01-02T03:04:05.000Z") {
  const lines: string[] = [];
  let parent: string | null = null;
  let count = 0;
  let time = Date.parse(start);
  /** An entry of the conversation; returns its `uuid`. */
  const add = (entry: Record<string, unknown>): string => {
    const uuid = `uuid-${++count}`;
    time += 1000;
    lines.push(
      JSON.stringify({
        parentUuid: parent,
        isSidechain: false,
        ...entry,
        uuid,
        timestamp: new Date(time).toISOString(),
      }),
    );
    parent = uuid;
    return uuid;
  };
  return {
    add,
    /** A line that is not part of the chain: a title, a request record. */
    note: (entry: Record<string, unknown>) => lines.push(JSON.stringify(entry)),
    prompt: (text: string, extra: Record<string, unknown> = {}) =>
      add({ type: "user", message: { role: "user", content: text }, ...extra }),
    says: (
      message: string,
      blocks: Record<string, unknown>[],
      extra: Record<string, unknown> = {},
    ) =>
      add({
        type: "assistant",
        message: { id: message, role: "assistant", content: blocks },
        ...extra,
      }),
    calls: (id: string, name: string, input: Record<string, unknown>) =>
      add({
        type: "assistant",
        message: {
          id: `msg-${id}`,
          role: "assistant",
          content: [{ type: "tool_use", id, name, input }],
        },
      }),
    result: (
      id: string,
      content: unknown,
      extra: Record<string, unknown> = {},
    ) =>
      add({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content }],
        },
        ...extra,
      }),
    /** The next entry continues from this one (a rewind, or a root). */
    continueFrom: (uuid: string | null) => {
      parent = uuid;
    },
    /** The time of the entry written last, as milliseconds. */
    get time() {
      return time;
    },
    text: () => `${lines.join("\n")}\n`,
  };
}
