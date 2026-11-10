import type { ServerWebSocket } from "bun";
import type { Principal } from "../auth/principal";
import type { ConnectionManager } from "../connections/manager";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import type { createIdentityServiceFromEnv } from "../identity/from-env";
import type { Logger } from "../utils/logger";
import {
  sendWebSocketMessage,
  WebSocketCleanupTracker,
} from "./websocket-send";

export type ClientIdentity = ReturnType<
  typeof createIdentityServiceFromEnv<ServerWebSocket<unknown>>
>;

interface WebSocketCleanupSnapshot {
  client: string;
  viewedTerminals: string[];
}

export type ClientRegistry = ReturnType<typeof createClientRegistry>;

/**
 * The browser sockets of this process and the state kept per socket: the
 * principal fixed at upgrade, the presence participant, the log label and
 * the pending RPC outcome. It owns their cleanup and every send to them.
 *
 * The identity service and the connection manager are created after the
 * registry and read when a socket is cleaned up, never at creation.
 */
export function createClientRegistry(deps: {
  logger: Logger;
  clientIdentity: () => ClientIdentity;
  connectionManager: () => ConnectionManager<LegacyConnectionRuntime>;
}) {
  const { logger } = deps;
  const clients = new Set<ServerWebSocket<unknown>>();
  /** Agent-browser VNC sockets: outside `clients`, no RPC or events. */
  const vncSockets = new Map<
    ServerWebSocket<unknown>,
    { message(data: Uint8Array): void; close(): void }
  >();
  /** VS Code sockets (vscode/proxy.ts): outside `clients` like VNC. */
  const vscodeSockets = new Map<
    ServerWebSocket<unknown>,
    { message(data: string | Uint8Array<ArrayBuffer>): void; close(): void }
  >();
  /** Principal of each browser socket, fixed at its upgrade. */
  const socketPrincipals = new WeakMap<ServerWebSocket<unknown>, Principal>();
  /** Principal key owning each live presence participant. */
  const participantPrincipals = new Map<string, string>();
  /**
   * The collaboration service holding each browser socket's presence, so a
   * closed page leaves at once instead of lingering until its lease expires.
   */
  const socketPresence = new Map<
    ServerWebSocket<unknown>,
    LegacyConnectionRuntime["collaboration"]
  >();

  function leaveSocketPresence(ws: ServerWebSocket<unknown>) {
    const collaboration = socketPresence.get(ws);
    socketPresence.delete(ws);
    const participantId = participantIds.get(ws);
    if (
      participantId &&
      ![...clients].some((other) => participantIds.get(other) === participantId)
    )
      participantPrincipals.delete(participantId);
    if (!collaboration || !participantId) return;
    // A page that already reconnected keeps its id on the new socket.
    for (const other of socketPresence.keys()) {
      if (participantIds.get(other) === participantId) return;
    }
    deps.clientIdentity().forgetParticipant(participantId);
    void collaboration
      .call("collaboration.leave", { participant_id: participantId })
      .catch(() => {
        // The runtime may be gone; its lease expires on its own.
      });
  }
  const clientIds = new WeakMap<ServerWebSocket<unknown>, number>();
  /** Presence participant ids are assigned by the bridge, one per socket. */
  const participantIds = new WeakMap<ServerWebSocket<unknown>, string>();
  let nextClientId = 1;

  const rpcOutcomes = new Map<string, { status: "error"; detail?: string }>();

  function clientLabel(ws: ServerWebSocket<unknown>): string {
    const id = clientIds.get(ws);
    return id ? `c${id}` : "unknown";
  }

  function assignClientId(ws: ServerWebSocket<unknown>): string {
    clientIds.set(ws, nextClientId++);
    return clientLabel(ws);
  }

  function rpcOutcomeKey(ws: ServerWebSocket<unknown>, id: string) {
    return `${clientLabel(ws)}\0${id}`;
  }

  function markRpcError(
    ws: ServerWebSocket<unknown>,
    id: string | null | undefined,
    detail?: string,
  ) {
    if (!id) return;
    rpcOutcomes.set(rpcOutcomeKey(ws, id), { status: "error", detail });
  }

  function takeRpcOutcome(ws: ServerWebSocket<unknown>, id: string | null) {
    if (!id) return null;
    const key = rpcOutcomeKey(ws, id);
    const outcome = rpcOutcomes.get(key) ?? null;
    rpcOutcomes.delete(key);
    return outcome;
  }

  /** Browser sockets grouped by device (tabs and merged contexts count once). */
  function countDevices(sockets: Iterable<ServerWebSocket<unknown>>): number {
    const devices = new Set<string>();
    for (const socket of sockets) {
      devices.add(
        deps.clientIdentity().deviceKeyOf(socket) ?? clientLabel(socket),
      );
    }
    return devices.size;
  }

  const webSocketCleanup = new WebSocketCleanupTracker<
    ServerWebSocket<unknown>,
    WebSocketCleanupSnapshot
  >((ws) => {
    const viewedTerminals: string[] = [];
    deps.connectionManager().forEachCurrentRuntime((runtime) => {
      viewedTerminals.push(...runtime.terminalBridge.viewedTerminals(ws));
      runtime.terminalBridge.cleanupWs(ws);
      runtime.shell.unsubscribe(ws);
    });
    const snapshot = {
      client: clientLabel(ws),
      viewedTerminals,
    };
    clients.delete(ws);
    leaveSocketPresence(ws);
    deps.clientIdentity().detach(ws);
    return snapshot;
  });

  function safeSend(
    ws: ServerWebSocket<unknown>,
    payload: string,
    context = "message",
    coalesceKey?: string,
  ): boolean {
    return sendWebSocketMessage(ws, payload, {
      cleanup: () => {
        webSocketCleanup.cleanup(ws);
      },
      coalesceKey,
      context,
      warn: (message) =>
        logger.warn("websocket send failed", {
          detail: message.replace(/^\[bridge\] /, ""),
        }),
    });
  }

  function closeSockets(
    predicate: (principal: Principal) => boolean,
    code: number,
    reason: string,
  ) {
    for (const client of [...clients]) {
      const principal = socketPrincipals.get(client);
      if (!principal || !predicate(principal)) continue;
      webSocketCleanup.cleanup(client);
      client.close(code, reason);
    }
  }

  return {
    clients,
    vncSockets,
    vscodeSockets,
    socketPrincipals,
    participantPrincipals,
    participantIds,
    socketPresence,
    webSocketCleanup,
    safeSend,
    closeSockets,
    clientLabel,
    assignClientId,
    markRpcError,
    takeRpcOutcome,
    countDevices,
  };
}
