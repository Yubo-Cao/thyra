import * as net from "node:net";
import type {
  AgentSessionKind,
  AgentSessionStatus,
} from "../../../shared/agentSession";

/**
 * Tells Herdr what the pane's agent is doing, through the socket API its
 * hook integrations use (`pane.report_agent`, `pane.release_agent`), so the
 * workspace tree and task notifications see a `thyra agent` pane like one
 * running the agent's own terminal UI.
 */

/** Identifies these reports to Herdr; `herdr:` sources are its own hooks. */
export const HERDR_REPORT_SOURCE = "thyra:agent";
const REPORT_TIMEOUT_MS = 1500;
/**
 * Herdr drops reports for a moment after an agent left the pane (a previous
 * session); the first state is sent again after these delays.
 */
const STARTUP_REPEAT_MS = [1500, 6000];

export type HerdrAgentState = "idle" | "working" | "blocked";

export function herdrStateOf(status: AgentSessionStatus): HerdrAgentState {
  if (status === "running") return "working";
  if (status === "awaiting_approval") return "blocked";
  return "idle";
}

type HerdrRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<void>;

/** One request on its own connection, as Herdr's socket API expects. */
export function herdrSocketRequest(socketPath: string): HerdrRequest {
  return (method, params) =>
    new Promise((resolve) => {
      const socket = net.createConnection({ path: socketPath });
      const done = () => {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      };
      const timer = setTimeout(done, REPORT_TIMEOUT_MS);
      socket.on("error", done);
      socket.on("close", done);
      // Herdr answers with one line and closes; the answer says "ok" even for
      // a report it ignored, so there is nothing to read from it.
      socket.on("data", done);
      socket.on("connect", () => {
        socket.write(
          `${JSON.stringify({ id: `thyra:${Date.now()}`, method, params })}\n`,
        );
      });
    });
}

export function createHerdrReporter(args: {
  paneId: string;
  kind: AgentSessionKind;
  request: HerdrRequest;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  let seq = 0;
  let last: { state: HerdrAgentState; message?: string } | null = null;
  let released = false;
  let repeats: ReturnType<typeof setTimeout>[] = [];
  /** Requests go out one at a time, so Herdr reads them in order. */
  let queue: Promise<void> = Promise.resolve();

  // Herdr keeps the highest sequence number per source and ignores the rest.
  const nextSeq = () => {
    seq = Math.max(seq + 1, now());
    return seq;
  };
  const send = (method: string, params: Record<string, unknown>) => {
    queue = queue
      .then(() =>
        args.request(method, {
          pane_id: args.paneId,
          source: HERDR_REPORT_SOURCE,
          agent: args.kind,
          seq: nextSeq(),
          ...params,
        }),
      )
      .catch(() => undefined);
    return queue;
  };
  const sendState = () => {
    if (!last || released) return;
    void send("pane.report_agent", {
      state: last.state,
      ...(last.message ? { message: last.message } : {}),
    });
  };

  return {
    /** Report a state; repeated states are sent once. */
    report(state: HerdrAgentState, message?: string) {
      if (released) return;
      if (last?.state === state && last.message === message) return;
      const first = last === null;
      last = { state, ...(message ? { message } : {}) };
      for (const timer of repeats) clearTimeout(timer);
      repeats = first
        ? STARTUP_REPEAT_MS.map((delay) => setTimeout(sendState, delay))
        : [];
      sendState();
    },
    /** The agent is gone: clear its name and state from the pane. */
    release(): Promise<void> {
      if (released) return queue;
      released = true;
      for (const timer of repeats) clearTimeout(timer);
      repeats = [];
      return send("pane.release_agent", {});
    },
  };
}

export type HerdrReporter = ReturnType<typeof createHerdrReporter>;
