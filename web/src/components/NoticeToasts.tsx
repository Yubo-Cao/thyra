import { useEffect, useRef } from "react";
import { t } from "../i18n";
import {
  type Notice,
  store,
  type UpdateInfo,
  useStoreSelector,
} from "../store";
import {
  toast,
  ToastRegion,
  type ToastContent,
  type ToastTone,
} from "./ui/Toast";
import "./NoticeToasts.css";
import { useShallow } from "zustand/react/shallow";

// The store's notice and update prompt shown through the ui/ toast queue.
// App loads this module with the first notice, so the queue, the bridge,
// and the output styles stay off the first screen.

function NoticeDetail({ notice }: { notice: Notice }) {
  if (!notice.detail) return null;
  if (notice.detailMode === "output") {
    return (
      <span className="toast-output">
        {notice.detailTitle ? (
          <span className="toast-output-title">{notice.detailTitle}</span>
        ) : null}
        <pre>{notice.detail}</pre>
      </span>
    );
  }
  return notice.detail;
}

const NOTICE_TONES: Record<Notice["kind"], ToastTone> = {
  info: "info",
  success: "success",
  error: "danger",
};

function noticeToastContent(
  notice: Notice,
  onAction: (notice: Notice) => void,
): ToastContent {
  return {
    title: notice.message,
    description: notice.detail ? <NoticeDetail notice={notice} /> : undefined,
    tone: NOTICE_TONES[notice.kind],
    loading: notice.loading ?? false,
    action:
      notice.actionLabel &&
      (notice.actionPaneId ||
        notice.actionWorkspaceId ||
        notice.actionClipboardText !== undefined)
        ? { label: notice.actionLabel, onAction: () => onAction(notice) }
        : undefined,
  };
}

function updateToastContent(
  info: UpdateInfo,
  installing: boolean,
): ToastContent {
  return {
    title: t("Thyra {version} is available", {
      version: info.latest_version ?? "",
    }),
    description: `${t("Current {version}", {
      version: info.current_version ?? "",
    })}${
      installing
        ? ` · ${t("Updating...")}`
        : info.can_auto_update
          ? ` · ${t("ready to update and restart")}`
          : info.reason
            ? ` · ${info.reason}`
            : ""
    }`,
    tone: "info",
    loading: installing,
    action:
      info.can_auto_update && !installing
        ? {
            label: t("Update & restart"),
            onAction: () => void store.installUpdate(),
          }
        : undefined,
  };
}

/**
 * Show the store's single notice as a toast: a new notice replaces the open
 * one in place, and dismissing the toast clears the notice. The store's
 * auto-dismiss timer (in App) still decides when a notice expires.
 */
function useNoticeToast(
  notice: Notice | null,
  onAction: (notice: Notice) => void,
) {
  const shown = useRef<{ id: string; noticeId?: number } | null>(null);
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  useEffect(() => {
    const current = shown.current;
    if (!notice) {
      if (current) {
        shown.current = null;
        toast.close(current.id);
      }
      return;
    }
    if (current?.noticeId === notice.id) return;
    const content = noticeToastContent(notice, (target) =>
      onActionRef.current(target),
    );
    if (current && toast.update(current.id, content)) {
      current.noticeId = notice.id;
      return;
    }
    const entry: { id: string; noticeId?: number } = {
      id: "",
      noticeId: notice.id,
    };
    entry.id = toast.show(content, {
      timeout: 0,
      onClose: () => {
        if (shown.current === entry) shown.current = null;
        if (store.get().notice?.id === entry.noticeId) store.clearNotice();
      },
    });
    shown.current = entry;
  }, [notice]);
}

/** The update prompt: its own toast, dismissed through the store. */
function useUpdateToast(info: UpdateInfo | null, installing: boolean) {
  const shown = useRef<string | null>(null);
  const available = info?.update_available ? info : null;
  useEffect(() => {
    if (!available) {
      if (shown.current) toast.close(shown.current);
      shown.current = null;
      return;
    }
    const content = updateToastContent(available, installing);
    if (shown.current && toast.update(shown.current, content)) return;
    const id = toast.show(content, {
      timeout: 0,
      onClose: () => {
        if (shown.current === id) shown.current = null;
        // Hiding it mid-install leaves the install running.
        if (!store.get().updateInstalling && store.get().updateInfo)
          store.dismissUpdate();
      },
    });
    shown.current = id;
  }, [available, installing]);
}

/**
 * A newer frontend build is deployed: offer a reload rather than reloading
 * under the user. Dismissing it keeps the running build until the next load.
 */
function useWebUpdateToast(available: boolean) {
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!available) {
      if (shown.current) toast.close(shown.current);
      shown.current = null;
      return;
    }
    if (shown.current) return;
    const id = toast.show(
      {
        title: t("A new version of Thyra is available"),
        tone: "info",
        action: {
          label: t("Reload page"),
          onAction: () => window.location.reload(),
        },
      },
      {
        timeout: 0,
        onClose: () => {
          if (shown.current === id) shown.current = null;
          if (store.get().webUpdateAvailable) store.dismissWebUpdate();
        },
      },
    );
    shown.current = id;
  }, [available]);
}

/** Renders the toast region and keeps it in sync with the store. */
export function NoticeToasts({
  onNoticeAction,
}: {
  onNoticeAction: (notice: Notice) => void;
}) {
  const s = useStoreSelector(
    useShallow((state) => ({
      notice: state.notice,
      updateInfo: state.updateInfo,
      updateInstalling: state.updateInstalling,
      webUpdateAvailable: state.webUpdateAvailable,
    })),
  );
  useNoticeToast(s.notice, onNoticeAction);
  useUpdateToast(s.updateInfo, s.updateInstalling);
  useWebUpdateToast(s.webUpdateAvailable);
  return <ToastRegion />;
}
