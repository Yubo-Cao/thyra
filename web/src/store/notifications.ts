// Task notifications: detect agents that finished or need input, raise a toast
// and (when enabled) a browser notification, and own the device preference.
import { t } from "../i18n";
import {
  isTaskNotificationTarget,
  prepareTaskNotifications,
  showTaskNotification,
  type TaskNotificationTarget,
} from "../taskNotifications";
import { syncTaskPush, type TaskNotificationPreferences } from "../taskPush";
import type { Pane, Tab, Workspace } from "../types";
import {
  DEFAULT_NOTICE_AUTO_DISMISS_MS,
  errorNotice,
  leaseIsCurrent,
  type Notice,
  set,
  type State,
  state,
  type StoreConnectionLease,
} from "./core";
import {
  notificationPermission,
  storedTaskNotificationPreferences,
  storedTaskNotificationsEnabled,
  storeTaskNotificationsEnabled,
  storeTaskNotificationPreferences,
  storeTaskNotificationTransport,
} from "./preferences";

type PaneStatusTracker = {
  ready: boolean;
  byId: Map<string, string>;
};

export class TaskCompletionTracker {
  private readonly byConnection = new Map<string, PaneStatusTracker>();

  clear(): void {
    this.byConnection.clear();
  }

  reset(connectionId: string): void {
    this.byConnection.delete(connectionId);
  }

  update(connectionId: string, panes: Pane[]): Pane[] {
    const tracker = this.byConnection.get(connectionId) ?? {
      ready: false,
      byId: new Map<string, string>(),
    };
    this.byConnection.set(connectionId, tracker);
    const livePaneIds = new Set<string>();
    const completed: Pane[] = [];
    for (const pane of panes) {
      livePaneIds.add(pane.pane_id);
      const nextStatus = pane.agent_status;
      const previousStatus = tracker.byId.get(pane.pane_id);
      if (
        tracker.ready &&
        previousStatus === "working" &&
        (nextStatus === "done" ||
          nextStatus === "idle" ||
          nextStatus === "blocked")
      ) {
        completed.push(pane);
      }
      tracker.byId.set(pane.pane_id, nextStatus);
    }
    for (const paneId of tracker.byId.keys()) {
      if (!livePaneIds.has(paneId)) tracker.byId.delete(paneId);
    }
    tracker.ready = true;
    return completed;
  }
}

export const taskCompletionTracker = new TaskCompletionTracker();

function taskNotificationBody(
  pane: Pane,
  workspaces: Workspace[],
  tabs: Tab[],
) {
  const workspace = workspaces.find(
    (w) => w.workspace_id === pane.workspace_id,
  );
  const tab = tabs.find((t) => t.tab_id === pane.tab_id);
  const parts = [
    pane.agent ?? "Agent",
    workspace?.label ? t("workspace {name}", { name: workspace.label }) : null,
    tab?.label ? t("tab {name}", { name: tab.label }) : null,
  ].filter((part): part is string => !!part);
  return parts.join(" · ");
}

// Bumped by every preference change so a slower, older attempt cannot
// overwrite the outcome of a newer one.
let taskNotificationPreferenceVersion = 0;

function reportTaskNotificationFailure(error: unknown, version: number) {
  if (version !== taskNotificationPreferenceVersion) return;
  taskNotificationPreferenceVersion++;
  set({
    taskNotificationsEnabled: false,
    taskNotificationBusy: false,
    taskNotificationPermission: notificationPermission(),
    notice: {
      kind: "error",
      message: t("Task notifications are unavailable"),
      detail: error instanceof Error ? error.message : String(error),
    },
  });
  try {
    storeTaskNotificationsEnabled(false);
  } catch {
    // The runtime preference still reflects the failed notification transport.
  }
}

function maybeShowBrowserTaskNotification(
  title: string,
  body: string,
  tag: string,
  target: TaskNotificationTarget,
) {
  if (
    !state.taskNotificationsEnabled ||
    state.taskNotificationBusy ||
    state.taskNotificationTransport === "push"
  )
    return;
  const version = taskNotificationPreferenceVersion;
  if (notificationPermission() !== "granted") {
    reportTaskNotificationFailure(
      new Error(
        t(
          "Enable notifications for this site in the browser settings, then try again.",
        ),
      ),
      version,
    );
    return;
  }
  void showTaskNotification(
    title,
    { body, tag },
    target,
    () =>
      state.taskNotificationsEnabled &&
      version === taskNotificationPreferenceVersion &&
      taskNotificationTargetIsCurrent(state, target),
  ).catch((error) => reportTaskNotificationFailure(error, version));
}

export function taskNotificationTarget(
  connectionId: string,
  runtimeGeneration: number,
  pane: Pick<Pane, "workspace_id" | "pane_id">,
): TaskNotificationTarget {
  return {
    connectionId,
    runtimeGeneration,
    workspaceId: pane.workspace_id,
    paneId: pane.pane_id,
  };
}

export function taskNotificationTargetIsCurrent(
  snapshot: Pick<State, "connections">,
  target: Pick<TaskNotificationTarget, "connectionId" | "runtimeGeneration">,
): boolean {
  return snapshot.connections.some(
    (connection) =>
      connection.id === target.connectionId &&
      connection.generation === target.runtimeGeneration,
  );
}

export function taskNotificationTag(target: TaskNotificationTarget): string {
  return JSON.stringify([
    "thyra-task",
    target.connectionId,
    target.runtimeGeneration,
    target.paneId,
  ]);
}

export function taskNotificationTargetFromNotice(
  notice: Pick<
    Notice,
    | "actionConnectionId"
    | "actionRuntimeGeneration"
    | "actionWorkspaceId"
    | "actionPaneId"
  >,
): TaskNotificationTarget | null {
  const target = {
    connectionId: notice.actionConnectionId,
    runtimeGeneration: notice.actionRuntimeGeneration,
    workspaceId: notice.actionWorkspaceId,
    paneId: notice.actionPaneId,
  };
  return isTaskNotificationTarget(target) ? target : null;
}

function notifyTaskCompleted(pane: Pane, workspaces: Workspace[], tabs: Tab[]) {
  const blocked = pane.agent_status === "blocked";
  if (
    !state.taskNotificationsEnabled ||
    !state.taskNotificationPreferences[blocked ? "blocked" : "completed"]
  )
    return;
  const runtimeGeneration = state.serverRuntimeGeneration;
  if (runtimeGeneration === null) return;
  const body = taskNotificationBody(pane, workspaces, tabs);
  const title = blocked
    ? t("Thyra agent needs input")
    : t("Thyra task completed");
  const target = taskNotificationTarget(
    state.activeConnectionId,
    runtimeGeneration,
    pane,
  );
  set({
    notice: {
      kind: blocked ? "info" : "success",
      message: blocked ? t("Agent needs input") : t("Task completed"),
      detail: body,
      actionLabel: pane.agent ? t("Open agent") : t("Open workspace"),
      actionConnectionId: state.activeConnectionId,
      actionRuntimeGeneration: runtimeGeneration,
      actionWorkspaceId: pane.workspace_id,
      actionPaneId: pane.pane_id,
      autoDismissMs: DEFAULT_NOTICE_AUTO_DISMISS_MS,
    },
  });
  maybeShowBrowserTaskNotification(
    title,
    body,
    taskNotificationTag(target),
    target,
  );
}

function activePaneIdForTaskNotifications(snapshot: State) {
  const layoutPaneIds = new Set(
    snapshot.layout?.panes.map((pane) => pane.pane_id) ?? [],
  );
  if (snapshot.selectedPaneId && layoutPaneIds.has(snapshot.selectedPaneId)) {
    return snapshot.selectedPaneId;
  }
  return (
    snapshot.layout?.focused_pane_id ??
    snapshot.panes.find((pane) => pane.focused)?.pane_id ??
    null
  );
}

/** Notify about panes that finished outside the pane the user is watching. */
export function notifyCompletedTasks(
  lease: StoreConnectionLease,
  completed: Pane[],
  workspaces: Workspace[],
  tabs: Tab[],
) {
  if (!leaseIsCurrent(lease)) return;
  const activePaneId = activePaneIdForTaskNotifications(state);
  for (const pane of completed) {
    if (!leaseIsCurrent(lease)) return;
    if (pane.pane_id === activePaneId) continue;
    notifyTaskCompleted(pane, workspaces, tabs);
  }
}

/** Adopt a preference another tab wrote, then resync background delivery. */
export function reloadTaskNotificationPreferences() {
  set({
    taskNotificationsEnabled: storedTaskNotificationsEnabled(),
    taskNotificationPreferences: storedTaskNotificationPreferences(),
  });
  void restoreTaskNotifications();
}

export async function restoreTaskNotifications() {
  const version = ++taskNotificationPreferenceVersion;
  set({ taskNotificationBusy: true });
  try {
    if (state.taskNotificationsEnabled) await prepareTaskNotifications();
    if (version !== taskNotificationPreferenceVersion) return;
    const transport = await syncTaskPush(
      state.taskNotificationsEnabled,
      state.taskNotificationPreferences,
    );
    if (version === taskNotificationPreferenceVersion) {
      storeTaskNotificationTransport(transport);
      set({ taskNotificationTransport: transport });
    }
  } catch (error) {
    if (version === taskNotificationPreferenceVersion)
      set({
        notice: errorNotice(t("Background notification sync failed"), error),
      });
  } finally {
    if (version === taskNotificationPreferenceVersion)
      set({ taskNotificationBusy: false });
  }
}

/** Record that notifications are off on this device, and why. */
function disableTaskNotifications(patch: Partial<State>) {
  storeTaskNotificationsEnabled(false);
  set({
    taskNotificationsEnabled: false,
    taskNotificationBusy: false,
    taskNotificationPermission: notificationPermission(),
    ...patch,
  });
}

export const notificationActions = {
  async setTaskNotificationPreference(
    kind: keyof TaskNotificationPreferences,
    enabled: boolean,
  ) {
    const version = ++taskNotificationPreferenceVersion;
    const preferences = {
      ...state.taskNotificationPreferences,
      [kind]: enabled,
    };
    set({ taskNotificationBusy: true });
    try {
      const transport = await syncTaskPush(
        state.taskNotificationsEnabled,
        preferences,
      );
      if (version !== taskNotificationPreferenceVersion) return;
      storeTaskNotificationTransport(transport);
      storeTaskNotificationPreferences(preferences);
      set({
        taskNotificationPreferences: preferences,
        taskNotificationTransport: transport,
      });
    } catch (error) {
      if (version === taskNotificationPreferenceVersion)
        set({
          notice: errorNotice(
            t("Notification preference was not saved"),
            error,
          ),
        });
    } finally {
      if (version === taskNotificationPreferenceVersion)
        set({ taskNotificationBusy: false });
    }
  },

  async setTaskNotificationsEnabled(enabled: boolean) {
    const version = ++taskNotificationPreferenceVersion;
    set({ taskNotificationBusy: true });
    if (!enabled) {
      try {
        await syncTaskPush(false, state.taskNotificationPreferences);
      } catch (error) {
        if (version === taskNotificationPreferenceVersion)
          set({
            taskNotificationBusy: false,
            notice: errorNotice(t("Notification revocation failed"), error),
          });
        return;
      }
      if (version !== taskNotificationPreferenceVersion) return;
      disableTaskNotifications({
        taskNotificationTransport: "local",
        notice: {
          kind: "info",
          message: t("Task notifications disabled on this device"),
          autoDismissMs: 5000,
        },
      });
      return;
    }

    if (notificationPermission() === "unsupported") {
      disableTaskNotifications({
        notice: {
          kind: "error",
          message: t("Browser notifications are not supported"),
          detail: t(
            "Use a browser with notification support over HTTPS. On iPhone or iPad, open Thyra from the Home Screen (iOS/iPadOS 16.4 or later).",
          ),
        },
      });
      return;
    }

    let permission = Notification.permission;
    try {
      if (permission === "default") {
        permission = await Notification.requestPermission();
      }
      if (version !== taskNotificationPreferenceVersion) return;
    } catch (e) {
      if (version !== taskNotificationPreferenceVersion) return;
      disableTaskNotifications({
        notice: errorNotice(t("Notification permission failed"), e),
      });
      return;
    }

    const granted = permission === "granted";
    let transport: "local" | "push" = "local";
    if (granted) {
      set({ taskNotificationBusy: true });
      try {
        await prepareTaskNotifications();
        if (version !== taskNotificationPreferenceVersion) return;
        transport = await syncTaskPush(
          true,
          state.taskNotificationPreferences,
          true,
        );
      } catch (error) {
        reportTaskNotificationFailure(error, version);
        return;
      } finally {
        if (version === taskNotificationPreferenceVersion)
          set({ taskNotificationBusy: false });
      }
    }
    if (version !== taskNotificationPreferenceVersion) return;
    storeTaskNotificationTransport(transport);
    storeTaskNotificationsEnabled(granted);
    set({
      taskNotificationsEnabled: granted,
      taskNotificationTransport: transport,
      taskNotificationBusy: false,
      taskNotificationPermission: permission,
      notice: granted
        ? {
            kind: "success",
            message: t("Task notifications enabled"),
            detail:
              transport === "push"
                ? t(
                    "This device receives completion and input-required notifications even when Thyra is closed, subject to your platform settings.",
                  )
                : t(
                    "Local notifications work while this page is running. Background delivery requires Web Push support and server configuration.",
                  ),
            autoDismissMs: 5000,
          }
        : {
            kind: "error",
            message: t("Notification permission was not granted"),
            detail: t(
              "Enable notifications for this site in the browser settings, then try again.",
            ),
          },
    });
  },
};
