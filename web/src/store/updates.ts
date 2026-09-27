// Thyra self-update: periodic and manual checks, installation, and the reload
// once the supervisor has restarted the server on the new version.
import { t } from "../i18n";
import { afterStartup } from "../startupGate";
import {
  errorNotice,
  pausedNotice,
  set,
  type State,
  state,
  type UpdateInfo,
} from "./core";
import {
  storeAutomaticUpdateChecksEnabled,
  storePendingRestartVersion,
} from "./preferences";

const UPDATE_RESTART_VERIFY_TIMEOUT_MS = 90 * 1000;
const UPDATE_RESTART_VERIFY_INTERVAL_MS = 750;
const UPDATE_POLL_MS = 30 * 60 * 1000;

let updateTimer: ReturnType<typeof setInterval> | null = null;
// The update check is not needed for the first screen; it waits until a
// terminal has output so it never competes with it on slow links.
let cancelDeferredUpdatePolling: (() => void) | null = null;
let updateReloadVerification: {
  version: string;
  promise: Promise<void>;
} | null = null;

export function healthMatchesUpdateVersion(
  health: unknown,
  expectedVersion: string,
): boolean {
  return (
    typeof health === "object" &&
    health !== null &&
    "version" in health &&
    (health as { version?: unknown }).version === expectedVersion
  );
}

export function redirectToLogin() {
  const loginUrl = new URL("/login", window.location.origin);
  window.location.replace(loginUrl.href);
}

/**
 * Keep the old frontend alive until the supervisor starts the updated process
 * and it serves the expected version. The session marker survives a manual
 * reload during the restart window and is cleared before the automatic reload.
 */
export function reloadWhenUpdatedServerIsReady(
  expectedVersion: string,
): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (updateReloadVerification?.version === expectedVersion) {
    return updateReloadVerification.promise;
  }

  const promise = (async () => {
    const deadline = Date.now() + UPDATE_RESTART_VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`/api/health?t=${Date.now()}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.status === 401) {
          storePendingRestartVersion(null);
          set({ pendingRestartVersion: null });
          redirectToLogin();
          return;
        }
        if (response.ok) {
          const health = await response.json().catch(() => null);
          if (healthMatchesUpdateVersion(health, expectedVersion)) {
            storePendingRestartVersion(null);
            set({
              pendingRestartVersion: null,
              notice: {
                kind: "success",
                message: t("Thyra {version} is running", {
                  version: expectedVersion,
                }),
                detail: t(
                  "Reloading the application to use the updated frontend.",
                ),
                loading: true,
              },
            });
            window.location.reload();
            return;
          }
        }
      } catch {
        // The bridge is expected to be briefly unavailable during replacement.
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, UPDATE_RESTART_VERIFY_INTERVAL_MS),
      );
    }

    storePendingRestartVersion(null);
    set({
      pendingRestartVersion: null,
      notice: {
        kind: "error",
        message: t("Updated server did not become ready"),
        detail: t(
          "Could not verify Thyra {version}. Reload the page after checking the server process.",
          { version: expectedVersion },
        ),
      },
    });
  })().finally(() => {
    if (updateReloadVerification?.promise === promise) {
      updateReloadVerification = null;
    }
  });
  updateReloadVerification = { version: expectedVersion, promise };
  return promise;
}

async function checkForUpdate(showErrors = false) {
  if (!showErrors && !state.automaticUpdateChecksEnabled) return;
  if (state.connectionPaused) {
    if (showErrors) {
      set({
        notice: pausedNotice(
          t("Resume the connection before checking for updates."),
        ),
      });
    }
    return;
  }
  try {
    const r = await fetch("/api/update/check", {
      credentials: "same-origin",
      headers: { "x-thyra-update": "1" },
    });
    if (!r.ok) {
      if (showErrors) {
        const body = await r.json().catch(() => null);
        set({
          notice: {
            kind: "error",
            message: t("Update check failed"),
            detail: body?.error ?? r.statusText,
          },
        });
      }
      return;
    }
    const info = (await r.json()) as UpdateInfo;
    if (!showErrors && !state.automaticUpdateChecksEnabled) return;
    if (
      info.update_available &&
      info.latest_version &&
      (showErrors || state.dismissedUpdateVersion !== info.latest_version)
    ) {
      set({ updateInfo: info });
    } else if (!info.update_available) {
      set({
        updateInfo: null,
        notice: showErrors
          ? {
              kind: "success",
              message: t("Thyra is up to date"),
              detail: info.latest_version
                ? t("Current version: {version}", {
                    version: info.current_version,
                  })
                : undefined,
            }
          : state.notice,
      });
    }
  } catch (e) {
    if (showErrors) {
      set({
        notice: errorNotice(t("Update check failed"), e),
      });
    }
  }
}

export function startUpdatePolling(): Promise<void> {
  if (updateTimer || !state.automaticUpdateChecksEnabled) {
    return Promise.resolve();
  }
  const initialCheck = checkForUpdate(false);
  updateTimer = setInterval(() => void checkForUpdate(false), UPDATE_POLL_MS);
  return initialCheck;
}

/** Start update polling once the first screen has settled. */
export function startUpdatePollingAfterStartup() {
  cancelDeferredUpdatePolling?.();
  cancelDeferredUpdatePolling = afterStartup(() => {
    cancelDeferredUpdatePolling = null;
    void startUpdatePolling();
  });
}

export function stopUpdatePolling(includeDeferred = true) {
  if (includeDeferred) {
    cancelDeferredUpdatePolling?.();
    cancelDeferredUpdatePolling = null;
  }
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
}

export function updatePollingActive() {
  return updateTimer !== null;
}

async function installUpdate() {
  if (state.connectionPaused) {
    set({
      notice: pausedNotice(
        t("Resume the connection before installing updates."),
      ),
    });
    return;
  }
  const latestVersion = state.updateInfo?.latest_version;
  if (!latestVersion || state.updateInstalling) return;
  set({ updateInstalling: true });
  try {
    const r = await fetch("/api/update/install", {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-thyra-update": "1" },
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      throw new Error(body?.error ?? r.statusText);
    }
    // Every outcome retires the offer that was just installed.
    const finish = (patch: Partial<State>) =>
      set({
        updateInfo: null,
        updateInstalling: false,
        dismissedUpdateVersion: latestVersion,
        ...patch,
      });
    if (!body?.installed) {
      finish({
        notice: { kind: "success", message: t("Thyra is already up to date") },
      });
      return;
    }
    const installedVersion = body.installed_version ?? latestVersion;
    if (body.restart_scheduled) {
      storePendingRestartVersion(installedVersion);
      finish({
        pendingRestartVersion: installedVersion,
        notice: {
          kind: "info",
          message: t("Restarting the Thyra process"),
          detail: t(
            "The binary was updated. Waiting for the external process supervisor to start the new version.",
          ),
          loading: true,
        },
      });
      void reloadWhenUpdatedServerIsReady(installedVersion);
      return;
    }
    finish({
      notice: {
        kind: "success",
        message: t("Thyra {version} installed", { version: installedVersion }),
        detail: t("Restart the Thyra process to use the new version."),
      },
    });
  } catch (e) {
    set({
      updateInstalling: false,
      notice: errorNotice(t("Update install failed"), e),
    });
  }
}

export const updateActions = {
  checkForUpdate() {
    return checkForUpdate(true);
  },

  setAutomaticUpdateChecksEnabled(enabled: boolean) {
    storeAutomaticUpdateChecksEnabled(enabled);
    if (!enabled) stopUpdatePolling(false);
    set({
      automaticUpdateChecksEnabled: enabled,
      updateInfo: enabled ? state.updateInfo : null,
    });
    if (enabled && !state.connectionPaused) startUpdatePolling();
  },

  updateOrCheck() {
    if (
      state.updateInfo?.update_available &&
      state.updateInfo.can_auto_update
    ) {
      return installUpdate();
    }
    return checkForUpdate(true);
  },

  dismissUpdate() {
    set({
      dismissedUpdateVersion: state.updateInfo?.latest_version ?? null,
      updateInfo: null,
    });
  },

  installUpdate,
};
