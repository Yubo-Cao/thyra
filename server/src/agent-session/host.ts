import { chmodSync, rmSync } from "node:fs";
import * as net from "node:net";
import {
  AGENT_PROMPT_LIMIT,
  AGENT_SESSION_HISTORY_LIMIT,
  type AgentSessionEvent,
  type AgentSessionKind,
} from "../../../shared/agentSession";
import { type AgentAdapter, AgentActionError } from "./adapter";
import {
  agentEnvironment,
  type SpawnAgent,
  spawnAgentProcess,
} from "./agent-process";
import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { type HerdrReporter, herdrStateOf } from "./herdr-report";
import {
  AGENT_LINK_PROTOCOL,
  type AgentAction,
  createLineReader,
  encodeLine,
  isAgentSessionId,
  parseBridgeMessage,
} from "./link";
import { agentSocketPath, prepareAgentSocketDir } from "./paths";
import { checkPromptImages } from "./prompt-images";
import { PromptQueue } from "./prompt-queue";
import { AgentSessionStore } from "./store";
import { createTerminalLog } from "./terminal-log";

/** A bridge that stops reading is dropped past this much unsent data. */
const CLIENT_BACKLOG_LIMIT_BYTES = 32 * 1024 * 1024;
/** Actions are a line of JSON; a prompt is the longest. */
const ACTION_MAX_LINE_BYTES = AGENT_PROMPT_LIMIT * 4 + 4096;
const STOP_GRACE_MS = 3000;

export type AgentHostOptions = {
  kind: AgentSessionKind;
  /** Arguments passed on to the agent. */
  args: string[];
  paneId: string;
  herdrSocketPath: string;
  cwd: string;
  socketDir: string;
  env?: Record<string, string | undefined>;
  /** Where the running log goes (the pane's terminal). */
  write?: (text: string) => void;
  spawn?: SpawnAgent;
  /** Reports the agent's state to Herdr; absent in tests and probes. */
  reporter?: HerdrReporter | null;
};

/** Whether something accepts connections on a Unix socket path. */
function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection({ path });
    probe.on("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.on("error", () => resolve(false));
  });
}

/**
 * The process behind `thyra agent <kind>`: owns the agent, keeps the session
 * in memory and serves it on the pane's socket. It lives in the pane, not in
 * the bridge, so a session survives every bridge restart.
 */
export async function startAgentHost(options: AgentHostOptions) {
  prepareAgentSocketDir(options.socketDir);
  const socketPath = agentSocketPath(
    options.socketDir,
    options.herdrSocketPath,
    options.paneId,
  );
  if (await socketIsLive(socketPath))
    throw new Error(
      `an agent session is already running in pane ${options.paneId}`,
    );
  // Left behind by a host that was killed.
  rmSync(socketPath, { force: true });

  const clients = new Set<net.Socket>();
  const log = createTerminalLog(options.write ?? (() => undefined));
  const reporter = options.reporter ?? null;
  let finished = false;
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const store = new AgentSessionStore({
    info: {
      pane_id: options.paneId,
      kind: options.kind,
      cwd: options.cwd,
      started_at: Date.now(),
      modes: [],
      can_resume: true,
      can_attach_images: true,
      can_set_model: true,
      can_queue: true,
      can_compact: true,
    },
    onEvent: publish,
  });

  function publish(event: AgentSessionEvent) {
    log.event(event);
    if (event.type === "info") {
      reportState();
      // After this event is out: a queued prompt may go now.
      queueMicrotask(() => queue.drain());
    }
    if (clients.size === 0) return;
    const line = encodeLine({ type: "event", event });
    for (const client of clients) {
      client.write(line);
      if (client.writableLength > CLIENT_BACKLOG_LIMIT_BYTES) client.destroy();
    }
  }

  function reportState() {
    if (!reporter) return;
    const { status } = store.info;
    if (status === "exited") void reporter.release();
    else
      reporter.report(
        herdrStateOf(status),
        status === "awaiting_approval" ? store.approvals[0]?.title : undefined,
      );
  }

  let agentExited = false;
  let launching = true;
  let failedToStart = false;
  let stopping = false;
  const adapterOptions = {
    store,
    cwd: options.cwd,
    args: options.args,
    env: agentEnvironment(options.kind, options.env),
    spawn: options.spawn ?? spawnAgentProcess,
    onExit(error?: string) {
      agentExited = true;
      if (finished || stopping) return;
      if (launching) {
        // The agent could not be started at all: nothing to keep open.
        failedToStart = true;
        return;
      }
      if (error) {
        // A crash keeps the transcript readable until the pane closes.
        log.line(
          "- The transcript stays open in Thyra. Press Ctrl+C to close.",
        );
        return;
      }
      void shutdown();
    },
  };
  // Constructing an adapter validates the agent's arguments.
  const adapter: AgentAdapter =
    options.kind === "claude"
      ? new ClaudeAdapter(adapterOptions)
      : new CodexAdapter(adapterOptions);

  const queue = new PromptQueue(store, (text, images) =>
    adapter.send(text, images),
  );

  // Each adapter call is awaited where it is made, so a refusal always has
  // a handler by the time it is raised. What an action answers is returned.
  async function act(action: AgentAction): Promise<unknown> {
    switch (action.action) {
      case "send": {
        if (action.text.length > AGENT_PROMPT_LIMIT)
          throw new AgentActionError("the prompt is too long");
        // Checked here, before anything reaches the agent: one bad image
        // refuses the whole prompt.
        const images = await checkPromptImages(action.images ?? []);
        if (!action.text.trim() && images.length === 0)
          throw new AgentActionError("empty prompt");
        const delivery = action.delivery ?? "steer";
        // A queued prompt also waits behind the ones queued before it.
        if (
          (delivery !== "steer" && store.phase === "running") ||
          (delivery === "queue" && queue.size > 0)
        ) {
          queue.add(action.text, images, delivery === "interrupt");
          if (delivery === "interrupt") await adapter.interrupt();
          return;
        }
        await adapter.send(action.text, images);
        return;
      }
      case "unqueue":
        if (!queue.remove(action.prompt_id))
          throw new AgentActionError("that prompt is no longer queued");
        return;
      case "interrupt":
        await adapter.interrupt();
        return;
      case "approve":
        await adapter.approve(action.approval_id, action.option_id);
        return;
      case "set_mode":
        await adapter.setMode(action.mode);
        return;
      case "set_model":
        await adapter.setModel(action.model);
        return;
      case "set_effort":
        await adapter.setEffort(action.effort);
        return;
      case "compact":
        if (store.phase === "running")
          throw new AgentActionError(
            "a turn is running; wait for it or interrupt it first",
          );
        await adapter.compact();
        return;
      case "history":
        return (await adapter.history()).slice(0, AGENT_SESSION_HISTORY_LIMIT);
      case "resume":
        if (!isAgentSessionId(action.session_id))
          throw new AgentActionError("not a conversation ID");
        await adapter.resume(action.session_id);
        return;
    }
  }

  async function answer(socket: net.Socket, id: number, action: AgentAction) {
    let error: string | undefined;
    let value: unknown;
    try {
      value = await act(action);
    } catch (failure) {
      error =
        failure instanceof Error && failure.message
          ? failure.message
          : "the action failed";
    }
    socket.write(
      encodeLine({
        type: "result",
        id,
        ...(error ? { error } : value !== undefined ? { value } : {}),
      }),
    );
  }

  const server = net.createServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.on("close", () => clients.delete(socket));
    // The snapshot and every later event go out in order: both are written
    // synchronously, and events only reach sockets already in `clients`.
    socket.write(
      encodeLine({
        type: "hello",
        protocol: AGENT_LINK_PROTOCOL,
        pane_id: options.paneId,
        herdr_socket: options.herdrSocketPath,
        pid: process.pid,
        snapshot: store.snapshot(),
      }),
    );
    clients.add(socket);
    socket.on(
      "data",
      createLineReader(
        (line) => {
          const message = parseBridgeMessage(line);
          if (message) void answer(socket, message.id, message);
        },
        () => socket.destroy(),
        ACTION_MAX_LINE_BYTES,
      ),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    // The directory already keeps other users out.
  }

  /** Stop the agent, tell Herdr, and remove the socket. Safe to call twice. */
  async function shutdown() {
    if (stopping) return closed;
    stopping = true;
    if (!agentExited) {
      adapter.stop();
      const deadline = Date.now() + STOP_GRACE_MS;
      while (!agentExited && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (!agentExited) adapter.stop(true);
    }
    store.setPhase("exited");
    store.flushDeltas();
    store.dispose();
    await reporter?.release();
    for (const client of clients) client.end();
    server.close();
    rmSync(socketPath, { force: true });
    finished = true;
    finish();
    return closed;
  }

  log.line(
    `thyra agent: ${options.kind} session in ${options.cwd} (pane ${options.paneId})`,
  );
  reportState();
  adapter.start();
  launching = false;
  if (failedToStart) await shutdown();

  return {
    socketPath,
    store,
    /** The agent never started; the reason is in `store.info.error`. */
    failedToStart,
    /** Resolves once the host has shut down. */
    closed,
    shutdown,
  };
}

export type AgentHost = Awaited<ReturnType<typeof startAgentHost>>;
