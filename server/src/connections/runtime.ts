import {
  createTaskEventTracker,
  type TaskEvent,
} from "../notifications/task-events";
import {
  assertEndpointCreationSource,
  createEmptyWorkspaceCreator,
} from "../bridge/endpoint-creation";
import type { ServerWebSocket } from "bun";
import { createAgentSessionHandlers } from "../agent/agent-sessions";
import { createAgentSessionFileAccess } from "../agent/session-file-access";
import { HerdrClient } from "../bridge/herdr-client";
import {
  createCollaborationService,
  filterCollaborationEvent,
} from "../bridge/collaboration";
import {
  createDisplayOwnership,
  type SocketIdentity,
} from "../bridge/display-ownership";
import { acquireOwnShellClients } from "../bridge/own-shell-clients";
import { createClaimTracker } from "../authz/pane-claims";
import { createTopology, isStructuralEvent } from "../authz/topology";
import { createPresenceFocusTracker } from "../bridge/presence-focus";
import { hostname } from "node:os";
import {
  herdrHostLabel,
  type PresenceContext,
} from "../identity/identity-service";
import { assertSupportedHerdrProtocol } from "../bridge/protocol-compat";
import { createSettingsRpcHandler } from "../bridge/settings-rpc";
import {
  readGuiSettings,
  terminalSurfaceCodecsEnabled,
  updateGuiSettings,
} from "../config/gui-settings";
import {
  createSshTunnelManager,
  type SshTunnelConfig,
  type SshTunnelError,
} from "../bridge/ssh-tunnel";
import { dropCoalescedMessage } from "../bridge/websocket-send";
import {
  createTerminalBridge,
  type PaneTerminal,
} from "../bridge/terminal-bridge";
import { createHerdrInfoHandler } from "../http/herdr-info";
import { createImageUploadHandler } from "../http/image-upload";
import {
  createLocalLauncherHost,
  createSshLauncherHost,
} from "../launcher/host";
import { createLauncherService } from "../launcher/service";
import {
  createRecoveryReporter,
  type Logger,
  silentLogger,
} from "../utils/logger";
import {
  runProcess,
  runProcessWithCodeTimeout,
  shQuote,
} from "../utils/process-utils";
import { createFileHandlers } from "../workspace/files";
import {
  createLastStepBaselineStore,
  type LastStepBaselineStore,
} from "../workspace/git-diff";
import { createLastStepTurnTracker } from "../workspace/last-step-turns";
import { runBinaryProcessWithTimeout } from "../workspace/process";
import { createStatusEnricher } from "../workspace/status";
import { createWorktreeParentStore } from "../worktree/parents";
import {
  createWorktreeRemovalCoordinator,
  createWorktreeRemovalRuntime,
} from "../worktree/remove";
import { createAgentStatusSubscriptionLoop } from "./agent-status-subscription";
import { createShellService } from "../shell/service";
import { sanitizeConnectionError } from "./manager";
import { createEventSubscriptionLoop } from "./subscription-loop";
import { type ConnectionIdentity, LEGACY_DEFAULT_CONNECTION } from "./types";

const DEFAULT_EVENTS = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.closed",
  "workspace.focused",
  "workspace.moved",
  "workspace.reordered",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "tab.focused",
  "pane.created",
  "pane.closed",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
];
const COLLABORATION_EVENTS = ["collaboration.updated"];
export const COLLABORATION_FORWARD_INTERVAL_MS = 1000;

/** Deliver the first value at once, then the newest once per interval. */
export function createTrailingThrottle<T>(
  intervalMs: number,
  deliver: (value: T) => void,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;
  const open = () => {
    timer = setTimeout(() => {
      timer = null;
      if (!pending) return;
      const { value } = pending;
      pending = null;
      deliver(value);
      open();
    }, intervalMs);
  };
  return {
    push(value: T) {
      if (timer) {
        pending = { value };
        return;
      }
      deliver(value);
      open();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

type SafeSend = (
  ws: ServerWebSocket<unknown>,
  payload: string,
  context?: string,
) => boolean;

type MarkRpcError = (
  ws: ServerWebSocket<unknown>,
  id: string | null | undefined,
  detail?: string,
) => void;

export function createLegacyConnectionRuntime(args: {
  identity?: ConnectionIdentity;
  connectionGeneration?: number;
  config: SshTunnelConfig;
  logger?: Logger;
  safeSend: SafeSend;
  broadcast?: (payload: string, context?: string) => void;
  clientLabel: (ws: ServerWebSocket<unknown>) => string;
  markRpcError: MarkRpcError;
  onEvent: (event: unknown, identity: ConnectionIdentity) => void;
  onTaskEvent?: (event: TaskEvent) => void;
  onError?: (error: unknown, identity: ConnectionIdentity) => void;
  onTransportExit?: (error: SshTunnelError) => void;
  /** Adds bridge-side identity to presence snapshots sent to browsers. */
  presentSnapshot?: <T>(snapshot: T, context: PresenceContext) => T;
  /** The bridge-assigned participant and device of a browser socket. */
  socketIdentity?: (ws: ServerWebSocket<unknown>) => SocketIdentity | null;
  /** Test seam for deterministic shutdown coverage. */
  lastStepBaselines?: LastStepBaselineStore;
  resolveLastStepWorkspaceGitRoot?: (workspaceId: string) => Promise<string>;
  lastStepTransitionDebounceMs?: number;
}) {
  const { config } = args;
  const logger = args.logger ?? silentLogger;
  const identity = { ...(args.identity ?? LEGACY_DEFAULT_CONNECTION) };
  const socketPath = config.socketPath;
  const clientSocketPath = config.clientSocketPath;
  const sshHost = () => config.sshHost;
  const herdr = new HerdrClient(socketPath);
  const shell = createShellService({
    enabled: !config.sshHost,
    call: (method, params) => herdr.call(method, params),
  });
  herdr.on("pane-input", (pane: string) => {
    if (!config.sshHost) shell.state.dirty(pane);
  });
  const ownShellClientsLease = acquireOwnShellClients(
    clientSocketPath,
    () => herdr.call("collaboration.list", {}),
    logger.child("presence"),
  );
  const ownShellClients = ownShellClientsLease.clients;
  const presenceContext: PresenceContext = {
    tuiDevice: herdrHostLabel(config.sshHost, hostname()),
  };
  const presenceFocus = createPresenceFocusTracker();
  // Which device sizes each pane; announced at once like focus changes.
  const displayOwnership = createDisplayOwnership({
    onChange: (owners) =>
      !disposed &&
      args.onEvent(
        {
          event: "collaboration.display",
          data: { type: "collaboration_display", display_owners: owners },
        },
        identity,
      ),
  });
  const presence = {
    ...presenceFocus,
    forget(participantId: unknown) {
      presenceFocus.forget(participantId);
      displayOwnership.forgetParticipant(participantId);
    },
    annotate<T>(snapshot: T): T {
      return displayOwnership.annotate(presenceFocus.annotate(snapshot));
    },
  };
  const presentSnapshot = <T>(snapshot: T): T => {
    const visible = ownShellClients.filterSnapshot(snapshot);
    displayOwnership.observeParticipants(visible);
    const filtered = presence.annotate(visible);
    return args.presentSnapshot
      ? args.presentSnapshot(filtered, presenceContext)
      : filtered;
  };
  // Herdr republishes the whole presence snapshot on every keystroke (typing
  // timestamps). Forward at most one per interval, always the newest, so
  // typing on a slow link does not also download a snapshot per key.
  const collaborationForward = createTrailingThrottle(
    COLLABORATION_FORWARD_INTERVAL_MS,
    (event: unknown) =>
      args.onEvent(filterCollaborationEvent(event, presentSnapshot), identity),
  );
  // Authorization mirrors: pane claims (single writer) and where each
  // terminal, pane and tab lives (workspace grants).
  const claims = createClaimTracker();
  const topology = createTopology({
    listPanes: () => herdr.call("pane.list", {}, 5000),
  });
  const collaboration = createCollaborationService({
    herdrCall: (method, params) => herdr.call(method, params),
    filterSnapshot: ownShellClients.filterSnapshot,
    presence,
    // Focus changes skip the snapshot throttle: ids only, sent at once.
    onFocus: (focus) =>
      args.onEvent(
        {
          event: "collaboration.focus",
          data: { type: "collaboration_focus", focus },
        },
        identity,
      ),
    onSnapshot: (snapshot) => {
      claims.observeSnapshot(snapshot);
      collaborationForward.push({
        event: "collaboration.updated",
        data: { type: "collaboration_updated", snapshot },
      });
    },
  });
  // Presence already sent to browsers may list a shell learned only now.
  const stopOwnShellUpdates = ownShellClients.onChange((result) => {
    const snapshot = (result as { snapshot?: unknown } | null)?.snapshot;
    if (!snapshot) return;
    collaborationForward.push({
      event: "collaboration_updated",
      data: { type: "collaboration_updated", snapshot },
    });
  });
  const agentSessionFiles = createAgentSessionFileAccess({
    sshHost: config.sshHost,
    runBinaryProcessWithTimeout,
    shQuote,
  });
  const agentSessions = createAgentSessionHandlers({
    herdrCall: (method, params) => herdr.call(method, params),
    files: agentSessionFiles,
  });
  const worktreeParents = createWorktreeParentStore({
    connectionId: identity.id,
    herdr,
    sshHost,
  });
  const { handleHerdrInfo } = createHerdrInfoHandler({
    ping: () => herdr.ping(),
  });
  const lastStepBaselines =
    args.lastStepBaselines ??
    createLastStepBaselineStore({
      host: sshHost(),
      runProcessWithCodeTimeout,
      shQuote,
    });
  const files = createFileHandlers({
    herdr,
    sshHost,
    runProcessWithCodeTimeout,
    shQuote,
    lastStepBaselines,
  });
  const status = createStatusEnricher({
    connectionId: identity.id,
    sshHost,
    runProcessWithCodeTimeout,
    shQuote,
  });
  const worktreeRemovalCoordinator = createWorktreeRemovalCoordinator();
  const worktreeRemovalRuntime = createWorktreeRemovalRuntime({
    host: sshHost(),
    runProcessWithCodeTimeout,
    shQuote,
  });
  const handleImageUpload = createImageUploadHandler({ sshHost });
  const launcher = createLauncherService({
    connectionId: identity.id,
    host: config.sshHost
      ? createSshLauncherHost({
          host: config.sshHost,
          runProcessWithCodeTimeout,
          shQuote,
        })
      : createLocalLauncherHost(runProcessWithCodeTimeout),
    herdrCall: (method, params, timeoutMs) =>
      herdr.call(method, params, timeoutMs),
    navigationMode: () => terminalBridge.navigationMode(),
    readSettings: readGuiSettings,
    updateSettings: updateGuiSettings,
  });
  const sshTunnel = createSshTunnelManager({
    connectionId: identity.id,
    logger: logger.child("ssh"),
    formatError: sanitizeConnectionError,
    config,
    runProcess,
    onUnexpectedExit: args.onTransportExit,
  });
  const handleSettingsRpc = createSettingsRpcHandler({
    connectionId: identity.id,
    connectionGeneration: args.connectionGeneration,
    onTerminalTransportSettingsChanged: (enabled) => {
      if (disposed) return;
      terminalBridge.refreshSurfaceCodecs();
      args.onEvent(
        {
          event: "settings.terminal_transport.updated",
          data: { surface_codecs: enabled },
        },
        identity,
      );
    },
    safeSend: args.safeSend,
    markRpcError: args.markRpcError,
  });
  /** Every pane's current terminal; rejects while Herdr is unreachable. */
  async function listPaneTerminals(): Promise<PaneTerminal[]> {
    const result = await herdr.call("pane.list", {}, 5000);
    const panes = (result as { panes?: unknown } | null)?.panes;
    if (!Array.isArray(panes)) throw new Error("invalid pane.list result");
    return panes.flatMap((pane): PaneTerminal[] => {
      const record = (pane ?? {}) as {
        pane_id?: unknown;
        terminal_id?: unknown;
      };
      return typeof record.pane_id === "string" &&
        record.pane_id.length > 0 &&
        typeof record.terminal_id === "string" &&
        record.terminal_id.length > 0
        ? [{ paneId: record.pane_id, terminalId: record.terminal_id }]
        : [];
    });
  }
  const terminalBridge = createTerminalBridge({
    onPaneInput: (pane) => {
      if (!config.sshHost) shell.state.dirty(pane);
    },
    onPaneAlternateScreen: (pane, active) =>
      shell.state.setAlternate(pane, active),
    connectionId: identity.id,
    broadcast: args.broadcast,
    logger: logger.child("terminal"),
    connectionGeneration: args.connectionGeneration,
    formatError: sanitizeConnectionError,
    clientSocketPath,
    ownShellClients,
    surfaceCodecsEnabled: async () =>
      terminalSurfaceCodecsEnabled(await readGuiSettings(), identity.id),
    herdrProtocol: async () => {
      const protocol: unknown = (await herdr.ping()).protocol;
      assertSupportedHerdrProtocol(protocol);
      return protocol;
    },
    createEmptyWorkspace: createEmptyWorkspaceCreator(
      (method, params, timeoutMs) => herdr.call(method, params, timeoutMs),
    ),
    validateCreationSource: async (source) => {
      const result = await herdr.call(
        "pane.get",
        { pane_id: source.pane_id },
        5000,
      );
      assertEndpointCreationSource(source, result?.pane);
    },
    focusedWorkspaceId: async () => {
      const result = await herdr.call("workspace.list", {}, 5000);
      return (
        result?.workspaces?.find(
          (workspace: { focused?: boolean }) => workspace.focused,
        )?.workspace_id ?? null
      );
    },
    // Herdr errors surface as the attach error; "no pane found" then means
    // Herdr really has no such terminal (e.g. renumbered by a live handoff).
    lookupPaneId: async (terminalId) =>
      (await listPaneTerminals()).find((pane) => pane.terminalId === terminalId)
        ?.paneId ?? null,
    listPaneTerminals,
    safeSend: args.safeSend,
    dropCoalesced: dropCoalescedMessage,
    clientLabel: args.clientLabel,
    markRpcError: args.markRpcError,
    displayOwnership,
    socketIdentity: args.socketIdentity,
    readPaneHistory: async (paneId, lines) => {
      // ANSI keeps Herdr on its passive snapshot path (see readPaneText).
      const result = await herdr.call(
        "pane.read",
        { pane_id: paneId, source: "recent", lines, format: "ansi" },
        5000,
      );
      const read = result?.read ?? result;
      return {
        text: typeof read?.text === "string" ? read.text : "",
        truncated: read?.truncated === true,
      };
    },
    readPaneText: async (paneId, lines) => {
      // ANSI format keeps Herdr on its passive snapshot path: a plain-text
      // read of an alternate-screen app may replay wheel input to harvest
      // history, which would be input on the pane (see the MCP gateway).
      const result = await herdr.call(
        "pane.read",
        {
          pane_id: paneId,
          source: "recent_unwrapped",
          lines,
          format: "ansi",
        },
        5000,
      );
      const read = result?.read ?? result;
      return {
        text: Bun.stripANSI(typeof read?.text === "string" ? read.text : ""),
        truncated: read?.truncated === true,
      };
    },
    confirmRelayResize: async ({ cols, rows, paneId }) => {
      if (!paneId) return false;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const result = await herdr.call("pane.layout", { pane_id: paneId });
          const area = result?.layout?.area;
          if (
            area &&
            Number(area.x) + Number(area.width) === cols &&
            Number(area.y) + Number(area.height) === rows
          ) {
            return true;
          }
        } catch {
          return false;
        }
        await Bun.sleep(50);
      }
      return false;
    },
  });

  const lastStepTurns = createLastStepTurnTracker({
    captureWorkspaceBaseline: async (workspaceId) => {
      await lastStepBaselines.captureWorkspace(workspaceId, async () => {
        if (args.resolveLastStepWorkspaceGitRoot) {
          return args.resolveLastStepWorkspaceGitRoot(workspaceId);
        }
        const { root } = await files.resolveWorkspaceGitRoot({
          workspace_id: workspaceId,
        });
        return root;
      });
    },
    completeWorkspaceStep: async (workspaceId) => {
      const published = await lastStepBaselines.completeWorkspace(workspaceId);
      if (!published || disposed) return;
      args.onEvent(
        {
          event: "workspace.last_step_completed",
          data: {
            type: "workspace.last_step_completed",
            workspace_id: workspaceId,
          },
        },
        identity,
      );
    },
    onCaptureError: (error, workspaceId) =>
      logger.warn("last-step baseline failed", {
        connection: identity.id,
        workspace: workspaceId,
        error: sanitizeConnectionError(error),
      }),
    onCompleteError: (error, workspaceId) =>
      logger.warn("last-step completion failed", {
        connection: identity.id,
        workspace: workspaceId,
        error: sanitizeConnectionError(error),
      }),
    transitionDebounceMs: args.lastStepTransitionDebounceMs ?? 150,
  });
  const agentStatusRecovery = createRecoveryReporter({
    logger: logger.child("agent-status"),
    failureMessage: "agent status subscription failed",
    recoveryMessage: "agent status subscription recovered",
  });
  const pendingTaskEvents = new Map<string, TaskEvent>();
  const taskEvents = createTaskEventTracker(async (event) => {
    if (!args.onTaskEvent || disposed) return;
    pendingTaskEvents.set(event.paneId, event);
    // Resolve labels on demand so push works without a browser and after renames.
    const [workspaceResult, tabResult] = await Promise.all([
      herdr
        .call("workspace.get", { workspace_id: event.workspaceId }, 5000)
        .catch(() => null),
      herdr
        .call("tab.list", { workspace_id: event.workspaceId }, 5000)
        .catch(() => null),
    ]);
    // An older lookup must not publish over a newer notification for this pane.
    if (disposed || pendingTaskEvents.get(event.paneId) !== event) return;
    pendingTaskEvents.delete(event.paneId);
    const workspaceLabel = workspaceResult?.workspace?.label;
    const tab = Array.isArray(tabResult?.tabs)
      ? tabResult.tabs.find(
          (tab: { tab_id?: unknown; workspace_id?: unknown } | null) =>
            tab?.tab_id === event.tabId &&
            tab?.workspace_id === event.workspaceId,
        )
      : undefined;
    args.onTaskEvent({
      ...event,
      workspaceLabel:
        typeof workspaceLabel === "string" ? workspaceLabel : undefined,
      tabLabel: typeof tab?.label === "string" ? tab.label : undefined,
    });
  });
  let taskListRevision = 0;
  const agentStatusSubscriptions = createAgentStatusSubscriptionLoop({
    herdr,
    connectionId: identity.id,
    onSubscribeError: (error) =>
      agentStatusRecovery.failure(sanitizeConnectionError(error), {
        connection: identity.id,
      }),
    onListError: (error) =>
      agentStatusRecovery.failure(sanitizeConnectionError(error), {
        connection: identity.id,
        operation: "pane list",
      }),
    onPaneListStart: () => {
      taskListRevision = taskEvents.beginPaneList();
      return lastStepTurns.beginPaneList();
    },
    onPaneList: (result, revision) => {
      taskEvents.reconcilePaneList(result, taskListRevision);
      lastStepTurns.reconcilePaneList(result, revision);
    },
    log: (message) => {
      agentStatusRecovery.recovered({ connection: identity.id });
      logger.debug(message, { connection: identity.id });
    },
  });

  const onHerdrEvent = (event: unknown) => {
    taskEvents.handleHerdrEvent(event);
    lastStepTurns.handleHerdrEvent(event);
    agentStatusSubscriptions.handleHerdrEvent(event);
    const name = (event as { event?: string })?.event;
    if (name === "workspace.focused")
      terminalBridge.refreshPopupObserverFocus();
    if (isStructuralEvent(name)) topology.invalidate();
    // Herdr names this event with an underscore; the local fallback uses a dot.
    if (name === "collaboration_updated" || name === "collaboration.updated") {
      claims.observeSnapshot(
        (event as { data?: { snapshot?: unknown } }).data?.snapshot,
      );
      collaborationForward.push(event);
      return;
    }
    args.onEvent(event, identity);
  };
  const onHerdrError = (error: unknown) => args.onError?.(error, identity);
  herdr.on("event", onHerdrEvent);
  herdr.on("error", onHerdrError);

  const eventSubscriptionRecovery = createRecoveryReporter({
    logger: logger.child("events"),
    failureMessage: "event subscription failed",
    recoveryMessage: "event subscription recovered",
  });
  const subscriptionLoop = createEventSubscriptionLoop({
    subscribe: () => herdr.subscribe(DEFAULT_EVENTS),
    onReady: () => {
      // Browser snapshots may start before the subscription ACK. Reconcile
      // after every ACK (including reconnect) to close that missed-event gap.
      // The browser's generic refresh path queues another snapshot if busy.
      args.onEvent({ event: "session.resync_required", data: {} }, identity);
      if (!eventSubscriptionRecovery.recovered({ connection: identity.id })) {
        logger.info("subscribed to Herdr events", { connection: identity.id });
        return;
      }
      // The subscription drops when Herdr restarts or hands off to a new
      // server, which keeps pane ids but renumbers terminals. Move viewers
      // to their pane's new terminal and forget cached locations.
      topology.invalidate();
      void terminalBridge.reconcileTerminals("event subscription recovered");
    },
    onSubscribeError: (error) =>
      eventSubscriptionRecovery.failure(sanitizeConnectionError(error), {
        connection: identity.id,
        retry_ms: 2_000,
      }),
    onSubscriptionClosed: () =>
      eventSubscriptionRecovery.failure("subscription closed", {
        connection: identity.id,
        retry_ms: 2_000,
      }),
  });
  const collaborationSubscriptionLoop = createEventSubscriptionLoop({
    subscribe: () => herdr.subscribe(COLLABORATION_EVENTS),
    onReady: () =>
      console.log(
        `[bridge] subscribed to collaboration events connection=${identity.id}`,
      ),
    onSubscribeError: (error) =>
      console.warn(
        `[bridge] collaboration events unavailable connection=${identity.id}:`,
        sanitizeConnectionError(error),
      ),
    retrySubscribeError: (error) => {
      const message = error.message.toLowerCase();
      return !(
        message.includes("collaboration.updated") &&
        (message.includes("unknown") || message.includes("invalid request"))
      );
    },
  });

  let transportStart: Promise<void> | null = null;
  let transportStarted = false;
  let backgroundStarted = false;
  let disposed = false;
  let stopTask: Promise<void> | null = null;

  async function startTransport() {
    if (disposed) throw new Error("connection runtime is disposed");
    if (transportStarted) return;
    if (transportStart) return transportStart;
    transportStart = sshTunnel
      .startAutoSshTunnel()
      .then(() => {
        if (!disposed) transportStarted = true;
      })
      .finally(() => {
        transportStart = null;
      });
    return transportStart;
  }

  function startBackground() {
    if (disposed) throw new Error("connection runtime is disposed");
    if (backgroundStarted) return;
    backgroundStarted = true;
    void shell
      .start()
      .catch(() => logger.warn("shell state tracking unavailable"));
    subscriptionLoop.start();
    collaborationSubscriptionLoop.start();
    agentStatusSubscriptions.start();
  }

  function stop() {
    if (stopTask) return stopTask;
    if (disposed) return Promise.resolve();
    disposed = true;
    collaborationForward.cancel();
    displayOwnership.clear();
    stopOwnShellUpdates();
    ownShellClientsLease.release();
    backgroundStarted = false;
    herdr.off("event", onHerdrEvent);
    herdr.off("error", onHerdrError);
    taskEvents.stop();
    pendingTaskEvents.clear();
    terminalBridge.dispose();
    const subscriptionStop = subscriptionLoop.stop();
    const collaborationSubscriptionStop = collaborationSubscriptionLoop.stop();
    const agentStatusStop = agentStatusSubscriptions.stop();
    const lastStepStop = lastStepTurns
      .stop()
      .then(() => lastStepBaselines.dispose());
    const transportCleanup = sshTunnel.cleanupAutoSshTunnel();
    const transportStop =
      transportStart?.catch(() => undefined) ?? Promise.resolve();
    stopTask = Promise.all([
      shell.stop(),
      subscriptionStop,
      collaborationSubscriptionStop,
      agentStatusStop,
      lastStepStop,
      transportCleanup,
      transportStop,
    ]).then(() => undefined);
    return stopTask;
  }

  return {
    identity,
    presenceContext,
    socketPath,
    clientSocketPath,
    sshHost,
    herdr,
    shell,
    collaboration,
    claims,
    topology,
    worktreeParents,
    handleHerdrInfo,
    handleImageUpload,
    handleSettingsRpc,
    launcher,
    files,
    status,
    worktreeRemovalCoordinator,
    worktreeRemovalRuntime,
    terminalBridge,
    agentSessions,
    startTransport,
    startBackground,
    stop,
  };
}

export type LegacyConnectionRuntime = ReturnType<
  typeof createLegacyConnectionRuntime
>;
