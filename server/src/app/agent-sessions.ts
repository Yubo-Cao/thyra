import type { ServerWebSocket } from "bun";
import {
  AGENT_SESSION_EVENT,
  AGENT_SESSION_HISTORY_LIMIT,
  AGENT_SESSIONS_CHANGED,
  type AgentSessionEvent,
  type AgentSessionInfo,
  type AgentSessionSnapshot,
  type AgentStoredSession,
} from "../../../shared/agentSession";
import type { AgentAction } from "../agent-session/link";
import { agentSocketDir } from "../agent-session/paths";
import {
  type AgentSessionRelay,
  createAgentSessionRelay,
  type VerifyAgentPane,
} from "../agent-session/relay";
import { workspaceOfScopedId } from "../authz/authorize";
import {
  filterListResult,
  type PaneScope,
  type RoleOf,
} from "../authz/filters";
import type { ClientRegistry } from "../bridge/client-registry";
import { serializeConnectionEnvelope } from "../connections/protocol";
import type { Logger } from "../utils/logger";

const CHANGED_DEBOUNCE_MS = 25;

type Socket = ServerWebSocket<unknown>;

/** The sessions a viewer may read: `roles` null means every one (admins). */
export function visibleSessions(
  sessions: AgentSessionInfo[],
  roles: RoleOf | null,
  scope: PaneScope | null,
): AgentSessionInfo[] {
  if (!roles) return sessions;
  return (
    filterListResult({ sessions }, roles, scope) as {
      sessions: AgentSessionInfo[];
    }
  ).sessions;
}

/** A host's answer to `history`, kept only as far as it is well formed. */
export function storedSessionsOf(value: unknown): AgentStoredSession[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry): AgentStoredSession[] => {
      const { id, title, updated_at } = (entry ?? {}) as Record<
        string,
        unknown
      >;
      return typeof id === "string" &&
        typeof title === "string" &&
        typeof updated_at === "number"
        ? [{ id, title, updated_at }]
        : [];
    })
    .slice(0, AGENT_SESSION_HISTORY_LIMIT);
}

/**
 * Agent sessions as pages see them: the relay to the hosts, each page's
 * subscriptions, and the events sent to pages. Sessions belong to the default
 * connection when its Herdr runs on this host; other connections have none.
 */
export function createAgentSessionService(deps: {
  logger: Logger;
  registry: Pick<ClientRegistry, "clients" | "safeSend">;
  /** The connection whose panes host sessions, with its Herdr socket. */
  connection: () => {
    id: string;
    generation: number;
    herdrSocketPath: string;
  } | null;
  /** A viewer's role lookup on a connection; null for admins. */
  viewerRoles(ws: Socket, connectionId: string): RoleOf | null;
  /** The pane a guest link is narrowed to, if any. */
  peekScope(ws: Socket, connectionId: string): PaneScope | null;
  /** Confirms with Herdr that a host runs in the pane it names. */
  verifyPane?: VerifyAgentPane;
  socketDir?: string;
  relay?: AgentSessionRelay;
}) {
  const { clients, safeSend } = deps.registry;
  /** Panes each page follows; a closed page is simply never visited again. */
  const subscriptions = new WeakMap<Socket, Set<string>>();
  let changedTimer: ReturnType<typeof setTimeout> | null = null;

  const relay =
    deps.relay ??
    createAgentSessionRelay({
      dir: deps.socketDir ?? agentSocketDir(),
      herdrSocketPath: () => deps.connection()?.herdrSocketPath ?? null,
      logger: deps.logger,
      onEvent: publishEvent,
      onChanged: scheduleChanged,
      verifyPane: deps.verifyPane,
    });

  function canSee(ws: Socket, connectionId: string, paneId: string): boolean {
    const roles = deps.viewerRoles(ws, connectionId);
    if (!roles) return true;
    const workspace = workspaceOfScopedId(paneId);
    if (!workspace || roles(workspace) === null) return false;
    const scope = deps.peekScope(ws, connectionId);
    return !scope || scope.pane === paneId;
  }

  function publishEvent(event: AgentSessionEvent) {
    const connection = deps.connection();
    if (!connection) return;
    let line: string | null = null;
    for (const ws of clients) {
      if (!subscriptions.get(ws)?.has(event.pane_id)) continue;
      // Grants can change after subscribing; each delivery is checked.
      if (!canSee(ws, connection.id, event.pane_id)) continue;
      line ??= serializeConnectionEnvelope(
        connection.id,
        { event: AGENT_SESSION_EVENT, data: event },
        connection.generation,
      );
      safeSend(ws, line, "agent-session-event");
    }
  }

  function scheduleChanged() {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = null;
      publishChanged();
    }, CHANGED_DEBOUNCE_MS);
  }

  function publishChanged() {
    const connection = deps.connection();
    if (!connection) return;
    const sessions = relay.list();
    const live = new Set(sessions.map((session) => session.pane_id));
    for (const ws of clients) {
      // An ended session ends its subscriptions.
      const followed = subscriptions.get(ws);
      if (followed)
        for (const paneId of followed)
          if (!live.has(paneId)) followed.delete(paneId);
      safeSend(
        ws,
        serializeConnectionEnvelope(
          connection.id,
          {
            event: AGENT_SESSIONS_CHANGED,
            data: {
              sessions: visibleSessions(
                sessions,
                deps.viewerRoles(ws, connection.id),
                deps.peekScope(ws, connection.id),
              ),
            },
          },
          connection.generation,
        ),
        "agent-sessions-changed",
      );
    }
  }

  return {
    /** Hosts exist only where `thyra agent` runs: not on Windows. */
    start() {
      if (process.platform !== "win32") relay.start();
    },
    /** Look for hosts now (the connection just became available). */
    rescan: () => relay.rescan(),
    stop() {
      if (changedTimer) clearTimeout(changedTimer);
      changedTimer = null;
      relay.stop();
    },
    /** Whether sessions exist on this connection at all. */
    serves(connectionId: string | null): boolean {
      return connectionId !== null && deps.connection()?.id === connectionId;
    },
    list(roles: RoleOf | null, scope: PaneScope | null): AgentSessionInfo[] {
      return visibleSessions(relay.list(), roles, scope);
    },
    /** The session's info now; null when the pane hosts none. */
    info(paneId: string): AgentSessionInfo | null {
      return relay.info(paneId);
    },
    /** The pane's session now; events for it follow on this socket. */
    subscribe(ws: Socket, paneId: string): AgentSessionSnapshot {
      const snapshot = relay.snapshot(paneId);
      if (!snapshot) throw new Error("no agent session in this pane");
      let followed = subscriptions.get(ws);
      if (!followed) {
        followed = new Set();
        subscriptions.set(ws, followed);
      }
      followed.add(paneId);
      return snapshot;
    },
    unsubscribe(ws: Socket, paneId: string) {
      subscriptions.get(ws)?.delete(paneId);
    },
    /** Pass an action to the pane's host; resolves with what it answers. */
    act(paneId: string, action: AgentAction): Promise<unknown> {
      return relay.act(paneId, action);
    },
    /** The conversations the pane's agent has stored for its directory. */
    async history(paneId: string): Promise<AgentStoredSession[]> {
      return storedSessionsOf(await relay.act(paneId, { action: "history" }));
    },
    /** The relay's callbacks, for a relay created outside (tests). */
    publishEvent,
    publishChanged,
  };
}

export type AgentSessionService = ReturnType<typeof createAgentSessionService>;
