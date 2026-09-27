// The wrapper every Herdr RPC action goes through: pause gating, one retry
// across a socket reconnect, failure notices, focus settlement, and refresh.
import { t } from "../i18n";
import { isReconnectRetryableError } from "../reconnectRetry";
import {
  captureConnectionLease,
  leaseIsCurrent,
  type Notice,
  pausedNotice,
  set,
  setForConnection,
  state,
  type StoreConnectionLease,
} from "./core";
import {
  clearPendingFocusWorkspace,
  refreshNow,
  scheduleRefresh,
  settlePendingFocusWorkspace,
} from "./refresh";

const RECONNECT_RETRY_WAIT_MS = 10_000;
const RECONNECT_RETRY_POLL_MS = 100;

let focusActionChain: Promise<unknown> = Promise.resolve();

/** Run focus RPCs one at a time so their effects land in click order. */
export function enqueueFocusAction<T>(fn: () => Promise<T>): Promise<T> {
  const task = focusActionChain.then(fn, fn);
  focusActionChain = task.catch(() => undefined);
  return task;
}

/** Stop ordering new focus actions behind ones for a connection we left. */
export function resetFocusActions() {
  focusActionChain = Promise.resolve();
}

async function waitForReconnectReady(): Promise<boolean> {
  const deadline = Date.now() + RECONNECT_RETRY_WAIT_MS;
  // The connection catalog carrying the runtime generation lands shortly
  // after the socket reconnects; a fresh lease only reports current once
  // scoped routing is usable, so poll instead of trusting the status flip.
  while (Date.now() < deadline) {
    if (
      state.status === "connected" &&
      !state.connectionPaused &&
      captureConnectionLease().client.isCurrent()
    ) {
      return true;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, RECONNECT_RETRY_POLL_MS),
    );
  }
  return false;
}

export async function action<T>(
  fn: (lease: StoreConnectionLease) => Promise<T>,
  options: {
    refresh?: "scheduled" | "immediate" | "none";
    pendingFocusWorkspaceSeq?: number;
    failureNotice?: (error: Error) => Notice;
    retryOnReconnect?: boolean;
  } = {},
): Promise<T | undefined> {
  if (state.connectionPaused) {
    // The caller may have already stamped a focus marker; the attempt never
    // starts here, so release it instead of stranding it unsettled.
    if (options.pendingFocusWorkspaceSeq !== undefined) {
      clearPendingFocusWorkspace(options.pendingFocusWorkspaceSeq);
    }
    set({
      notice: pausedNotice(
        t("Resume the connection before sending actions to Herdr."),
      ),
    });
    return undefined;
  }
  const attempt = (
    activeLease: StoreConnectionLease,
  ): Promise<{ ok: true; value: T } | { ok: false; error: Error }> =>
    fn(activeLease).then(
      (value) => ({ ok: true, value }) as const,
      (error: Error) => ({ ok: false, error }) as const,
    );
  let activeLease = captureConnectionLease();
  let outcome = await attempt(activeLease);
  // A focus action fired while the bridge socket is reconnecting fails before
  // reaching the server, which makes clicks right after returning to the app
  // look dropped. Retry it once on the fresh connection with a new lease.
  if (
    !outcome.ok &&
    options.retryOnReconnect &&
    isReconnectRetryableError(outcome.error) &&
    !state.connectionPaused &&
    (await waitForReconnectReady()) &&
    !state.connectionPaused
  ) {
    activeLease = captureConnectionLease();
    outcome = await attempt(activeLease);
  }
  if (!outcome.ok) {
    // Releasing the focus marker must not depend on the lease surviving: the
    // attempt is over, and a dead lease (pause, disconnect, connection
    // switch) would otherwise strand the marker in a cached session whose
    // steady-state restore never marks it settled.
    if (options.pendingFocusWorkspaceSeq !== undefined) {
      clearPendingFocusWorkspace(options.pendingFocusWorkspaceSeq);
    }
    if (!leaseIsCurrent(activeLease)) return undefined;
    const error = outcome.error;
    setForConnection(activeLease, {
      error: error.message,
      notice: options.failureNotice?.(error) ?? state.notice,
    });
    return undefined;
  }
  // The action completed, so the attempt is settled even when the lease died
  // before the client observed it; the next fresh observation decides.
  if (options.pendingFocusWorkspaceSeq !== undefined) {
    settlePendingFocusWorkspace(options.pendingFocusWorkspaceSeq);
  }
  if (!leaseIsCurrent(activeLease)) return undefined;
  if (options.refresh === "immediate") {
    void refreshNow(activeLease);
  } else if (options.refresh !== "none") {
    scheduleRefresh(activeLease);
  }
  return outcome.value;
}

/** Publish a notice for the action's connection, if it is still active. */
export function noticeFor(lease: StoreConnectionLease, notice: Notice | null) {
  return setForConnection(lease, { notice });
}
