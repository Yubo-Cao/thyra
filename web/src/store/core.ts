// The store's state container: the State shape, the zustand store, the patch
// function every slice writes through, and connection leases that keep async
// results from landing on a connection the user has since left.
import { useStore } from "zustand";
import { devtools } from "zustand/middleware";
import { createStore, type StateCreator } from "zustand/vanilla";
import {
  bridge,
  type ConnectionClient,
  type ConnectionStatus,
  type ConnectionSummary,
  type PopupStatePush,
} from "../api";
import {
  type BrowserNavigation,
  emptyBrowserNavigation,
} from "../browserNavigation";
import { LEGACY_DEFAULT_CONNECTION_ID } from "../connectionStorage";
import type { EndpointAvailability } from "../endpointAvailability";
import { t } from "../i18n";
import type { TaskNotificationPreferences } from "../taskPush";
import type { Pane, PaneLayout, Tab, Workspace } from "../types";
import {
  notificationPermission,
  storedAutomaticUpdateChecksEnabled,
  storedConnectionPaused,
  storedPendingRestartVersion,
  storedTaskNotificationPreferences,
  storedTaskNotificationsEnabled,
  storedTaskNotificationTransport,
} from "./preferences";

/** Server resources of one connection; cached per connection while inactive. */
export interface ServerSessionState {
  /** ConnectionManager generation that owns every server resource below. */
  serverRuntimeGeneration: number | null;
  navigationMode: "browser-local" | "shared";
  endpointAvailability: EndpointAvailability;
  browserNavigation: BrowserNavigation;
  workspaces: Workspace[];
  tabs: Tab[];
  panes: Pane[];
  layout: PaneLayout | null;
  selectedPaneId: string | null;
  recentPaneIds: string[];
  /** A plugin's session-modal floating pane (e.g. Herdr Float), if open. */
  popup: PopupInfo | null;
  error: string | null;
  pendingFocusWorkspaceId: string | null;
  pendingFocusWorkspaceSeq: number;
  pendingFocusWorkspaceSettledAt: number | null;
  terminalAttachEpoch: number;
  lastRefresh: number;
}

export type PopupInfo = NonNullable<PopupStatePush["popup"]>;

export interface State extends ServerSessionState {
  status: ConnectionStatus;
  /** Host-wide actions are offered (`hostCapable` of the hello principal). */
  host?: boolean;
  connectionPaused: boolean;
  bridgeStatus: BridgeStatus | null;
  connections: ConnectionSummary[];
  defaultConnectionId: string;
  activeConnectionId: string;
  connectionGeneration: number;
  sessionsByConnectionId: Record<string, ServerSessionState>;
  notice: Notice | null;
  taskNotificationsEnabled: boolean;
  taskNotificationPreferences: TaskNotificationPreferences;
  taskNotificationTransport: "local" | "push";
  taskNotificationBusy: boolean;
  taskNotificationPermission: NotificationPermission | "unsupported";
  automaticUpdateChecksEnabled: boolean;
  updateInfo: UpdateInfo | null;
  updateInstalling: boolean;
  pendingRestartVersion: string | null;
  dismissedUpdateVersion: string | null;
  /** The bridge serves a newer frontend build than this page runs. */
  webUpdateAvailable: boolean;
}

export interface Notice {
  kind: "info" | "success" | "error";
  message: string;
  detail?: string;
  detailMode?: "text" | "output";
  detailTitle?: string;
  loading?: boolean;
  autoDismissMs?: number;
  actionLabel?: string;
  actionConnectionId?: string;
  actionRuntimeGeneration?: number;
  actionWorkspaceId?: string;
  actionPaneId?: string;
  actionClipboardText?: string;
  id?: number;
}

export interface UpdateInfo {
  current_version: string;
  latest_version?: string;
  update_available: boolean;
  can_auto_update: boolean;
  reason?: string;
  platform: string;
  source_url?: string;
  metadata_url?: string;
}

export interface BridgeStatus {
  clients: number;
  /** Distinct devices among `clients` (tabs of one device count once). */
  devices?: number;
  terminals: Array<{
    terminal_id: string;
    viewers: number;
  }>;
}

export const DEFAULT_NOTICE_AUTO_DISMISS_MS = 15 * 1000;
const RECENT_PANE_LIMIT = 12;

export function noticeAutoDismissDelay(notice: Notice): number | null {
  if (notice.loading) return null;
  return notice.autoDismissMs ?? DEFAULT_NOTICE_AUTO_DISMISS_MS;
}

export function pausedNotice(detail: string): Notice {
  return { kind: "info", message: t("Connection is paused"), detail };
}

/** An error notice whose detail is the failure's message. */
export function errorNotice(
  message: string,
  error: unknown,
  extra?: Partial<Notice>,
): Notice {
  return { kind: "error", message, detail: (error as Error).message, ...extra };
}

/** An `action` failureNotice reporting a fixed message. */
export function failWith(message: string, extra?: Partial<Notice>) {
  return (error: Error) => errorNotice(message, error, extra);
}

export function emptyServerSessionState(
  serverRuntimeGeneration: number | null = null,
): ServerSessionState {
  return {
    serverRuntimeGeneration,
    navigationMode: "shared",
    endpointAvailability: {},
    browserNavigation: emptyBrowserNavigation(),
    workspaces: [],
    tabs: [],
    panes: [],
    layout: null,
    selectedPaneId: null,
    recentPaneIds: [],
    popup: null,
    error: null,
    pendingFocusWorkspaceId: null,
    pendingFocusWorkspaceSeq: 0,
    pendingFocusWorkspaceSettledAt: null,
    terminalAttachEpoch: 0,
    lastRefresh: 0,
  };
}

const SESSION_KEYS = Object.keys(emptyServerSessionState()) as Array<
  keyof ServerSessionState
>;
/** Session keys a patch mirrors into the active connection's cache (not `popup`). */
export const SERVER_SESSION_KEYS = SESSION_KEYS.filter(
  (key) => key !== "popup",
);

export function serverSessionFromState(snapshot: State): ServerSessionState {
  return Object.fromEntries(
    SESSION_KEYS.map((key) => [key, snapshot[key]]),
  ) as unknown as ServerSessionState;
}

/**
 * Structural equality for JSON-shaped values. Fails open (reports unequal)
 * when a value cannot be serialized, so callers fall back to publishing.
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function nextRecentPaneIds(
  selectedPaneId: string | null | undefined,
  recentPaneIds: string[],
  panes: Array<Pick<Pane, "pane_id">>,
) {
  const livePaneIds = new Set(panes.map((pane) => pane.pane_id));
  const pruned = recentPaneIds.filter((paneId) => livePaneIds.has(paneId));
  if (!selectedPaneId || !livePaneIds.has(selectedPaneId)) {
    return pruned.slice(0, RECENT_PANE_LIMIT);
  }
  return [
    selectedPaneId,
    ...pruned.filter((paneId) => paneId !== selectedPaneId),
  ].slice(0, RECENT_PANE_LIMIT);
}

const initialSession = emptyServerSessionState();

const initialState: State = {
  status: "disconnected",
  connectionPaused: storedConnectionPaused(),
  bridgeStatus: null,
  connections: [],
  defaultConnectionId: LEGACY_DEFAULT_CONNECTION_ID,
  activeConnectionId: LEGACY_DEFAULT_CONNECTION_ID,
  connectionGeneration: 0,
  sessionsByConnectionId: {
    [LEGACY_DEFAULT_CONNECTION_ID]: initialSession,
  },
  ...initialSession,
  notice: null,
  taskNotificationsEnabled: storedTaskNotificationsEnabled(),
  taskNotificationPreferences: storedTaskNotificationPreferences(),
  taskNotificationTransport: storedTaskNotificationTransport(),
  taskNotificationBusy: false,
  taskNotificationPermission: notificationPermission(),
  automaticUpdateChecksEnabled: storedAutomaticUpdateChecksEnabled(),
  updateInfo: null,
  updateInstalling: false,
  pendingRestartVersion: storedPendingRestartVersion(),
  dismissedUpdateVersion: null,
  webUpdateAvailable: false,
};
const initializer: StateCreator<State> = () => initialState;

/** The app store. Development builds expose it to Redux DevTools. */
export const appStore = createStore<State>()(
  import.meta.env.DEV
    ? (devtools(initializer, { name: "Thyra" }) as StateCreator<State>)
    : initializer,
);
// Nothing hydrates, so static rendering shows the live snapshot.
appStore.getInitialState = appStore.getState;

/** Current snapshot; a live binding, replaced (never mutated) on every write. */
export let state = appStore.getState();
appStore.subscribe((next) => {
  state = next;
});
let noticeSeq = 0;

export const getState = appStore.getState;
export const subscribe = appStore.subscribe;

/** Swap the whole snapshot and notify subscribers. */
export function replaceState(next: State) {
  appStore.setState(next, true);
}

/**
 * Apply a patch: number new notices, keep pane history in step with the
 * selection, and mirror session keys into the active connection's cache.
 */
export function set(patch: Partial<State>) {
  if (patch.notice) {
    patch = { ...patch, notice: { ...patch.notice, id: ++noticeSeq } };
  }
  if (
    patch.selectedPaneId !== undefined ||
    patch.panes !== undefined ||
    patch.layout !== undefined
  ) {
    const selectedForHistory =
      patch.selectedPaneId !== undefined
        ? patch.selectedPaneId
        : state.selectedPaneId;
    const layoutForHistory =
      patch.layout !== undefined ? patch.layout : state.layout;
    patch = {
      ...patch,
      recentPaneIds: nextRecentPaneIds(
        selectedForHistory ?? layoutForHistory?.focused_pane_id,
        patch.recentPaneIds ?? state.recentPaneIds,
        patch.panes ?? state.panes,
      ),
    };
  }
  const sessionPatch: Partial<ServerSessionState> = {};
  let hasSessionPatch = false;
  for (const key of SERVER_SESSION_KEYS) {
    if (!(key in patch)) continue;
    hasSessionPatch = true;
    Object.assign(sessionPatch, { [key]: patch[key] });
  }
  if (hasSessionPatch) {
    const updatedSession = {
      ...(state.sessionsByConnectionId[state.activeConnectionId] ??
        serverSessionFromState(state)),
      ...sessionPatch,
    };
    patch = {
      ...patch,
      sessionsByConnectionId: {
        ...state.sessionsByConnectionId,
        ...patch.sessionsByConnectionId,
        [state.activeConnectionId]: updatedSession,
      },
    };
  }
  appStore.setState(patch);
}

// --- Connection leases ---

export interface StoreConnectionLease {
  connectionId: string;
  generation: number;
  client: ConnectionClient;
}

/** Whether the bridge catalog has bound the active connection's runtime. */
export let catalogReadyForConnection = false;

export function setCatalogReadyForConnection(ready: boolean) {
  catalogReadyForConnection = ready;
}

export function captureConnectionLease(): StoreConnectionLease {
  const runtimeGeneration = catalogReadyForConnection
    ? (state.connections.find(
        (connection) => connection.id === state.activeConnectionId,
      )?.generation ?? null)
    : null;
  return {
    connectionId: state.activeConnectionId,
    generation: state.connectionGeneration,
    client: bridge.connection(state.activeConnectionId, runtimeGeneration),
  };
}

export function leaseIsCurrent(lease: StoreConnectionLease): boolean {
  return (
    state.activeConnectionId === lease.connectionId &&
    state.connectionGeneration === lease.generation &&
    lease.client.isCurrent()
  );
}

export function setForConnection(
  lease: StoreConnectionLease,
  patch: Partial<State>,
): boolean {
  if (!leaseIsCurrent(lease)) return false;
  set(patch);
  return true;
}

export function connectionEventIsActive(
  snapshot: Pick<State, "activeConnectionId" | "connections">,
  connectionId: string,
  connectionGeneration?: number,
  requireGeneration = bridge.hello?.capabilities
    ?.connection_runtime_generation === true,
): boolean {
  if (snapshot.activeConnectionId !== connectionId) return false;
  const expected = snapshot.connections.find(
    (connection) => connection.id === connectionId,
  )?.generation;
  if (!requireGeneration) return true;
  return expected !== undefined && expected === connectionGeneration;
}

// --- React bindings ---

/** Subscribe to a slice; wrap object-returning selectors in `useShallow`. */
export function useStoreSelector<T>(selector: (state: State) => T): T {
  return useStore(appStore, selector);
}
