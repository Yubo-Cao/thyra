import { thyraLocalStorage } from "./browserStorage";
import { t } from "./i18n";
import { prepareTaskNotifications } from "./taskNotifications";

export interface TaskNotificationPreferences {
  completed: boolean;
  blocked: boolean;
}

async function pushRequest(method: "GET" | "POST" | "DELETE", body?: unknown) {
  const response = await fetch("/api/notifications/push", {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Thyra-Push": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      t(
        "Unable to update background notifications. Check the server connection and try again.",
      ),
    );
  return response.json() as Promise<{
    available?: boolean;
    publicKey?: string;
  }>;
}

// Mirrors PUSH_CACHE in task-notifications-sw.js: the worker re-registers a
// subscription the browser replaces with these preferences.
const PUSH_CACHE = "thyra-push-v1";
const PUSH_PREFERENCES_KEY = "/__thyra/push-preferences";

async function rememberPushPreferences(
  preferences: TaskNotificationPreferences | null,
) {
  try {
    const cache = await caches.open(PUSH_CACHE);
    if (preferences)
      await cache.put(
        PUSH_PREFERENCES_KEY,
        new Response(JSON.stringify(preferences), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    else await cache.delete(PUSH_PREFERENCES_KEY);
  } catch {
    // Without the copy the page still re-registers on its next load.
  }
}

// The direct path names this browser's subscription on the origin it left
// (`?push-twin=`). Registering with it retires that one on the server, so the
// device is notified by the origin its window lives on, and a click finds it.
export const PUSH_TWIN_PARAM = "push-twin";
const PUSH_TWIN_KEY = "pushTwin";

function adoptPushTwin() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const twin = url.searchParams.get(PUSH_TWIN_PARAM);
  if (twin === null) return;
  url.searchParams.delete(PUSH_TWIN_PARAM);
  window.history.replaceState(window.history.state, "", url);
  if (twin) thyraLocalStorage.setItem(PUSH_TWIN_KEY, twin);
}
adoptPushTwin();

let updates: Promise<unknown> = Promise.resolve();

/**
 * This origin's push endpoint once pending changes settle, for the direct path
 * to hand over; null without one or when the browser does not answer.
 */
export function taskPushEndpoint(timeoutMs = 1500): Promise<string | null> {
  if (
    typeof navigator === "undefined" ||
    !navigator.serviceWorker ||
    !("PushManager" in window) ||
    // See syncTaskPush: without permission, leave the Push API alone.
    globalThis.Notification?.permission !== "granted"
  )
    return Promise.resolve(null);
  return Promise.race([
    updates
      .catch(() => {})
      .then(() => navigator.serviceWorker.getRegistration("/"))
      .then((registration) => registration?.pushManager?.getSubscription())
      .then((subscription) => subscription?.endpoint ?? null)
      .catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/**
 * Serialize subscription changes so a late enable cannot undo a device
 * revocation. `allowSubscribe` creates a missing subscription: `true` from the
 * enabling gesture, `"quiet"` on page load (a subscription the browser
 * dropped comes back; a browser that refuses without a gesture stays local).
 */
export function syncTaskPush(
  enabled: boolean,
  preferences: TaskNotificationPreferences,
  allowSubscribe: boolean | "quiet" = false,
): Promise<"push" | "local"> {
  const task = updates
    .catch(() => {})
    .then(async () => {
      if (
        typeof navigator === "undefined" ||
        !navigator.serviceWorker ||
        !("PushManager" in window)
      )
        return "local" as const;
      // A push subscription needs notification permission, so without it
      // there is nothing to revoke. Every page load passes here, and desktop
      // WebKit without a push service never settles getSubscription() and
      // stops running the page's scripts, so leave the Push API alone.
      if (!enabled && globalThis.Notification?.permission !== "granted")
        return "local" as const;
      const registration = enabled
        ? await prepareTaskNotifications()
        : await navigator.serviceWorker.getRegistration("/");
      if (!registration?.pushManager) return "local" as const;
      let subscription = await registration.pushManager.getSubscription();
      if (!enabled) {
        if (subscription) {
          // Persist revocation first; offline errors must not look like successful removal.
          await pushRequest("DELETE", { endpoint: subscription.endpoint });
          if (!(await subscription.unsubscribe()))
            throw new Error(
              t(
                "The browser could not revoke its push subscription. Try again.",
              ),
            );
        }
        await rememberPushPreferences(null);
        return "local" as const;
      }
      const config = await pushRequest("GET");
      if (!config.available || !config.publicKey) {
        if (subscription && !(await subscription.unsubscribe()))
          throw new Error(
            t("Unable to disable the previous push subscription."),
          );
        return "local" as const;
      }
      const applicationServerKey = Uint8Array.from(
        atob(config.publicKey.replace(/-/g, "+").replace(/_/g, "/")),
        (char) => char.charCodeAt(0),
      );
      if (
        subscription?.options.applicationServerKey &&
        new Uint8Array(subscription.options.applicationServerKey).some(
          (byte, index) => byte !== applicationServerKey[index],
        )
      ) {
        await pushRequest("DELETE", { endpoint: subscription.endpoint });
        if (!(await subscription.unsubscribe()))
          throw new Error(
            t("Unable to replace the previous push subscription."),
          );
        subscription = null;
      }
      let created = false;
      if (!subscription && allowSubscribe) {
        try {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey,
          });
          created = true;
        } catch (error) {
          if (allowSubscribe !== "quiet") throw error;
        }
      }
      if (!subscription) return "local" as const;
      try {
        const twin = thyraLocalStorage.getItem(PUSH_TWIN_KEY);
        await pushRequest("POST", {
          subscription: subscription.toJSON(),
          preferences,
          ...(twin && twin !== subscription.endpoint ? { twin } : {}),
        });
      } catch (error) {
        if (created) await subscription.unsubscribe();
        throw error;
      }
      await rememberPushPreferences(preferences);
      return "push" as const;
    });
  updates = task;
  return task;
}
