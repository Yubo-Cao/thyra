import {
  FileDiff,
  Focus as FocusIcon,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitMerge,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { t } from "../i18n";
import { store } from "../store";
import type { InspectorView } from "../workspaceResource";
import {
  lifecycleAutoSyncLabel,
  lifecycleGitChangeCount,
  lifecycleGitSummary,
  lifecycleWorktreeTitle,
  type WorkspaceAutoSyncInfo,
  type WorktreeLifecycleRow as LifecycleRow,
} from "../worktreeLifecycle";
import { Button } from "./ui/Button";
import { Spinner } from "./ui/Spinner";
import { Token } from "./ui/Token";

export function WorktreeLifecycleRow({
  row,
  syncInfo,
  operationRunning,
  rowBusy,
  runOperation,
  onFocus,
  onOpen,
  onOpenResource,
  onRemove,
}: {
  row: LifecycleRow;
  syncInfo?: WorkspaceAutoSyncInfo;
  operationRunning: boolean;
  rowBusy: boolean;
  runOperation: (
    key: string,
    label: string,
    action: () => Promise<unknown>,
  ) => void;
  onFocus: (workspaceId: string) => void;
  onOpen: (row: LifecycleRow) => Promise<unknown>;
  onOpenResource: (row: LifecycleRow, view: InspectorView) => Promise<unknown>;
  onRemove: (row: LifecycleRow) => void;
}) {
  const workspace = row.workspace;
  const rowKey = row.worktree.path;
  const title = lifecycleWorktreeTitle(row.worktree);
  const changed = lifecycleGitChangeCount(row.gitStatus);

  return (
    <article className="lifecycle-row" role="listitem">
      <div className="lifecycle-row-main">
        <div className="lifecycle-row-title">
          <GitBranch size={16} />
          <strong>{title}</strong>
          <Token>
            {row.worktree.is_linked_worktree ? t("Linked") : t("Main")}
          </Token>
          <Token tone={workspace ? "success" : "neutral"}>
            {workspace ? t("Open") : t("Closed")}
          </Token>
        </div>
        <code title={row.worktree.path}>{row.worktree.path}</code>
        <div className="lifecycle-row-meta">
          <span className={changed ? "has-changes" : ""}>
            {lifecycleGitSummary(row.gitStatus)}
          </span>
          {workspace ? (
            <span
              className={`lifecycle-sync-status lifecycle-sync-${
                syncInfo?.running
                  ? "running"
                  : (syncInfo?.last_status ?? "idle")
              }`}
              title={syncInfo?.last_message}
            >
              {lifecycleAutoSyncLabel(syncInfo)}
            </span>
          ) : null}
          {row.worktree.is_prunable ? (
            <span className="lifecycle-prunable">{t("Prunable")}</span>
          ) : null}
        </div>
      </div>

      <div className="lifecycle-row-actions">
        {workspace ? (
          <Button
            disabled={operationRunning}
            onClick={() => onFocus(workspace.workspace_id)}
          >
            <FocusIcon size={14} />
            {t("Focus")}
          </Button>
        ) : (
          <Button
            title={t("Open worktree")}
            disabled={operationRunning}
            onClick={() =>
              runOperation(rowKey, t("Opening worktree"), () => onOpen(row))
            }
          >
            <FolderOpen size={14} />
            {t("Open")}
          </Button>
        )}
        {!workspace && !row.worktree.is_prunable ? (
          <>
            <Button
              title={t("Open workspace and browse files")}
              disabled={operationRunning}
              onClick={() =>
                runOperation(rowKey, t("Opening Files"), () =>
                  onOpenResource(row, "files"),
                )
              }
            >
              <FolderTree size={14} />
              {t("Files")}
            </Button>
            <Button
              title={t("Open workspace and review changes")}
              disabled={operationRunning}
              onClick={() =>
                runOperation(rowKey, t("Opening Changes"), () =>
                  onOpenResource(row, "changes"),
                )
              }
            >
              <FileDiff size={14} />
              {t("Changes")}
            </Button>
          </>
        ) : null}
        {workspace ? (
          <Button
            aria-label={t("Pull {name}", { name: title })}
            title={t("Git pull")}
            disabled={operationRunning}
            onClick={() =>
              runOperation(rowKey, t("Pulling current branch"), () =>
                store.gitPullWorkspace(workspace.workspace_id),
              )
            }
          >
            <GitMerge size={14} />
            {t("Pull")}
          </Button>
        ) : null}
        {workspace ? (
          <Button
            aria-label={t("Auto-sync origin's default branch into {name}", {
              name: title,
            })}
            aria-pressed={syncInfo?.enabled ?? false}
            title={
              syncInfo?.enabled
                ? t(
                    "Auto sync from origin's default branch is enabled. Click to disable.",
                  )
                : t(
                    "Auto sync from origin's default branch into this branch. Click to enable.",
                  )
            }
            disabled={!syncInfo || operationRunning}
            onClick={() =>
              runOperation(rowKey, t("Updating auto-sync policy"), () =>
                store.setWorkspaceAutoSyncEnabled(
                  workspace.workspace_id,
                  !(syncInfo?.enabled ?? false),
                ),
              )
            }
          >
            <RefreshCw size={13} />
            {t("Sync")}
          </Button>
        ) : null}
        {row.worktree.is_linked_worktree && !row.worktree.is_prunable ? (
          <Button
            className="lifecycle-remove-button"
            aria-label={t("Remove {name}", { name: title })}
            title={t("Remove worktree")}
            disabled={operationRunning}
            onClick={() => onRemove(row)}
          >
            {rowBusy ? <Spinner size="sm" /> : <Trash2 size={15} />}
            {t("Remove")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}
