import { useCallback, useEffect, useRef } from "react";
import { Latched } from "../components/LazyBoundary";
import { t } from "../i18n";
import {
  isTaskNotificationTarget,
  type Notice,
  noticeAutoDismissDelay,
  store,
  TASK_NOTIFICATION_ACTIVATE_EVENT,
  type TaskNotificationTarget,
  taskNotificationTargetFromNotice,
  taskNotificationTargetIsCurrent,
  useStoreSelector,
} from "../store";
import { copyTextFromUserGesture } from "../terminalClipboard";
import { listenForTaskNotificationActivation } from "../taskNotifications";
import { noticeToastsPanel } from "./lazySurfaces";
import { useShallow } from "zustand/react/shallow";

const NoticeToasts = noticeToastsPanel.Component;

/** Notice and update toasts, loaded with the first one. */
export function NoticeHost({
  onOpenTarget,
}: {
  onOpenTarget: (target: TaskNotificationTarget) => void;
}) {
  const { notice, updateAvailable } = useStoreSelector(
    useShallow((state) => ({
      notice: state.notice,
      updateAvailable: !!state.updateInfo?.update_available,
    })),
  );
  useEffect(() => {
    if (!notice) return;
    const dismissDelay = noticeAutoDismissDelay(notice);
    if (dismissDelay === null) return;
    const noticeId = notice.id;
    const timer = window.setTimeout(() => {
      if (store.get().notice?.id === noticeId) store.clearNotice();
    }, dismissDelay);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const handleNoticeAction = useCallback(
    (notice: Notice) => {
      if (notice.actionClipboardText !== undefined) {
        const text = notice.actionClipboardText;
        store.clearNotice();
        void copyTextFromUserGesture(text).then(
          () =>
            store.notify({
              kind: "success",
              message: t("Copied to clipboard"),
              autoDismissMs: 5000,
            }),
          (error) =>
            store.notify({
              kind: "error",
              message: t("Terminal copy failed"),
              detail: error instanceof Error ? error.message : String(error),
            }),
        );
        return;
      }
      const target = taskNotificationTargetFromNotice(notice);
      store.clearNotice();
      if (target) onOpenTarget(target);
    },
    [onOpenTarget],
  );
  return (
    <Latched open={!!notice || updateAvailable} fallback={null}>
      <NoticeToasts onNoticeAction={handleNoticeAction} />
    </Latched>
  );
}

/**
 * Open the pane a system or service-worker notification points at, waiting
 * until the connection it belongs to is up.
 */
export function useTaskNotificationActivation(
  openTarget: (target: TaskNotificationTarget) => void,
) {
  const pendingRef = useRef<TaskNotificationTarget | null>(null);
  useEffect(() => {
    const activatePending = () => {
      const target = pendingRef.current;
      const snapshot = store.get();
      if (
        !target ||
        snapshot.status !== "connected" ||
        !snapshot.connections.length
      )
        return;
      pendingRef.current = null;
      if (!taskNotificationTargetIsCurrent(snapshot, target)) return;
      openTarget(target);
      const notice = store.get().notice;
      if (
        notice?.actionConnectionId === target.connectionId &&
        notice.actionRuntimeGeneration === target.runtimeGeneration &&
        notice.actionPaneId === target.paneId
      ) {
        store.clearNotice();
      }
    };
    const receive = (target: TaskNotificationTarget) => {
      pendingRef.current = target;
      activatePending();
    };
    const handleSystemNotification = (event: Event) => {
      const target = (event as CustomEvent<unknown>).detail;
      if (isTaskNotificationTarget(target)) receive(target);
    };
    const unsubscribe = store.subscribe(activatePending);
    const stopWorkerNotifications =
      listenForTaskNotificationActivation(receive);
    activatePending();
    window.addEventListener(
      TASK_NOTIFICATION_ACTIVATE_EVENT,
      handleSystemNotification,
    );
    return () => {
      unsubscribe();
      stopWorkerNotifications();
      window.removeEventListener(
        TASK_NOTIFICATION_ACTIVATE_EVENT,
        handleSystemNotification,
      );
    };
  }, [openTarget]);
}
