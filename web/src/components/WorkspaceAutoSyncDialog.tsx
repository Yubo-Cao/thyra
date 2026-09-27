import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { store } from "../store";
import { UI_LOCALE } from "../uiLocale";
import { useConnectionClient } from "../useConnectionClient";
import { Dialog } from "./ui/Dialog";
import { Switch } from "./ui/Switch";
import "./WorkspaceAutoSyncDialog.css";

type AutoSyncStatus = "updated" | "up_to_date" | "skipped" | "failed";

type WorkspaceAutoSyncInfo = {
  workspace_id: string;
  workspace_label?: string;
  checkout_path?: string | null;
  key: string;
  enabled: boolean;
  interval_minutes: number;
  last_run_at?: string;
  last_status?: AutoSyncStatus;
  last_message?: string;
  last_branch?: string;
  running: boolean;
};

export function WorkspaceAutoSyncDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId?: string;
  onClose: () => void;
}) {
  const connectionClient = useConnectionClient();
  const [info, setInfo] = useState<WorkspaceAutoSyncInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const loadRequest = useRef(0);

  const load = useCallback(
    async (showLoading: boolean) => {
      if (!workspaceId) return;
      const requestId = ++loadRequest.current;
      if (showLoading) setLoading(true);
      try {
        const result = await connectionClient.call(
          "settings.workspace_auto_sync.get",
          { workspace_id: workspaceId },
        );
        if (connectionClient.isCurrent() && requestId === loadRequest.current) {
          setInfo(result as WorkspaceAutoSyncInfo);
          setError("");
        }
      } catch (loadError) {
        if (connectionClient.isCurrent() && requestId === loadRequest.current) {
          setError((loadError as Error).message);
        }
      } finally {
        if (
          showLoading &&
          connectionClient.isCurrent() &&
          requestId === loadRequest.current
        ) {
          setLoading(false);
        }
      }
    },
    [connectionClient, workspaceId],
  );

  useEffect(() => {
    if (!open || !workspaceId) return;
    setInfo(null);
    setSaving(false);
    setError("");
    void load(true);
    const timer = window.setInterval(() => void load(false), 3_000);
    return () => {
      window.clearInterval(timer);
      loadRequest.current += 1;
    };
  }, [load, open, workspaceId]);

  const setEnabled = async (enabled: boolean) => {
    if (!workspaceId || !connectionClient.isCurrent()) return;
    setSaving(true);
    setError("");
    const result = await store.setWorkspaceAutoSyncEnabled(
      workspaceId,
      enabled,
    );
    if (result && connectionClient.isCurrent()) await load(false);
    if (connectionClient.isCurrent()) setSaving(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="sm"
      className="workspace-auto-sync-dialog"
      title={t("Automatic Branch Updates")}
    >
      <p className="auto-sync-description">
        {t(
          "Every {minutes} minutes, fetch {remote}'s default branch and merge it into this workspace's current branch. A dirty workspace is skipped, and conflicting merges are aborted automatically. Updates run only while this workspace is open in the current Thyra connection.",
          { minutes: info?.interval_minutes ?? 10 },
        )
          .split("{remote}")
          .flatMap((part, index) =>
            index === 0
              ? [part]
              : [<code key={`remote-${index}`}>origin</code>, part],
          )}
      </p>

      {loading ? (
        <div className="auto-sync-loading" role="status">
          <span>{t("Loading automatic update settings...")}</span>
        </div>
      ) : (
        <>
          {error ? <p className="modal-error">{error}</p> : null}

          <div className="auto-sync-summary">
            <SummaryRow
              label={t("Workspace")}
              value={info?.workspace_label ?? "-"}
            />
            <SummaryRow
              label={t("Checkout")}
              value={info?.checkout_path ?? "-"}
            />
            <SummaryRow label={t("Branch")} value={info?.last_branch ?? "-"} />
            <SummaryRow
              label={t("Last run")}
              value={formatLastRun(info?.last_run_at)}
            />
          </div>

          <Switch
            className="auto-sync-toggle-row"
            labelPosition="start"
            checked={info?.enabled ?? false}
            disabled={!info}
            description={
              info?.running
                ? t("Syncing origin's default branch now...")
                : statusLabel(info?.last_status)
            }
            onChange={(checked) => {
              if (!saving) void setEnabled(checked);
            }}
          >
            {t("Keep branch updated")}
          </Switch>

          {info?.last_message ? (
            <div
              className="auto-sync-result"
              data-status={info.last_status ?? "unknown"}
            >
              {info.last_message}
            </div>
          ) : null}
        </>
      )}
    </Dialog>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="auto-sync-summary-row">
      <span>{label}</span>
      <code title={value}>{value}</code>
    </div>
  );
}

function formatLastRun(value?: string) {
  if (!value) return t("Not run yet");
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(UI_LOCALE);
}

function statusLabel(status?: AutoSyncStatus) {
  switch (status) {
    case "updated":
      return t("Updated from origin's default branch");
    case "up_to_date":
      return t("Already up to date");
    case "skipped":
      return t("Last run was skipped");
    case "failed":
      return t("Last run failed");
    default:
      return t("No sync has run yet");
  }
}
