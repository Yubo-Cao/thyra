// Connections: the bridge's connection catalog, per-connection session caches,
// switching the active connection, polling, and pause/resume/reconnect.
import {
  bridge,
  type ConnectionStatus,
  type ConnectionSummary,
  parseConnectionSummary,
} from "../api";
import { thyraLocalStorage } from "../browserStorage";
import {
  LEGACY_DEFAULT_CONNECTION_ID,
  migrateLegacyConnectionStorage,
} from "../connectionStorage";
import { t } from "../i18n";
import { clearTabLayouts } from "../tabLayout";
import { disposeTerminalConnection } from "../terminalConnection";
import { action, noticeFor } from "./actions";
import {
  type BridgeStatus,
  captureConnectionLease,
  catalogReadyForConnection,
  emptyServerSessionState,
  jsonDeepEqual,
  replaceState,
  SERVER_SESSION_KEYS,
  type ServerSessionState,
  serverSessionFromState,
  set,
  setCatalogReadyForConnection,
  type State,
  state,
} from "./core";
import { taskCompletionTracker } from "./notifications";
import { storeConnectionPaused } from "./preferences";
import {
  cancelScheduledRefresh,
  clearRefreshQueue,
  lastRefreshStartedAt,
  refreshNow,
  scheduleRefresh,
} from "./refresh";
import {
  reloadWhenUpdatedServerIsReady,
  startUpdatePollingAfterStartup,
  stopUpdatePolling,
} from "./updates";

// Push events and post-action refreshes carry live updates; the metadata poll
// is only a backstop, so it can run slowly and skip ticks while hidden.
const METADATA_POLL_MS = 5000;

let initialized = false;
let metadataTimer: ReturnType<typeof setInterval> | null = null;
let catalogRequestSeq = 0;
let appliedCatalogRequestSeq = 0;
let terminalReattachPending = false;
let connectionRecoveryIntent: "resume" | "reconnect" | null = null;

/** Pure state transition used by the store and deterministic partition tests. */
export function activateConnectionState(
  snapshot: State,
  connectionId: string,
  generation: number,
): State {
  if (connectionId === snapshot.activeConnectionId) {
    return { ...snapshot, connectionGeneration: generation };
  }
  const outgoingIsCataloged = snapshot.connections.some(
    (connection) => connection.id === snapshot.activeConnectionId,
  );
  const oldSession = {
    ...serverSessionFromState(snapshot),
    terminalAttachEpoch: snapshot.terminalAttachEpoch + 1,
  };
  const runtimeGeneration =
    snapshot.connections.find((connection) => connection.id === connectionId)
      ?.generation ?? null;
  const cached = snapshot.sessionsByConnectionId[connectionId];
  const restored =
    cached?.serverRuntimeGeneration === runtimeGeneration &&
    runtimeGeneration !== null
      ? cached
      : emptyServerSessionState(runtimeGeneration);
  const newSession = {
    ...restored,
    endpointAvailability: {},
    terminalAttachEpoch: restored.terminalAttachEpoch + 1,
  };
  return {
    ...snapshot,
    ...newSession,
    activeConnectionId: connectionId,
    connectionGeneration: generation,
    sessionsByConnectionId: {
      ...snapshot.sessionsByConnectionId,
      ...(outgoingIsCataloged
        ? { [snapshot.activeConnectionId]: oldSession }
        : {}),
      [connectionId]: newSession,
    },
    notice: null,
  };
}

interface CatalogSessionReconciliation {
  sessionsByConnectionId: Record<string, ServerSessionState>;
  activeSession: ServerSessionState | null;
  invalidatedConnectionIds: string[];
  activeRuntimeChanged: boolean;
}

/**
 * Bind cached server resources to ConnectionManager generations. This is the
 * production catalog transition and a pure deterministic regression seam.
 */
export function reconcileConnectionCatalogSessions(
  snapshot: State,
  connections: ConnectionSummary[],
): CatalogSessionReconciliation {
  const previousById = new Map(
    snapshot.connections.map((connection) => [connection.id, connection]),
  );
  const sessionsByConnectionId: Record<string, ServerSessionState> = {};
  const invalidatedConnectionIds: string[] = [];
  let activeSession: ServerSessionState | null = null;
  let activeRuntimeChanged = false;

  for (const connection of connections) {
    const cached =
      connection.id === snapshot.activeConnectionId
        ? serverSessionFromState(snapshot)
        : snapshot.sessionsByConnectionId[connection.id];
    const previous = previousById.get(connection.id);
    const initialActiveTag =
      snapshot.connections.length === 0 &&
      connection.id === snapshot.activeConnectionId &&
      !!cached &&
      (cached.serverRuntimeGeneration === null ||
        cached.serverRuntimeGeneration === connection.generation);
    const catalogGenerationChanged =
      previous !== undefined && previous.generation !== connection.generation;
    const cachedGenerationMismatch =
      !!cached &&
      cached.serverRuntimeGeneration !== null &&
      cached.serverRuntimeGeneration !== connection.generation;
    const newCatalogEntry = previous === undefined && !initialActiveTag;
    const invalidated =
      !cached ||
      catalogGenerationChanged ||
      cachedGenerationMismatch ||
      newCatalogEntry;
    const nextSession = invalidated
      ? {
          ...emptyServerSessionState(connection.generation),
          terminalAttachEpoch: (cached?.terminalAttachEpoch ?? 0) + 1,
        }
      : {
          ...cached,
          serverRuntimeGeneration: connection.generation,
        };
    sessionsByConnectionId[connection.id] = nextSession;
    if (invalidated) invalidatedConnectionIds.push(connection.id);
    if (connection.id === snapshot.activeConnectionId) {
      activeSession = nextSession;
      activeRuntimeChanged = invalidated && !initialActiveTag;
    }
  }

  return {
    sessionsByConnectionId,
    activeSession,
    invalidatedConnectionIds,
    activeRuntimeChanged,
  };
}

function serverSessionEqual(
  a: ServerSessionState,
  b: ServerSessionState,
): boolean {
  for (const key of SERVER_SESSION_KEYS) {
    if (a[key] === b[key]) continue;
    if (!jsonDeepEqual(a[key], b[key])) return false;
  }
  return true;
}

export function mergeConnectionCatalog(
  previous: ConnectionSummary[],
  values: unknown[],
): ConnectionSummary[] {
  return values
    .map(parseConnectionSummary)
    .filter(
      (connection): connection is ConnectionSummary => connection !== null,
    )
    .map((connection) => {
      const prior = previous.find((item) => item.id === connection.id);
      if (!prior) return connection;
      if (
        connection.type !== undefined &&
        prior.type !== undefined &&
        connection.type !== prior.type
      ) {
        return {
          ...prior,
          ...connection,
          control_socket_path: connection.control_socket_path,
          client_socket_path: connection.client_socket_path,
          ssh_destination: connection.ssh_destination,
          remote_control_socket_path: connection.remote_control_socket_path,
          remote_client_socket_path: connection.remote_client_socket_path,
        };
      }
      return {
        ...prior,
        ...connection,
        type: connection.type ?? prior.type,
        read_only: connection.read_only ?? prior.read_only,
        auto_connect: connection.auto_connect ?? prior.auto_connect,
        control_socket_path:
          connection.control_socket_path ?? prior.control_socket_path,
        client_socket_path:
          connection.client_socket_path ?? prior.client_socket_path,
        ssh_destination: connection.ssh_destination ?? prior.ssh_destination,
        remote_control_socket_path:
          connection.remote_control_socket_path ??
          prior.remote_control_socket_path,
        remote_client_socket_path:
          connection.remote_client_socket_path ??
          prior.remote_client_socket_path,
      };
    });
}

// --- Polling ---

function startMetadataPolling() {
  if (metadataTimer) return;
  metadataTimer = setInterval(() => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }
    if (state.status === "connected") {
      if (
        catalogReadyForConnection &&
        Date.now() - lastRefreshStartedAt >= METADATA_POLL_MS - 500
      )
        scheduleRefresh();
      void refreshBridgeStatus();
    }
  }, METADATA_POLL_MS);
}

export function stopPolling() {
  stopUpdatePolling();
  cancelScheduledRefresh();
  if (metadataTimer) {
    clearInterval(metadataTimer);
    metadataTimer = null;
  }
  clearRefreshQueue();
}

function startPolling() {
  startMetadataPolling();
  startUpdatePollingAfterStartup();
}

// --- Active connection ---

/** Drop client caches keyed to the outgoing connection lease. */
function forgetLeaseCaches() {
  clearTabLayouts();
}

function detachActiveConnection(sendRemoteDetach: boolean) {
  stopPolling();
  disposeTerminalConnection(
    {
      connectionId: state.activeConnectionId,
      generation: state.connectionGeneration,
    },
    sendRemoteDetach,
  );
}

/** Re-arm polling and fetch fresh metadata for a newly active lease. */
function resumeActiveConnection() {
  if (initialized && !state.connectionPaused && state.status === "connected") {
    startPolling();
    void refreshNow(captureConnectionLease());
    return true;
  }
  return false;
}

export function selectConnectionNow(
  connectionId: string,
  refresh = true,
): boolean {
  if (!connectionId || connectionId === state.activeConnectionId) return false;
  if (
    state.connections.length > 0 &&
    !state.connections.some((connection) => connection.id === connectionId)
  ) {
    return false;
  }
  if (
    state.activeConnectionId === LEGACY_DEFAULT_CONNECTION_ID &&
    typeof localStorage !== "undefined"
  ) {
    migrateLegacyConnectionStorage(thyraLocalStorage, connectionId);
  }
  detachActiveConnection(true);
  forgetLeaseCaches();
  const generation = bridge.setActiveConnection(connectionId);
  replaceState(activateConnectionState(state, connectionId, generation));
  if (refresh) resumeActiveConnection();
  return true;
}

function resetActiveConnectionLease(
  connections: ConnectionSummary[],
  defaultConnectionId: string,
  reconciliation: CatalogSessionReconciliation,
) {
  detachActiveConnection(false);
  forgetLeaseCaches();
  taskCompletionTracker.reset(state.activeConnectionId);
  const generation = bridge.advanceActiveConnectionGeneration();
  const runtimeGeneration =
    connections.find((connection) => connection.id === state.activeConnectionId)
      ?.generation ?? null;
  const activeSession =
    reconciliation.activeSession ?? emptyServerSessionState(runtimeGeneration);
  replaceState({
    ...state,
    ...activeSession,
    connections,
    defaultConnectionId,
    connectionGeneration: generation,
    sessionsByConnectionId: {
      ...reconciliation.sessionsByConnectionId,
      [state.activeConnectionId]: activeSession,
    },
    notice: null,
  });
  resumeActiveConnection();
}

// --- Catalog ---

/** Apply a catalog response unless a newer request's response already landed. */
export function applyConnectionCatalog(
  result: unknown,
  requestSeq = ++catalogRequestSeq,
) {
  if (
    requestSeq < appliedCatalogRequestSeq ||
    !result ||
    typeof result !== "object"
  ) {
    return;
  }
  appliedCatalogRequestSeq = requestSeq;
  const catalog = result as {
    default_connection_id?: unknown;
    connections?: unknown;
  };
  const defaultConnectionId =
    typeof catalog.default_connection_id === "string" &&
    catalog.default_connection_id.length > 0
      ? catalog.default_connection_id
      : state.defaultConnectionId;
  const connections = Array.isArray(catalog.connections)
    ? mergeConnectionCatalog(state.connections, catalog.connections)
    : state.connections;
  if (Array.isArray(catalog.connections)) {
    setCatalogReadyForConnection(true);
    bridge.setConnectionRuntimeGenerations(connections);
  }
  const nextActive = connections.find(
    (connection) => connection.id === state.activeConnectionId,
  );
  const reconciliation = reconcileConnectionCatalogSessions(state, connections);
  for (const connectionId of reconciliation.invalidatedConnectionIds) {
    taskCompletionTracker.reset(connectionId);
  }
  if (nextActive && reconciliation.activeRuntimeChanged) {
    resetActiveConnectionLease(
      connections,
      defaultConnectionId,
      reconciliation,
    );
    return;
  }

  // Steady-state catalog polls rebuild identical DTOs every tick. Publish
  // only real changes so unchanged slices keep their references and idle
  // polls do not re-render every subscriber.
  const stableConnections = jsonDeepEqual(state.connections, connections)
    ? state.connections
    : connections;
  const previousSessions = state.sessionsByConnectionId;
  const nextSessions = reconciliation.sessionsByConnectionId;
  let sessionsChanged =
    reconciliation.invalidatedConnectionIds.length > 0 ||
    Object.keys(nextSessions).length !== Object.keys(previousSessions).length;
  const stableSessions: Record<string, ServerSessionState> = {};
  for (const [id, session] of Object.entries(nextSessions)) {
    const previous = previousSessions[id];
    if (previous && serverSessionEqual(previous, session)) {
      stableSessions[id] = previous;
    } else {
      stableSessions[id] = session;
      sessionsChanged = true;
    }
  }
  if (
    stableConnections !== state.connections ||
    sessionsChanged ||
    defaultConnectionId !== state.defaultConnectionId
  ) {
    replaceState({
      ...state,
      ...(reconciliation.activeSession ?? {}),
      connections: stableConnections,
      defaultConnectionId,
      sessionsByConnectionId: stableSessions,
    });
  }
  if (!nextActive) selectConnectionNow(defaultConnectionId);
}

async function refreshConnectionCatalog(): Promise<boolean> {
  if (state.connectionPaused || state.status !== "connected") return false;
  const requestSeq = ++catalogRequestSeq;
  try {
    applyConnectionCatalog(await bridge.call("connections.list"), requestSeq);
    return catalogReadyForConnection && appliedCatalogRequestSeq >= requestSeq;
  } catch {
    // The catalog is bridge-global and is retried on the next status poll.
    return false;
  }
}

export async function refreshBridgeStatus() {
  if (state.connectionPaused || state.status !== "connected") return;
  const requestSeq = ++catalogRequestSeq;
  try {
    const r = await bridge.call("bridge.status");
    if (state.connectionPaused || state.status !== "connected") return;
    applyConnectionCatalog(r, requestSeq);
    if (rearmTerminalAttachmentsAfterCatalog(catalogReadyForConnection)) {
      scheduleRefresh();
    }
    const nextBridgeStatus: BridgeStatus = {
      clients: Number(r?.clients ?? 0),
      ...(typeof r?.devices === "number" ? { devices: r.devices } : {}),
      terminals: Array.isArray(r?.terminals) ? r.terminals : [],
    };
    if (!jsonDeepEqual(state.bridgeStatus, nextBridgeStatus)) {
      set({ bridgeStatus: nextBridgeStatus });
    }
  } catch {
    // Keep the last good count; status polling should never interrupt the UI.
  }
}

export function rearmTerminalAttachmentsAfterCatalog(
  catalogReady: boolean,
): boolean {
  if (
    !terminalReattachPending ||
    !catalogReady ||
    state.status !== "connected" ||
    state.connectionPaused
  ) {
    return false;
  }
  terminalReattachPending = false;
  set({ terminalAttachEpoch: state.terminalAttachEpoch + 1 });
  return true;
}

/** Test seam: behave as if the socket dropped and terminals need re-attach. */
export function markTerminalReattachPending() {
  terminalReattachPending = true;
  setCatalogReadyForConnection(false);
  bridge.setConnectionRuntimeGenerations([]);
}

export function resetConnectionRuntime(snapshot: State) {
  stopPolling();
  clearRefreshQueue(true);
  taskCompletionTracker.clear();
  replaceState(snapshot);
  terminalReattachPending = false;
  connectionRecoveryIntent = null;
  setCatalogReadyForConnection(snapshot.connections.length > 0);
  bridge.setConnectionRuntimeGenerations(snapshot.connections);
}

// --- Bridge lifecycle ---

/** Claim one-time initialization; false when the store already started. */
export function markInitialized(): boolean {
  if (initialized) return false;
  initialized = true;
  return true;
}

export function handleHello(defaultConnectionId: string) {
  set({ defaultConnectionId });
  if (
    state.activeConnectionId === LEGACY_DEFAULT_CONNECTION_ID &&
    defaultConnectionId !== state.activeConnectionId
  ) {
    selectConnectionNow(defaultConnectionId, false);
  }
  if (state.status === "connected" && !state.connectionPaused) {
    void refreshConnectionCatalog();
  }
}

export function handleStatus(s: ConnectionStatus) {
  if (s === "disconnected") {
    set({ endpointAvailability: {} });
    markTerminalReattachPending();
    forgetLeaseCaches();
    clearRefreshQueue();
  }
  const completedRecovery =
    s === "connected" && !state.connectionPaused && state.notice?.loading
      ? connectionRecoveryIntent
      : null;
  if (s === "connected") connectionRecoveryIntent = null;
  const completedRecoveryMessage =
    completedRecovery === "reconnect"
      ? t("Browser reconnected")
      : t("Browser sync resumed");
  set(
    completedRecovery
      ? {
          status: s,
          connectionGeneration: state.connectionGeneration,
          notice: {
            kind: "success",
            message: completedRecoveryMessage,
            autoDismissMs: 5000,
          },
        }
      : {
          status: s,
          connectionGeneration:
            s === "disconnected"
              ? bridge.clientGeneration
              : state.connectionGeneration,
          bridgeStatus: s === "connected" ? state.bridgeStatus : null,
        },
  );
  if (s === "connected" && !state.connectionPaused) {
    // Polling may have been stopped by the hello-driven initial
    // connection switch; every settled connection must re-arm it.
    startPolling();
    void refreshConnectionCatalog().then((catalogReady) => {
      if (
        !catalogReady ||
        state.status !== "connected" ||
        state.connectionPaused
      ) {
        return;
      }
      rearmTerminalAttachmentsAfterCatalog(true);
      void refreshNow();
      void refreshBridgeStatus();
    });
    if (state.pendingRestartVersion) {
      void reloadWhenUpdatedServerIsReady(state.pendingRestartVersion);
    }
  }
}

/**
 * Browsers throttle timers in hidden tabs, which stalls the metadata poll that
 * carries agent statuses. Catch up as soon as the page is visible, focused, or
 * back online instead of waiting out the throttle.
 */
export function refreshOnReturn() {
  if (state.connectionPaused || state.status !== "connected") return;
  // Mobile OSes can silently kill the socket while the page is frozen;
  // probe now so reconnect and terminal re-attach start immediately
  // instead of waiting for the next heartbeat tick.
  bridge.probeConnectionNow();
  void refreshNow();
  void refreshBridgeStatus();
}

/** Start polling once the server session is known to be authorized. */
export function startPollingUnlessPaused() {
  if (!state.connectionPaused) startPolling();
}

function pauseConnection(
  detail = t("This browser will stop syncing until you resume it."),
) {
  connectionRecoveryIntent = null;
  storeConnectionPaused(true);
  detachActiveConnection(true);
  bridge.disconnect();
  set({
    connectionPaused: true,
    status: "disconnected",
    connectionGeneration: bridge.clientGeneration,
    bridgeStatus: null,
    terminalAttachEpoch: state.terminalAttachEpoch + 1,
    notice: { kind: "info", message: t("Connection paused"), detail },
  });
}

export const connectionActions = {
  /** Refresh bridge-global profile/status metadata without changing selection. */
  refreshConnections: refreshConnectionCatalog,

  /** Programmatic switch seam for the M5 selector. */
  selectConnection(connectionId: string) {
    return selectConnectionNow(connectionId);
  },

  pauseConnection,

  pauseOtherClients() {
    return action(async (lease) => {
      const result = await bridge.call("bridge.pause_others");
      const pausedClients = Number(result?.paused_clients ?? 0);
      noticeFor(lease, {
        kind: pausedClients > 0 ? "success" : "info",
        message:
          pausedClients === 1
            ? t("Paused 1 other browser")
            : t("Paused {count} other browsers", { count: pausedClients }),
        autoDismissMs: 5000,
      });
      void refreshBridgeStatus();
      return result;
    });
  },

  resumeConnection() {
    connectionRecoveryIntent = state.connectionPaused ? "resume" : "reconnect";
    storeConnectionPaused(false);
    set({
      connectionPaused: false,
      error: null,
      notice: {
        kind: "info",
        message:
          connectionRecoveryIntent === "reconnect"
            ? t("Reconnecting browser")
            : t("Resuming browser sync"),
        loading: true,
      },
    });
    bridge.connect();
    startPolling();
  },
};
