// The wrapper every Herdr RPC action goes through: pause gating, failure
// notices, and refresh.
import { t } from "../i18n";
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
import { refreshNow, scheduleRefresh } from "./refresh";

export async function action<T>(
  fn: (lease: StoreConnectionLease) => Promise<T>,
  options: {
    refresh?: "scheduled" | "immediate" | "none";
    failureNotice?: (error: Error) => Notice;
  } = {},
): Promise<T | undefined> {
  if (state.connectionPaused) {
    set({
      notice: pausedNotice(
        t("Resume the connection before sending actions to Herdr."),
      ),
    });
    return undefined;
  }
  const activeLease = captureConnectionLease();
  let value: T;
  try {
    value = await fn(activeLease);
  } catch (error) {
    if (!leaseIsCurrent(activeLease)) return undefined;
    const failure = error as Error;
    setForConnection(activeLease, {
      error: failure.message,
      notice: options.failureNotice?.(failure) ?? state.notice,
    });
    return undefined;
  }
  if (!leaseIsCurrent(activeLease)) return undefined;
  if (options.refresh === "immediate") {
    void refreshNow(activeLease);
  } else if (options.refresh !== "none") {
    scheduleRefresh(activeLease);
  }
  return value;
}

/** Publish a notice for the action's connection, if it is still active. */
export function noticeFor(lease: StoreConnectionLease, notice: Notice | null) {
  return setForConnection(lease, { notice });
}
