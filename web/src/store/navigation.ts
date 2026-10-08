// Navigation: which workspace, tab and pane the user is looking at. Each
// browser keeps its own target instead of moving Herdr's focus.
import type { ConnectionClient } from "../api";
import {
  type BrowserNavigation,
  browserPaneInDirection,
  projectBrowserLayout,
  projectBrowserNavigation,
  selectBrowserTarget,
} from "../browserNavigation";
import {
  endpointMethodReason,
  parseEndpointAdvertisement,
} from "../endpointAvailability";
import { workspaceCan } from "../capabilities";
import { t } from "../i18n";
import type { TaskNotificationTarget } from "../taskNotifications";
import { provisionalTabLayout, tabLayoutFor } from "../tabLayout";
import type { Pane, Tab, Workspace } from "../types";
import { action } from "./actions";
import { selectConnectionNow } from "./connection";
import {
  leaseIsCurrent,
  set,
  setForConnection,
  type State,
  state,
  type StoreConnectionLease,
  useStoreSelector,
} from "./core";
import { taskNotificationTargetIsCurrent } from "./notifications";
import { refreshNow, scheduleRefresh } from "./refresh";

const navigationListeners = new Set<() => void>();
let programmaticNavigation = 0;

/**
 * Called when the user moves this page's view (click, shortcut, command,
 * creation), not when `navigateProgrammatically` does; follow mode stops then.
 */
export function onUserNavigation(listener: () => void) {
  navigationListeners.add(listener);
  return () => {
    navigationListeners.delete(listener);
  };
}

/** Run navigation actions that must not count as the user's own. */
export function navigateProgrammatically<T>(run: () => T): T {
  programmaticNavigation += 1;
  try {
    return run();
  } finally {
    programmaticNavigation -= 1;
  }
}

function userNavigated() {
  if (programmaticNavigation > 0) return;
  navigationListeners.forEach((listener) => listener());
}

export function terminalNavigationLoading(s: State): boolean {
  return (
    s.status === "connected" &&
    !s.connectionPaused &&
    !s.error &&
    !s.layout &&
    s.panes.some((pane) => pane.pane_id === s.selectedPaneId)
  );
}

/** Whether the browser target is still the one an action started from. */
export function browserSelectionIsCurrent(navigation: BrowserNavigation) {
  const current = state.browserNavigation;
  const workspaceId = navigation.workspaceId;
  const tabId = workspaceId ? navigation.tabIds[workspaceId] : undefined;
  return (
    current.revision === navigation.revision &&
    current.workspaceId === workspaceId &&
    (!workspaceId || current.tabIds[workspaceId] === tabId) &&
    (!tabId || current.paneIds[tabId] === navigation.paneIds[tabId])
  );
}

export function endpointCreationReason(
  snapshot: State,
  method: "tab.create" | "workspace.create",
  workspaceId = snapshot.browserNavigation.workspaceId,
): string | null {
  // Offer only what the bridge allows: tabs where the caller may edit,
  // workspaces to instance admins.
  if (
    method === "workspace.create"
      ? snapshot.host === false
      : !workspaceCan(
          snapshot.workspaces.find((item) => item.workspace_id === workspaceId),
          "edit",
        )
  )
    return t("View only");
  // Empty bootstrap deliberately uses the validated control API, not an endpoint.
  if (method === "workspace.create" && snapshot.workspaces.length === 0)
    return null;
  const tabId = workspaceId
    ? snapshot.browserNavigation.tabIds[workspaceId]
    : undefined;
  const paneId = tabId ? snapshot.browserNavigation.paneIds[tabId] : undefined;
  const pane = snapshot.panes.find((pane) => pane.pane_id === paneId);
  const advertisement = pane
    ? snapshot.endpointAvailability[pane.terminal_id]
    : null;
  return (
    endpointMethodReason(advertisement, "pane.focus") ??
    endpointMethodReason(advertisement, method)
  );
}

export function useEndpointCreationReason(
  method: "tab.create" | "workspace.create",
  workspaceId?: string,
) {
  return useStoreSelector((snapshot) =>
    endpointCreationReason(snapshot, method, workspaceId),
  );
}

/** The browser-selected pane new tabs and workspaces are created from. */
export function browserCreationSource(workspaceId: string | null) {
  const tabId = workspaceId
    ? state.browserNavigation.tabIds[workspaceId]
    : undefined;
  const paneId = tabId ? state.browserNavigation.paneIds[tabId] : undefined;
  const pane = state.panes.find((pane) => pane.pane_id === paneId);
  return pane
    ? {
        workspace_id: pane.workspace_id,
        tab_id: pane.tab_id,
        pane_id: pane.pane_id,
        terminal_id: pane.terminal_id,
      }
    : null;
}

function navigateBrowser(workspaceId: string, tabId?: string, paneId?: string) {
  const navigation = selectBrowserTarget(
    state.browserNavigation,
    workspaceId,
    tabId,
    paneId,
  );
  const projected = projectBrowserNavigation(
    navigation,
    state.workspaces,
    state.tabs,
    state.panes,
  );
  const activeTabId = projected.browserNavigation.tabIds[workspaceId];
  // Render the target tab from its last known geometry instead of blanking the
  // terminal area until pane.layout answers. The refresh below corrects it.
  const nextLayout =
    state.layout?.tab_id === activeTabId
      ? state.layout
      : provisionalTabLayout(
          tabLayoutFor(
            state.activeConnectionId,
            state.connectionGeneration,
            activeTabId,
          ),
          state.panes,
          activeTabId,
        );
  set({
    ...projected,
    layout: projectBrowserLayout(nextLayout, projected.selectedPaneId),
    error: null,
  });
  return refreshNow();
}

/** Adopt an explicit RPC result without requiring it in an older list snapshot. */
export function adoptBrowserTarget(
  lease: StoreConnectionLease,
  result: unknown,
) {
  if (!leaseIsCurrent(lease) || !result || typeof result !== "object") return;
  userNavigated();
  const target = result as {
    root_pane?: Partial<Pane>;
    pane?: Partial<Pane>;
    tab?: Partial<Tab>;
    workspace?: Partial<Workspace>;
  };
  const pane = target.root_pane ?? target.pane;
  const tabId = pane?.tab_id ?? target.tab?.tab_id;
  const workspaceId =
    pane?.workspace_id ??
    target.tab?.workspace_id ??
    target.workspace?.workspace_id;
  if (typeof workspaceId !== "string") return;
  setForConnection(lease, {
    browserNavigation: selectBrowserTarget(
      state.browserNavigation,
      workspaceId,
      typeof tabId === "string" ? tabId : undefined,
      typeof pane?.pane_id === "string" ? pane.pane_id : undefined,
    ),
  });
}

function focusPane(paneId: string) {
  userNavigated();
  const pane = state.panes.find((p) => p.pane_id === paneId);
  return pane
    ? navigateBrowser(pane.workspace_id, pane.tab_id, paneId)
    : Promise.resolve();
}

export const navigationActions = {
  setTerminalEndpoint(
    client: ConnectionClient,
    terminalId: string,
    advertisement: unknown,
  ) {
    if (!client.isCurrent()) return;
    set({
      endpointAvailability: {
        ...state.endpointAvailability,
        [terminalId]: parseEndpointAdvertisement(advertisement),
      },
    });
  },

  /**
   * Herdr gave a pane a new terminal (live handoff) or dropped it: follow the
   * pane to its replacement now, and re-read the whole mapping.
   */
  remapTerminal(
    client: ConnectionClient,
    terminalId: string,
    replacement: string | null,
  ) {
    if (!client.isCurrent()) return;
    if (replacement && state.panes.some((p) => p.terminal_id === terminalId))
      set({
        panes: state.panes.map((pane) =>
          pane.terminal_id === terminalId
            ? { ...pane, terminal_id: replacement }
            : pane,
        ),
      });
    scheduleRefresh();
  },

  terminalScrollReason(terminalId: string, mouseReporting = false) {
    if (mouseReporting) return null; // Wheel input uses the negotiated semantic codec.
    return endpointMethodReason(
      state.endpointAvailability[terminalId],
      "pane.scroll",
    );
  },

  focusWorkspace(workspaceId: string) {
    userNavigated();
    return state.workspaces.some(
      (workspace) => workspace.workspace_id === workspaceId,
    )
      ? navigateBrowser(workspaceId)
      : Promise.resolve();
  },

  focusTab(tabId: string) {
    userNavigated();
    const tab = state.tabs.find((tab) => tab.tab_id === tabId);
    return tab ? navigateBrowser(tab.workspace_id, tabId) : Promise.resolve();
  },

  focusPane,

  focusPaneDirection(
    paneId: string,
    direction: "left" | "right" | "up" | "down",
  ) {
    userNavigated();
    const target = browserPaneInDirection(state.layout, paneId, direction);
    return target ? focusPane(target) : Promise.resolve();
  },

  focusTaskNotificationTarget(target: TaskNotificationTarget) {
    userNavigated();
    if (!taskNotificationTargetIsCurrent(state, target)) {
      return Promise.resolve(undefined);
    }
    if (
      target.connectionId !== state.activeConnectionId &&
      !selectConnectionNow(target.connectionId)
    ) {
      return Promise.resolve(undefined);
    }
    if (
      !taskNotificationTargetIsCurrent(state, target) ||
      state.serverRuntimeGeneration !== target.runtimeGeneration
    ) {
      return Promise.resolve(undefined);
    }
    const navigation = state.browserNavigation;
    return action(
      async (lease) => {
        const result = await lease.client
          .call("pane.get", { pane_id: target.paneId })
          .catch(() => null);
        if (!leaseIsCurrent(lease)) return;
        if (!browserSelectionIsCurrent(navigation)) return refreshNow(lease);
        if (result?.pane) adoptBrowserTarget(lease, result);
        else
          setForConnection(lease, {
            browserNavigation: selectBrowserTarget(
              state.browserNavigation,
              target.workspaceId,
            ),
          });
        return refreshNow(lease);
      },
      { refresh: "none" },
    );
  },
};
