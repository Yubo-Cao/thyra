import type { SpawnAgent } from "./agent-process";
import type { AgentSessionStore } from "./store";

/**
 * One agent's protocol behind the actions a session offers. An adapter owns
 * the agent process, writes what the agent does into the store, and reports
 * the process ending through `onExit`.
 */
export interface AgentAdapter {
  /** Start the agent process; the store leaves `starting` once it is ready. */
  start(): void;
  /** Start a turn, or steer or queue the prompt when one is running. */
  send(text: string): Promise<void>;
  /** Stop the running turn; nothing happens when none is running. */
  interrupt(): Promise<void>;
  approve(approvalId: string, optionId: string): Promise<void>;
  setMode(mode: string): Promise<void>;
  /**
   * End the agent process (`force`: kill it); its exit still arrives through
   * `onExit`.
   */
  stop(force?: boolean): void;
}

export type AdapterOptions = {
  store: AgentSessionStore;
  cwd: string;
  /** Arguments after `thyra agent <kind>`. */
  args: string[];
  env: Record<string, string>;
  spawn: SpawnAgent;
  /** The agent process ended; `error` says why when it was not asked to. */
  onExit(error?: string): void;
};

/** A request refused because of what the session is doing; shown to the user. */
export class AgentActionError extends Error {}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The first line of a text, shortened to fit a title. */
export function oneLine(value: string, limit = 240): string {
  const line = value.trim().split("\n", 1)[0]!.trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** A path as a title: relative to the working directory when inside it. */
export function displayPath(path: string, cwd: string): string {
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

const INPUT_JSON_LIMIT = 16 * 1024;

/** Tool input the title does not show, as bounded pretty-printed JSON. */
export function remainingInput(
  input: Record<string, unknown>,
  shown: string[],
): string | undefined {
  const rest = Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => !shown.includes(key) && value !== undefined,
    ),
  );
  if (Object.keys(rest).length === 0) return undefined;
  const json = JSON.stringify(rest, null, 2);
  return json.length > INPUT_JSON_LIMIT
    ? `${json.slice(0, INPUT_JSON_LIMIT)}\n…`
    : json;
}
