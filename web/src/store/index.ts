// The application store: composes the slices in this directory into the one
// `store` object the UI uses, and wires them to the bridge on `init`.
//
// Layering (each module imports only from those above it):
//   preferences -> core -> notifications -> refresh -> actions -> updates
//   -> popup -> connection -> navigation -> workspaces, worktrees, git
import { bridge, type ConnectionSummary } from "../api";
import { prepareAppUpdate, servesOtherBuild } from "../appServiceWorker";
import { hostCapable } from "../capabilities";
import { t } from "../i18n";
import { afterStartup } from "../startupGate";
import {
  applyConnectionCatalog,
  connectionActions,
  handleHello,
  handleStatus,
  markInitialized,
  markTerminalReattachPending,
  rearmTerminalAttachmentsAfterCatalog,
  refreshBridgeStatus,
  refreshOnReturn,
  resetConnectionRuntime,
  startPollingUnlessPaused,
} from "./connection";
import { getState, type Notice, set, state, subscribe } from "./core";
import { gitActions } from "./git";
import { navigationActions } from "./navigation";
import {
  notificationActions,
  reloadTaskNotificationPreferences,
  restoreTaskNotifications,
} from "./notifications";
import { handlePopupPush, popupActions } from "./popup";
import { taskNotificationStorageChanged } from "./preferences";
import { handleHerdrEvent, refreshNow } from "./refresh";
import {
  redirectToLogin,
  reloadWhenUpdatedServerIsReady,
  startUpdatePolling,
  updateActions,
  updatePollingActive,
} from "./updates";
import { workspaceActions } from "./workspaces";
import { worktreeActions } from "./worktrees";

export {
  isTaskNotificationTarget,
  TASK_NOTIFICATION_ACTIVATE_EVENT,
  type TaskNotificationTarget,
} from "../taskNotifications";
export {
  noticeAutoDismissDelay,
  useStoreSelector,
  type Notice,
  type PopupInfo,
  type State,
  type UpdateInfo,
} from "./core";
export {
  endpointCreationReason,
  navigateProgrammatically,
  onUserNavigation,
  terminalNavigationLoading,
  useEndpointCreationReason,
} from "./navigation";
export {
  taskNotificationTargetFromNotice,
  taskNotificationTargetIsCurrent,
} from "./notifications";
export {
  WORKTREE_REMOVED_EVENT,
  type WorktreeRemovedTarget,
} from "./worktrees";

/** The newer frontend build the page last offered a reload for. */
let offeredWebEntry: string | undefined;

function init() {
  if (!markInitialized()) return;
  // Background-notification sync (service worker, push subscription) is
  // not needed for the first terminal output.
  afterStartup(() => void restoreTaskNotifications());
  window.addEventListener("storage", (event) => {
    if (taskNotificationStorageChanged(event))
      reloadTaskNotificationPreferences();
  });
  bridge.onHello((hello) => {
    handleHello(hello.default_connection_id);
    set({ host: hostCapable(hello.principal) });
    // A deploy restarted the bridge under this open page: offer a reload
    // (an in-app update reloads by itself).
    if (
      import.meta.env.PROD &&
      hello.web_entry !== offeredWebEntry &&
      !state.webUpdateAvailable &&
      !state.pendingRestartVersion &&
      servesOtherBuild(hello.web_entry)
    ) {
      offeredWebEntry = hello.web_entry;
      set({ webUpdateAvailable: true });
      prepareAppUpdate();
    }
  });
  bridge.onStatus(handleStatus);
  bridge.onEvent(handleHerdrEvent);
  bridge.onPopup(handlePopupPush);
  bridge.onControl((control) => {
    if (control.type === "pause_connection") {
      store.pauseConnection(
        control.reason ??
          t(
            "Another Thyra client paused this connection. Resume when you want this browser to sync again.",
          ),
      );
    }
  });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshOnReturn();
    });
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", refreshOnReturn);
    window.addEventListener("online", refreshOnReturn);
  }
  // Open the socket right away: on slow HTTP/1.1 links it would otherwise
  // queue behind the terminal chunks for one of six connections.
  if (!state.connectionPaused) bridge.connect();
  // If the server requires a password and the session is missing/expired,
  // bounce to the login page instead of spinning on a failing socket.
  fetch("/api/health", {
    credentials: "same-origin",
    cache: "no-store",
  }).then(
    (r) => {
      if (r.status === 401) {
        bridge.disconnect();
        redirectToLogin();
        return;
      }
      if (state.pendingRestartVersion) {
        void reloadWhenUpdatedServerIsReady(state.pendingRestartVersion);
      }
      startPollingUnlessPaused();
    },
    () => {
      // Offline (the worker's cached shell): the socket keeps reconnecting.
    },
  );
}

export const store = {
  get: getState,
  subscribe,
  init,
  refresh: refreshNow,
  ...connectionActions,
  ...navigationActions,
  ...workspaceActions,
  ...worktreeActions,
  ...gitActions,
  ...popupActions,
  ...notificationActions,
  ...updateActions,

  clearNotice() {
    set({ notice: null });
  },

  notify(notice: Notice) {
    set({ notice });
  },

  dismissWebUpdate() {
    set({ webUpdateAvailable: false });
  },
};

/** Test-only singleton seam for deterministic deferred production-store tests. */
export const __storeTesting = {
  handleHerdrEvent,
  startUpdatePolling,
  updatePollingActive,
  refreshBridgeStatus,
  markTerminalReattachPending,
  rearmTerminalAttachmentsAfterCatalog,
  replaceState: resetConnectionRuntime,
  applyCatalog(connections: ConnectionSummary[], defaultConnectionId: string) {
    applyConnectionCatalog({
      connections,
      default_connection_id: defaultConnectionId,
    });
  },
};
