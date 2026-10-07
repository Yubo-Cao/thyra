// Metadata refresh: pull workspaces, tabs, panes and the active layout for the
// active connection, publish only what changed, and resolve in-flight focus.
import type { HerdrEventMsg } from "../api";
import { withAgentActivity } from "../agentOrder";
import {
  projectBrowserLayout,
  projectBrowserNavigation,
} from "../browserNavigation";
import { parseEndpointAvailability } from "../endpointAvailability";
import { forgetTabLayoutsExcept, rememberTabLayout } from "../tabLayout";
import { forgetTerminalRelayViewportsExcept } from "../terminalResize";
import type { PaneLayout, Tab, Workspace } from "../types";
import {
  captureConnectionLease,
  connectionEventIsActive,
  jsonDeepEqual,
  leaseIsCurrent,
  set,
  setForConnection,
  type State,
  state,
} from "./core";
import { notifyCompletedTasks, taskCompletionTracker } from "./notifications";

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const refreshingConnectionKeys = new Set<string>();
const queuedConnectionKeys = new Set<string>();
// Event-driven refreshes already keep metadata current; the backstop poll
// skips a tick that follows one, so an active session does not pay for both.
export let lastRefreshStartedAt = 0;

function pickActiveTabId(s: State): string | undefined {
  const focusedWs = s.workspaces.find((w) => w.focused);
  if (focusedWs?.active_tab_id) return focusedWs.active_tab_id;
  const focusedTab = s.tabs.find((t) => t.focused);
  return focusedTab?.tab_id ?? s.tabs[0]?.tab_id;
}

const REFRESH_SLICE_KEYS = [
  "workspaces",
  "tabs",
  "panes",
  "layout",
  "browserNavigation",
  "endpointAvailability",
] as const;
const REFRESH_SCALAR_KEYS = [
  "navigationMode",
  "error",
  "pendingFocusWorkspaceId",
  "pendingFocusWorkspaceSettledAt",
  "selectedPaneId",
] as const;

/**
 * Reuse the previous reference for every refresh slice whose content is
 * unchanged so memoized consumers stay valid, and return null when nothing
 * changed at all so the caller can skip broadcasting a no-op state. Scalars
 * are only adopted when their value actually moved.
 */
export function stabilizeRefreshPatch(
  snapshot: State,
  next: Partial<State>,
): Partial<State> | null {
  const patch: Partial<State> = {};
  let changed = false;
  const adoptSlice = <K extends (typeof REFRESH_SLICE_KEYS)[number]>(
    key: K,
  ) => {
    if (!(key in next)) return;
    const incoming = next[key] as State[K];
    const current = snapshot[key];
    if (incoming === current || jsonDeepEqual(incoming, current)) {
      patch[key] = current;
    } else {
      patch[key] = incoming;
      changed = true;
    }
  };
  for (const key of REFRESH_SLICE_KEYS) adoptSlice(key);
  const adoptScalar = <K extends (typeof REFRESH_SCALAR_KEYS)[number]>(
    key: K,
  ) => {
    if (!(key in next)) return;
    if (next[key] === snapshot[key]) return;
    patch[key] = next[key] as State[K];
    changed = true;
  };
  for (const key of REFRESH_SCALAR_KEYS) adoptScalar(key);
  if (!changed) return null;
  patch.lastRefresh = next.lastRefresh ?? Date.now();
  return patch;
}

// --- Pending workspace focus ---

let nextPendingFocusWorkspaceSeq = 1;

/**
 * Marks a workspace focus as in flight and returns the sequence token that
 * identifies this attempt. The pending flag suppresses focus-follower
 * effects until a fresh refresh observes the workspace focused (or the focus
 * is declared lost after the action settled).
 */
export function stampPendingFocusWorkspace(workspaceId: string): number {
  const seq = nextPendingFocusWorkspaceSeq++;
  set({
    pendingFocusWorkspaceId: workspaceId,
    pendingFocusWorkspaceSeq: seq,
    pendingFocusWorkspaceSettledAt: null,
  });
  return seq;
}

/** Clears an in-flight focus marker identified by its sequence token. */
export function clearPendingFocusWorkspace(seq: number): void {
  if (state.pendingFocusWorkspaceSeq !== seq) return;
  set({
    pendingFocusWorkspaceId: null,
    pendingFocusWorkspaceSettledAt: null,
  });
}

/** Records that the action behind an in-flight focus has completed. */
export function settlePendingFocusWorkspace(seq: number): void {
  if (
    !state.pendingFocusWorkspaceId ||
    state.pendingFocusWorkspaceSeq !== seq ||
    state.pendingFocusWorkspaceSettledAt !== null
  ) {
    return;
  }
  set({ pendingFocusWorkspaceSettledAt: Date.now() });
}

// --- Refresh ---

export async function refreshNow(lease = captureConnectionLease()) {
  if (
    state.connectionPaused ||
    state.status !== "connected" ||
    !leaseIsCurrent(lease)
  ) {
    return;
  }
  const refreshKey = `${lease.connectionId}:${lease.generation}`;
  if (refreshingConnectionKeys.has(refreshKey)) {
    queuedConnectionKeys.add(refreshKey);
    return;
  }
  refreshingConnectionKeys.add(refreshKey);
  lastRefreshStartedAt = Date.now();
  // Snapshot the pending-focus marker when the fetch actually starts. Only a
  // refresh that began after the focus action settled may declare the focus
  // lost, and only while the marker still belongs to that same attempt.
  const navigationAtEntry = state.browserNavigation;
  const endpointAvailabilityAtEntry = state.endpointAvailability;
  const pendingFocusAtEntry = {
    seq: state.pendingFocusWorkspaceSeq,
    settledAt: state.pendingFocusWorkspaceSettledAt,
  };
  try {
    const [wsRes, tabRes, paneRes, agentRes] = await Promise.all([
      lease.client.call("workspace.list"),
      lease.client.call("tab.list"),
      lease.client.call("pane.list"),
      // Older servers may omit agent metadata; ordinary navigation still works.
      lease.client.call("agent.list").catch(() => null),
    ]);
    if (!leaseIsCurrent(lease)) return;
    const workspaces: Workspace[] = wsRes?.workspaces ?? [];
    const tabs: Tab[] = tabRes?.tabs ?? [];
    const panes = withAgentActivity(paneRes?.panes ?? [], agentRes);
    const liveTabIds = new Set(tabs.map((tab) => tab.tab_id));
    forgetTerminalRelayViewportsExcept(
      lease.connectionId,
      lease.generation,
      liveTabIds,
    );
    forgetTabLayoutsExcept(lease.connectionId, lease.generation, liveTabIds);
    const completedPanes = taskCompletionTracker.update(
      lease.connectionId,
      panes,
    );

    const navigationMode =
      wsRes?.navigation_mode === "browser-local" ? "browser-local" : "shared";
    const next: Partial<State> = {
      navigationMode,
      endpointAvailability: parseEndpointAvailability(
        wsRes?.endpoint_availability,
      ),
      workspaces,
      tabs,
      panes,
      error: null,
      lastRefresh: Date.now(),
    };
    if (navigationMode === "browser-local") {
      Object.assign(
        next,
        projectBrowserNavigation(
          state.browserNavigation,
          workspaces,
          tabs,
          panes,
        ),
      );
    }
    const pendingFocusAtObservation = {
      seq: state.pendingFocusWorkspaceSeq,
      settledAt: state.pendingFocusWorkspaceSettledAt,
    };
    if (
      state.pendingFocusWorkspaceId &&
      workspaces.some(
        (w) => w.workspace_id === state.pendingFocusWorkspaceId && w.focused,
      )
    ) {
      next.pendingFocusWorkspaceId = null;
      next.pendingFocusWorkspaceSettledAt = null;
    } else if (
      state.pendingFocusWorkspaceId &&
      state.pendingFocusWorkspaceSeq === pendingFocusAtEntry.seq &&
      pendingFocusAtEntry.settledAt !== null &&
      state.pendingFocusWorkspaceSettledAt === pendingFocusAtEntry.settledAt
    ) {
      // The focus action settled before this refresh started, yet a fresh
      // observation still does not show the workspace focused: the focus was
      // pre-empted or the workspace vanished, so release follower effects.
      next.pendingFocusWorkspaceId = null;
      next.pendingFocusWorkspaceSettledAt = null;
    }

    // Keep selection valid globally. Layout-scoped validation runs after the
    // active tab layout is fetched below, because a pane can exist while no
    // longer belonging to the visible terminal.
    if (
      navigationMode === "shared" &&
      state.selectedPaneId &&
      !panes.some((p) => p.pane_id === state.selectedPaneId)
    ) {
      next.selectedPaneId = null;
    }

    // Fetch layout for the active tab (needs a pane_id in that tab).
    const merged = { ...state, ...next } as State;
    const activeTabId = pickActiveTabId(merged);
    const aPane =
      panes.find((p) => p.tab_id === activeTabId && p.focused) ??
      panes.find((p) => p.tab_id === activeTabId);
    if (aPane) {
      try {
        const lr = await lease.client.call("pane.layout", {
          pane_id: aPane.pane_id,
        });
        if (!leaseIsCurrent(lease)) return;
        const observedLayout = (lr?.layout ?? null) as PaneLayout | null;
        // Panes can move or close between pane.list and pane.layout. Never
        // substitute shared layout focus for a missing browser-selected pane.
        const staleLayout =
          navigationMode === "browser-local" &&
          observedLayout &&
          (observedLayout.tab_id !== activeTabId ||
            observedLayout.workspace_id !== aPane.workspace_id ||
            (next.selectedPaneId &&
              !observedLayout.panes.some(
                (pane) => pane.pane_id === next.selectedPaneId,
              )));
        const layout = staleLayout ? null : observedLayout;
        if (staleLayout) queuedConnectionKeys.add(refreshKey);
        rememberTabLayout(lease.connectionId, lease.generation, layout);
        next.layout =
          navigationMode === "browser-local"
            ? projectBrowserLayout(layout, next.selectedPaneId ?? null)
            : layout;
        if (
          navigationMode === "shared" &&
          layout &&
          state.selectedPaneId &&
          !layout.panes.some((p) => p.pane_id === state.selectedPaneId)
        ) {
          next.selectedPaneId = null;
        }
      } catch (error) {
        next.layout = null;
        next.error = error instanceof Error ? error.message : String(error);
      }
    } else {
      next.layout = null;
    }

    // Never publish a layout fetched for an older browser navigation target.
    if (navigationAtEntry !== state.browserNavigation) {
      queuedConnectionKeys.add(refreshKey);
      return;
    }

    // Layout fetching can overlap another focus attempt or its settlement.
    // Drop only a stale marker clear, preserving the useful snapshot data.
    if (
      next.pendingFocusWorkspaceId === null &&
      (state.pendingFocusWorkspaceSeq !== pendingFocusAtObservation.seq ||
        state.pendingFocusWorkspaceSettledAt !==
          pendingFocusAtObservation.settledAt)
    ) {
      delete next.pendingFocusWorkspaceId;
      delete next.pendingFocusWorkspaceSettledAt;
    }
    // Close/reattach can replace advertisements while either RPC is pending.
    // Keep that newer slice without discarding useful topology/layout updates.
    if (endpointAvailabilityAtEntry !== state.endpointAvailability) {
      delete next.endpointAvailability;
      queuedConnectionKeys.add(refreshKey);
    }
    const patch = stabilizeRefreshPatch(state, next);
    if (patch) {
      if (!setForConnection(lease, patch)) return;
    } else if (!leaseIsCurrent(lease)) {
      return;
    }
    notifyCompletedTasks(lease, completedPanes, workspaces, tabs);
  } catch (error) {
    setForConnection(lease, { error: (error as Error).message });
  } finally {
    refreshingConnectionKeys.delete(refreshKey);
    if (queuedConnectionKeys.delete(refreshKey) && leaseIsCurrent(lease)) {
      void refreshNow(lease);
    }
  }
}

export function scheduleRefresh(lease = captureConnectionLease()) {
  if (state.connectionPaused || !leaseIsCurrent(lease)) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (leaseIsCurrent(lease)) void refreshNow(lease);
  }, 80);
}

export function cancelScheduledRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

/** Forget queued follow-up refreshes (and, for tests, in-flight ones). */
export function clearRefreshQueue(includeInFlight = false) {
  queuedConnectionKeys.clear();
  if (includeInFlight) refreshingConnectionKeys.clear();
}

export function handleHerdrEvent(event: HerdrEventMsg) {
  if (
    !state.connectionPaused &&
    connectionEventIsActive(
      state,
      event.connection_id,
      event.connection_generation,
    )
  ) {
    // Presence snapshots carry their own state (see collaboration.ts) and
    // arrive while anyone types; they never change workspace metadata.
    if (
      event.event === "collaboration.updated" ||
      event.event === "collaboration_updated" ||
      event.event === "collaboration.focus"
    )
      return;
    scheduleRefresh();
  }
}
