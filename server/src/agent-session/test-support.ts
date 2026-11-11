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

/** An agent process that only records what it is sent. */
export function fakeAgent() {
  let args: SpawnAgentArgs | null = null;
  const written: Record<string, any>[] = [];
  const killed: string[] = [];
  const spawn: SpawnAgent = (spawnArgs) => {
    args = spawnArgs;
    return {
      write: (line) => written.push(JSON.parse(line)),
      kill: (signal = "SIGTERM") => killed.push(signal),
    };
  };
  return {
    spawn,
    written,
    killed,
    get argv() {
      return args?.argv ?? [];
    },
    get env() {
      return args?.env ?? {};
    },
    /** The agent writes one protocol message. */
    say(message: unknown) {
      args?.onLine(JSON.stringify(message));
    },
    exit(exit: Partial<AgentExit> = {}) {
      args?.onExit({ code: 0, signal: null, stderr: "", ...exit });
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
  return {
    messages,
    isClosed: () => closed,
    /** Send an action and wait for its result (the error text, or null). */
    async act(action: AgentAction): Promise<string | null> {
      const id = nextId++;
      socket.write(`${JSON.stringify({ type: "action", id, ...action })}\n`);
      const result = await until(
        () =>
          messages.find(
            (message) => message.type === "result" && message.id === id,
          ),
        "an action result",
      );
      return result.type === "result" ? (result.error ?? null) : null;
    },
    write: (text: string) => socket.write(text),
    close: () => socket.destroy(),
  };
}
