// Browser-persisted store preferences. The core reads them for the initial
// state; the owning slices write them back when the user changes them.
import {
  thyraLocalStorage,
  thyraSessionStorage,
  thyraStorageEventKey,
} from "../browserStorage";
import type { TaskNotificationPreferences } from "../taskPush";

const TASK_NOTIFICATIONS_KEY = "taskNotificationsEnabled";
const TASK_NOTIFICATION_PREFERENCES_KEY = "taskNotificationPreferences";
const TASK_NOTIFICATION_TRANSPORT_KEY = "taskNotificationTransport";
const AUTOMATIC_UPDATE_CHECKS_KEY = "automaticUpdateChecksEnabled";
const PENDING_UPDATE_RELOAD_KEY = "pendingUpdateReloadVersion";
const CONNECTION_PAUSED_KEY = "connectionPaused";

export function notificationPermission():
  | NotificationPermission
  | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

export function storedTaskNotificationPreferences(): TaskNotificationPreferences {
  try {
    const stored = JSON.parse(
      thyraLocalStorage.getItem(TASK_NOTIFICATION_PREFERENCES_KEY) ?? "{}",
    );
    return {
      completed: stored.completed !== false,
      blocked: stored.blocked !== false,
    };
  } catch {
    return { completed: true, blocked: true };
  }
}

export function storeTaskNotificationPreferences(
  preferences: TaskNotificationPreferences,
) {
  thyraLocalStorage.setItem(
    TASK_NOTIFICATION_PREFERENCES_KEY,
    JSON.stringify(preferences),
  );
}

/** Whether a cross-tab storage event may have changed the notification setup. */
export function taskNotificationStorageChanged(
  event: Pick<StorageEvent, "key">,
): boolean {
  const key = thyraStorageEventKey(event);
  return (
    key === TASK_NOTIFICATIONS_KEY ||
    key === TASK_NOTIFICATION_PREFERENCES_KEY ||
    key === null
  );
}

export function storedTaskNotificationsEnabled() {
  return (
    notificationPermission() === "granted" &&
    typeof localStorage !== "undefined" &&
    thyraLocalStorage.getItem(TASK_NOTIFICATIONS_KEY) === "true"
  );
}

export function storedTaskNotificationTransport(): "local" | "push" {
  return thyraLocalStorage.getItem(TASK_NOTIFICATION_TRANSPORT_KEY) === "push"
    ? "push"
    : "local";
}

export function storeTaskNotificationTransport(transport: "local" | "push") {
  thyraLocalStorage.setItem(TASK_NOTIFICATION_TRANSPORT_KEY, transport);
}

export function storeTaskNotificationsEnabled(enabled: boolean) {
  thyraLocalStorage.setItem(TASK_NOTIFICATIONS_KEY, String(enabled));
}

export function automaticUpdateChecksEnabledFromStorage(
  storage: Pick<Storage, "getItem"> | undefined,
): boolean {
  try {
    return storage?.getItem(AUTOMATIC_UPDATE_CHECKS_KEY) !== "false";
  } catch {
    return true;
  }
}

export function storedAutomaticUpdateChecksEnabled(): boolean {
  return automaticUpdateChecksEnabledFromStorage(
    typeof localStorage === "undefined" ? undefined : thyraLocalStorage,
  );
}

export function storeAutomaticUpdateChecksEnabled(enabled: boolean) {
  try {
    thyraLocalStorage.setItem(AUTOMATIC_UPDATE_CHECKS_KEY, String(enabled));
  } catch {
    // The in-memory preference still applies when storage is unavailable.
  }
}

export function storedPendingRestartVersion(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    return thyraSessionStorage.getItem(PENDING_UPDATE_RELOAD_KEY);
  } catch {
    return null;
  }
}

export function storePendingRestartVersion(version: string | null) {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (version) {
      thyraSessionStorage.setItem(PENDING_UPDATE_RELOAD_KEY, version);
    } else {
      thyraSessionStorage.removeItem(PENDING_UPDATE_RELOAD_KEY);
    }
  } catch {
    // Storage may be unavailable in private or restricted browser contexts.
  }
}

export function storedConnectionPaused(): boolean {
  return (
    typeof localStorage !== "undefined" &&
    thyraLocalStorage.getItem(CONNECTION_PAUSED_KEY) === "true"
  );
}

export function storeConnectionPaused(paused: boolean) {
  thyraLocalStorage.setItem(CONNECTION_PAUSED_KEY, String(paused));
}
