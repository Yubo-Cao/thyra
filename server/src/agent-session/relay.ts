import { type FSWatcher, readdirSync, rmSync, statSync, watch } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import type {
  AgentSessionEvent,
  AgentSessionInfo,
  AgentSessionSnapshot,
} from "../../../shared/agentSession";
import type { Logger } from "../utils/logger";
import {
  AGENT_LINK_PROTOCOL,
  type AgentAction,
  createLineReader,
  encodeLine,
  parseHostMessage,
} from "./link";
import {
  herdrSocketKey,
  isPrivateAgentSocketDir,
  parseAgentSocketName,
  prepareAgentSocketDir,
} from "./paths";
import { SessionMirror } from "./transcript";

const SCAN_INTERVAL_MS = 3000;
const SCAN_DEBOUNCE_MS = 50;
const ACTION_TIMEOUT_MS = 45_000;
/** A refused socket this old belongs to a host that is gone, not one starting. */
const STALE_SOCKET_AGE_MS = 5000;
/** How often a session's place in its pane is checked again. */
const REVERIFY_INTERVAL_MS = 10_000;

/**
 * Whether a host process runs in the pane it names: true or false when
 * Herdr answered, null when it could not be asked (checked again later).
 */
export type VerifyAgentPane = (
  paneId: string,
  pid: number,
) => Promise<boolean | null>;

type Link = {
  name: string;
  paneId: string;
  socket: net.Socket;
  /** The session, once the host has greeted this connection. */
  mirror: SessionMirror | null;
  /** The host's process, as it greeted. */
  pid: number;
  /** Herdr confirmed the host runs in this pane; only then is it a session. */
  verified: boolean;
  verifying: boolean;
  verifiedAt: number;
  nextActionId: number;
  actions: Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
};

/**
 * The bridge's side of agent sessions: finds the hosts of one Herdr server by
 * their sockets, keeps a copy of each session current, and passes actions to
 * the host. Hosts outlive the bridge, so everything here is rebuilt from the
 * sockets after a restart.
 */
export function createAgentSessionRelay(args: {
  dir: string;
  /** The control socket of the Herdr server whose panes are served, if any. */
  herdrSocketPath: () => string | null;
  logger: Logger;
  onEvent(event: AgentSessionEvent): void;
  /** A session appeared, ended or changed status. */
  onChanged(): void;
  /**
   * Confirms a host against Herdr. A pane's ID changes when it moves to
   * another workspace and may be given to a new pane later; a host keeps the
   * ID it started with, and must not be taken for that pane's session.
   */
  verifyPane?: VerifyAgentPane;
  scanIntervalMs?: number;
  now?: () => number;
}) {
  const { dir, logger } = args;
  const now = args.now ?? Date.now;
  const links = new Map<string, Link>();
  /** Sockets of hosts found outside their pane, by the file's change time. */
  const rejected = new Map<string, number>();
  let herdrKey: string | null = null;
  let watcher: FSWatcher | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const isSession = (link: Link) => link.mirror !== null && link.verified;

  function session(paneId: string): Link | null {
    for (const link of links.values())
      if (link.paneId === paneId && isSession(link)) return link;
    return null;
  }

  function drop(link: Link, reason?: string) {
    if (links.get(link.name) !== link) return;
    links.delete(link.name);
    link.socket.destroy();
    for (const [id, action] of link.actions) {
      clearTimeout(action.timer);
      action.reject(new Error("the agent session ended"));
      link.actions.delete(id);
    }
    if (reason)
      logger.warn("agent host link dropped", { pane: link.paneId, reason });
    if (isSession(link)) {
      logger.info("agent session ended", { pane: link.paneId });
      args.onChanged();
    }
  }

  /** Ask Herdr whether the host is in its pane, and act on the answer. */
  function verify(link: Link) {
    if (!link.mirror || link.verifying) return;
    const confirmed = () => {
      link.verifiedAt = now();
      if (link.verified || !link.mirror) return;
      link.verified = true;
      logger.info("agent session connected", {
        pane: link.paneId,
        kind: link.mirror.info.kind,
        status: link.mirror.info.status,
      });
      args.onChanged();
    };
    if (!args.verifyPane) return confirmed();
    link.verifying = true;
    args
      .verifyPane(link.paneId, link.pid)
      .catch(() => null)
      .then((inPane) => {
        link.verifying = false;
        if (links.get(link.name) !== link) return;
        if (inPane === true) return confirmed();
        if (inPane === null) return;
        try {
          rejected.set(link.name, statSync(join(dir, link.name)).ctimeMs);
        } catch {
          // The socket is gone already.
        }
        drop(link, "the host is not in this pane");
      });
  }

  /** Remove the socket of a host that is gone; one just starting is left alone. */
  function removeIfStale(path: string) {
    try {
      if (now() - statSync(path).ctimeMs < STALE_SOCKET_AGE_MS) return;
      rmSync(path, { force: true });
      logger.info("removed a stale agent socket", { path });
    } catch {
      // Already gone.
    }
  }

  function connect(name: string, paneId: string) {
    const path = join(dir, name);
    const socket = net.createConnection({ path });
    const link: Link = {
      name,
      paneId,
      socket,
      mirror: null,
      pid: 0,
      verified: false,
      verifying: false,
      verifiedAt: 0,
      nextActionId: 1,
      actions: new Map(),
    };
    links.set(name, link);
    socket.on("error", (error: NodeJS.ErrnoException) => {
      // Nobody listens there (macOS reports a leftover file as ENOTSOCK).
      if (
        (error.code === "ECONNREFUSED" || error.code === "ENOTSOCK") &&
        !link.mirror
      )
        removeIfStale(path);
      drop(link);
    });
    socket.on("close", () => drop(link));
    socket.on(
      "data",
      createLineReader(
        (line) => receive(link, line),
        () => drop(link, "line too long"),
      ),
    );
  }

  function receive(link: Link, line: string) {
    const message = parseHostMessage(line);
    if (!message) return drop(link, "unreadable message");
    if (message.type === "hello") {
      if (
        message.protocol !== AGENT_LINK_PROTOCOL ||
        message.pane_id !== link.paneId ||
        herdrSocketKey(message.herdr_socket) !== herdrKey
      )
        return drop(link, "unexpected greeting");
      link.mirror = new SessionMirror(message.snapshot);
      link.pid = message.pid;
      verify(link);
      return;
    }
    if (message.type === "result") {
      const action = link.actions.get(message.id);
      if (!action) return;
      link.actions.delete(message.id);
      clearTimeout(action.timer);
      if (message.error) action.reject(new Error(message.error));
      else action.resolve(message.value);
      return;
    }
    if (!link.mirror || message.event.pane_id !== link.paneId) return;
    const before = link.mirror.info.status;
    // A gap means lost events: reconnect for a fresh snapshot.
    if (!link.mirror.apply(message.event))
      return drop(link, "event out of order");
    if (!link.verified) return;
    args.onEvent(message.event);
    if (link.mirror.info.status !== before) args.onChanged();
  }

  function scan() {
    if (!running) return;
    const herdrSocket = args.herdrSocketPath();
    const key =
      herdrSocket && isPrivateAgentSocketDir(dir)
        ? herdrSocketKey(herdrSocket)
        : null;
    if (key !== herdrKey) {
      // Another Herdr server (or none): its panes are not these panes.
      for (const link of [...links.values()]) drop(link);
      rejected.clear();
      herdrKey = key;
    }
    if (!key) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of rejected.keys())
      if (!names.includes(name)) rejected.delete(name);
    for (const name of names) {
      const parsed = parseAgentSocketName(name);
      if (!parsed || parsed.herdrKey !== key || links.has(name)) continue;
      if (rejected.has(name)) {
        // The same socket file is the same misplaced host.
        try {
          if (statSync(join(dir, name)).ctimeMs === rejected.get(name))
            continue;
        } catch {
          continue;
        }
        rejected.delete(name);
      }
      connect(name, parsed.paneId);
    }
    for (const link of links.values())
      if (!link.verified || now() - link.verifiedAt >= REVERIFY_INTERVAL_MS)
        verify(link);
  }

  function scheduleScan() {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      scan();
    }, SCAN_DEBOUNCE_MS);
  }

  return {
    start() {
      if (running) return;
      running = true;
      try {
        prepareAgentSocketDir(dir);
        watcher = watch(dir, scheduleScan);
        watcher.on("error", () => {
          watcher?.close();
          watcher = null;
        });
      } catch (error) {
        // The periodic scan still finds hosts once the directory is usable.
        logger.warn("agent socket directory is not watched", {
          error: (error as Error).message,
        });
      }
      interval = setInterval(scan, args.scanIntervalMs ?? SCAN_INTERVAL_MS);
      interval.unref?.();
      scan();
    },
    stop() {
      running = false;
      watcher?.close();
      watcher = null;
      if (interval) clearInterval(interval);
      if (debounce) clearTimeout(debounce);
      interval = null;
      debounce = null;
      for (const link of [...links.values()]) {
        links.delete(link.name);
        link.socket.destroy();
        for (const action of link.actions.values()) {
          clearTimeout(action.timer);
          action.reject(new Error("the bridge is stopping"));
        }
      }
      rejected.clear();
      herdrKey = null;
    },
    /** Look for hosts now instead of at the next directory event. */
    rescan: scan,
    list(): AgentSessionInfo[] {
      return [...links.values()].flatMap((link) =>
        link.mirror && link.verified ? [link.mirror.info] : [],
      );
    },
    snapshot(paneId: string): AgentSessionSnapshot | null {
      return session(paneId)?.mirror?.snapshot() ?? null;
    },
    /**
     * Pass an action to the pane's host: resolves with what the host answers
     * (nothing, for most actions), rejects with its refusal.
     */
    act(paneId: string, action: AgentAction): Promise<unknown> {
      const link = session(paneId);
      if (!link)
        return Promise.reject(new Error("no agent session in this pane"));
      // A host from before these actions existed would never answer them,
      // and one from before prompts took images would send the prompt
      // without them. Its info says which it has.
      const info = link.mirror?.info;
      const missing =
        (action.action === "history" || action.action === "resume") &&
        info?.can_resume !== true
          ? "resume conversations"
          : action.action === "send" &&
              action.images?.length &&
              info?.can_attach_images !== true
            ? "take images"
            : null;
      if (missing)
        return Promise.reject(
          new Error(
            `this agent session was started by an older Thyra and cannot ${missing}; start a new one`,
          ),
        );
      const id = link.nextActionId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          link.actions.delete(id);
          reject(new Error("the agent session did not answer in time"));
        }, ACTION_TIMEOUT_MS);
        link.actions.set(id, { resolve, reject, timer });
        link.socket.write(encodeLine({ type: "action", id, ...action }));
      });
    },
  };
}

export type AgentSessionRelay = ReturnType<typeof createAgentSessionRelay>;

/**
 * `verifyPane` over Herdr's API: the host must be one of the processes in
 * the foreground of the pane it names. A pane Herdr does not know is a
 * definite no; an unreachable Herdr is not an answer.
 */
export function verifyPaneWithHerdr(
  call: (
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>,
): VerifyAgentPane {
  return async (paneId, pid) => {
    try {
      const result = (await call(
        "pane.process_info",
        { pane_id: paneId },
        3000,
      )) as { process_info?: { foreground_processes?: unknown } } | null;
      const processes = result?.process_info?.foreground_processes;
      // No list: this Herdr cannot tell which processes a pane runs.
      if (!Array.isArray(processes) || processes.length === 0) return null;
      return processes.some(
        (process) => (process as { pid?: unknown } | null)?.pid === pid,
      );
    } catch (error) {
      return /^pane_not_found\b/.test((error as Error).message) ? false : null;
    }
  };
}
