import { appendFileSync } from "node:fs";
import { createLineReader } from "./link";

/** An agent's own protocol line may carry a whole file; nothing sane is longer. */
const AGENT_MAX_LINE_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2000;
/** Appends every protocol line to this file (fixtures, debugging). */
export const AGENT_TRACE_ENV = "THYRA_AGENT_TRACE";

/** The agent child process as adapters see it: lines in, lines out. */
export interface AgentProcess {
  /** Write one protocol line to the agent's stdin. */
  write(line: string): void;
  kill(signal?: NodeJS.Signals): void;
}

export type AgentExit = {
  code: number | null;
  signal: string | null;
  /** The end of what the agent wrote to stderr. */
  stderr: string;
};

export type SpawnAgentArgs = {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  onLine(line: string): void;
  onExit(exit: AgentExit): void;
};

/** Throws when the program cannot be started (not installed). */
export type SpawnAgent = (args: SpawnAgentArgs) => AgentProcess;

/**
 * The environment an agent runs in: the host's, without the variables Herdr's
 * own hook integration keys on (it would claim the pane's agent session and
 * Herdr would then ignore the host's state reports), and with the hint Herdr
 * reads to tell which agent a process is.
 */
export function agentEnvironment(
  kind: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name === "HERDR_ENV") continue;
    out[name] = value;
  }
  out.HERDR_AGENT = kind;
  return out;
}

/**
 * Start the agent with pipes on all three streams. It stays in the host's
 * process group, so the pane's Ctrl+C reaches it and Herdr sees it running
 * in the pane.
 */
export const spawnAgentProcess: SpawnAgent = (args) => {
  const trace = process.env[AGENT_TRACE_ENV];
  const record = (direction: "in" | "out", line: string) => {
    if (!trace) return;
    try {
      appendFileSync(trace, `${JSON.stringify({ direction, line })}\n`);
    } catch {
      // Tracing never interferes with the session.
    }
  };
  const child = Bun.spawn(args.argv, {
    cwd: args.cwd,
    env: args.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderr = "";
  let failure: string | null = null;
  const read = createLineReader(
    (line) => {
      record("out", line);
      args.onLine(line);
    },
    () => {
      failure = "the agent wrote a line too long to read";
      child.kill("SIGKILL");
    },
    AGENT_MAX_LINE_BYTES,
  );
  const stdout = (async () => {
    for await (const chunk of child.stdout) read(chunk);
  })().catch(() => undefined);
  const errors = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(
        -STDERR_TAIL_CHARS,
      );
    }
  })().catch(() => undefined);
  void Promise.all([child.exited, stdout, errors]).then(([code]) => {
    args.onExit({
      code: child.signalCode ? null : code,
      signal: child.signalCode ?? null,
      stderr: failure ?? stderr.trim(),
    });
  });
  return {
    write(line) {
      record("in", line);
      try {
        child.stdin.write(`${line}\n`);
        child.stdin.flush();
      } catch {
        // The agent is gone; its exit is reported through onExit.
      }
    },
    kill(signal = "SIGTERM") {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    },
  };
};

/** Why an agent process ended, for `info.error`; null for a clean exit. */
export function describeAgentExit(name: string, exit: AgentExit): string {
  const how = exit.signal
    ? `was killed by ${exit.signal}`
    : `exited with code ${exit.code ?? "unknown"}`;
  const detail = exit.stderr.split("\n").filter(Boolean).slice(-3).join(" ");
  return `${name} ${how}${detail ? `: ${detail}` : ""}`.slice(0, 600);
}
