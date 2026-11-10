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
    const failure = error as Error;
    const failureNotice = options.failureNotice?.(failure) ?? null;
    if (!leaseIsCurrent(activeLease)) {
      // The connection dropped under the action. Its progress notice belongs
      // to no connection now and nothing else would ever end it.
      settleLoadingNotice(activeLease, failureNotice);
      return undefined;
    }
    const ownsNotice = loadingNoticeIsShown(activeLease);
    loadingNotices.delete(activeLease);
    setForConnection(activeLease, {
      error: failure.message,
      notice: failureNotice ?? (ownsNotice ? null : state.notice),
    });
    return undefined;
  }
  if (!leaseIsCurrent(activeLease)) {
    settleLoadingNotice(activeLease, null);
    return undefined;
  }
  loadingNotices.delete(activeLease);
  if (options.refresh === "immediate") {
    void refreshNow(activeLease);
  } else if (options.refresh !== "none") {
    scheduleRefresh(activeLease);
  }
  return value;
}

/** The progress notice each running action last published, by notice id. */
const loadingNotices = new WeakMap<StoreConnectionLease, number>();

function loadingNoticeIsShown(lease: StoreConnectionLease): boolean {
  const id = loadingNotices.get(lease);
  return id !== undefined && !!state.notice?.loading && state.notice.id === id;
}

/** Replace an action's progress notice, if it is still the one on screen. */
function settleLoadingNotice(
  lease: StoreConnectionLease,
  replacement: Notice | null,
) {
  const shown = loadingNoticeIsShown(lease);
  loadingNotices.delete(lease);
  if (shown) set({ notice: replacement });
}

/** Publish a notice for the action's connection, if it is still active. */
export function noticeFor(lease: StoreConnectionLease, notice: Notice | null) {
  const published = setForConnection(lease, { notice });
  if (!published) return false;
  const id = notice?.loading ? state.notice?.id : undefined;
  if (id === undefined) loadingNotices.delete(lease);
  else loadingNotices.set(lease, id);
  return true;
}
