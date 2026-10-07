import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, GitBranch, RefreshCw } from "lucide-react";
import { t } from "../i18n";
import { luckyWorktreeBranchName } from "../luckyName";
import { useConnectionClient } from "../useConnectionClient";
import { store, useStoreSelector } from "../store";
import type { Workspace, WorktreeList } from "../types";
import { resolveWorktreeOpenSource, worktreeCreationSource } from "../worktree";
import {
  type InspectorView,
  WORKSPACE_INSPECTOR_REQUEST_EVENT,
  type WorkspaceInspectorRequest,
} from "../workspaceResource";
import {
  buildWorktreeLifecycleRows,
  lifecycleActionWarning,
  lifecycleGitChangeCount,
  lifecycleOpenedWorkspaceId,
  lifecycleWorktreeTitle,
  removeTemporaryWorkspaceSafely,
  type WorktreeLifecycleRow,
} from "../worktreeLifecycle";
import { Button } from "./ui/Button";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Dialog } from "./ui/Dialog";
import { IconButton } from "./ui/IconButton";
import { Spinner } from "./ui/Spinner";
import { TextField } from "./ui/TextField";
import { WorktreeOpenDialog } from "./WorktreeOpenDialog";
import { WorktreeLifecycleRow as WorktreeLifecycleRowItem } from "./WorktreeLifecycleRow";
import "./WorktreeLifecycleDialog.css";

type LifecycleOperation = {
  key: string;
  label: string;
  status: "running" | "succeeded" | "warning" | "failed";
  detail?: string;
};

function removalWorkspaceHint(
  result: unknown,
  row: WorktreeLifecycleRow,
  list: WorktreeList | null,
  workspaceId: string,
): Workspace {
  const openedValue =
    result && typeof result === "object" && "workspace" in result
      ? (result as { workspace?: unknown }).workspace
      : undefined;
  const opened =
    openedValue && typeof openedValue === "object"
      ? (openedValue as Partial<Workspace>)
      : undefined;
  const source = list?.source;
  const fallbackWorktree = source
    ? {
        repo_key: source.repo_key,
        repo_name: source.repo_name,
        repo_root: source.repo_root,
        checkout_path: row.worktree.path,
        is_linked_worktree: row.worktree.is_linked_worktree,
      }
    : undefined;
  return {
    workspace_id: workspaceId,
    number: typeof opened?.number === "number" ? opened.number : 0,
    label: opened?.label || row.worktree.label || workspaceId,
    focused: opened?.focused === true,
    pane_count: typeof opened?.pane_count === "number" ? opened.pane_count : 0,
    tab_count: typeof opened?.tab_count === "number" ? opened.tab_count : 0,
    agent_status: opened?.agent_status || "unknown",
    ...(opened?.cwd ? { cwd: opened.cwd } : {}),
    ...(opened?.active_tab_id ? { active_tab_id: opened.active_tab_id } : {}),
    ...(fallbackWorktree || opened?.worktree
      ? { worktree: { ...fallbackWorktree!, ...opened?.worktree } }
      : {}),
  };
}

/** Focus the branch field with its suggestion selected when the prompt opens. */
function focusAndSelect(input: HTMLInputElement | null) {
  input?.focus();
  input?.select();
}

export function WorktreeLifecycleDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId?: string | null;
  onClose: () => void;
}) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const connectionClient = useConnectionClient();
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.workspace_id === workspaceId,
  );
  const actionSourceWorkspace = selectedWorkspace
    ? worktreeCreationSource(workspaces, selectedWorkspace)
    : undefined;
  // Listing and repository settings accept linked workspaces. Creating or
  // opening a worktree does not, so keep those two contexts independent.
  const repositoryWorkspaceId = selectedWorkspace?.workspace_id ?? workspaceId;
  const actionSourceWorkspaceId = actionSourceWorkspace?.workspace_id;
  const [listResult, setListResult] = useState<{
    workspaceId: string;
    list: WorktreeList;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [operation, setOperation] = useState<LifecycleOperation | null>(null);
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);
  const [newWorktreeBranch, setNewWorktreeBranch] = useState("");
  const [openWorktreeOpen, setOpenWorktreeOpen] = useState(false);
  const [removeRow, setRemoveRow] = useState<WorktreeLifecycleRow | null>(null);
  const requestId = useRef(0);
  const inFlightLoad = useRef<{
    workspaceId: string;
    promise: Promise<void>;
  } | null>(null);
  const operationRunningRef = useRef(false);
  const operationIdRef = useRef(0);

  const load = useCallback(
    async (showLoading: boolean, force = false) => {
      if (!repositoryWorkspaceId) return;
      const existingLoad = inFlightLoad.current;
      if (!force && existingLoad?.workspaceId === repositoryWorkspaceId) {
        if (showLoading) setLoading(true);
        await existingLoad.promise;
        return;
      }
      const currentRequest = ++requestId.current;
      if (showLoading) setLoading(true);
      const promise = (async () => {
        try {
          const worktreeList = (await connectionClient.call("worktree.list", {
            workspace_id: repositoryWorkspaceId,
          })) as WorktreeList;
          if (!connectionClient.isCurrent()) return;
          setListResult({
            workspaceId: repositoryWorkspaceId,
            list: worktreeList,
          });
          setError("");
        } catch (loadError) {
          if (
            connectionClient.isCurrent() &&
            currentRequest === requestId.current
          ) {
            setError((loadError as Error).message);
          }
        } finally {
          if (
            connectionClient.isCurrent() &&
            currentRequest === requestId.current
          ) {
            setLoading(false);
          }
        }
      })();
      inFlightLoad.current = {
        workspaceId: repositoryWorkspaceId,
        promise,
      };
      try {
        await promise;
      } finally {
        if (inFlightLoad.current?.promise === promise) {
          inFlightLoad.current = null;
        }
      }
    },
    [connectionClient, repositoryWorkspaceId],
  );

  useEffect(() => {
    if (!open || !repositoryWorkspaceId) return;
    setListResult(null);
    setError("");
    setOperation(null);
    operationIdRef.current += 1;
    operationRunningRef.current = false;
    void load(true, true);
    const timer = window.setInterval(() => void load(false), 5_000);
    return () => {
      window.clearInterval(timer);
      requestId.current += 1;
      operationIdRef.current += 1;
      operationRunningRef.current = false;
      inFlightLoad.current = null;
    };
  }, [load, open, repositoryWorkspaceId]);

  const list =
    listResult && listResult.workspaceId === repositoryWorkspaceId
      ? listResult.list
      : null;
  const repositoryLoading =
    loading || (!!open && !!repositoryWorkspaceId && !list);

  const rows = useMemo(
    () => (list ? buildWorktreeLifecycleRows(list, workspaces) : []),
    [list, workspaces],
  );
  const openCount = rows.filter((row) => row.workspace).length;
  const changedCount = rows.filter(
    (row) => lifecycleGitChangeCount(row.gitStatus) > 0,
  ).length;
  const operationRunning = operation?.status === "running";

  const runOperation = async (
    key: string,
    label: string,
    action: () => Promise<unknown>,
  ) => {
    if (operationRunningRef.current || !connectionClient.isCurrent()) return;
    const operationId = ++operationIdRef.current;
    const operationIsCurrent = () =>
      connectionClient.isCurrent() && operationIdRef.current === operationId;
    operationRunningRef.current = true;
    setOperation({ key, label, status: "running" });
    try {
      const result = await action();
      if (!operationIsCurrent()) return;
      if (result === undefined) {
        await store.refresh();
        if (!operationIsCurrent()) return;
        await load(false, true);
        if (!operationIsCurrent()) return;
        setOperation({
          key,
          label,
          status: "failed",
          detail:
            store.get().error ?? t("{operation} failed", { operation: label }),
        });
        return;
      }
      await store.refresh();
      if (!operationIsCurrent()) return;
      await load(false, true);
      if (!operationIsCurrent()) return;
      const actionWarning = lifecycleActionWarning(result);
      setOperation({
        key,
        label,
        status: actionWarning ? "warning" : "succeeded",
        detail: actionWarning,
      });
    } catch (actionError) {
      if (!operationIsCurrent()) return;
      await store.refresh().catch(() => undefined);
      if (!operationIsCurrent()) return;
      await load(false, true).catch(() => undefined);
      if (!operationIsCurrent()) return;
      setOperation({
        key,
        label,
        status: "failed",
        detail: (actionError as Error).message,
      });
    } finally {
      if (operationIdRef.current === operationId) {
        operationRunningRef.current = false;
      }
    }
  };

  if (!open) return null;

  const createWorktree = (branch: string) => {
    const value = branch.trim();
    if (!value || !actionSourceWorkspaceId) return;
    setNewWorktreeOpen(false);
    void runOperation("create", t("Creating {branch}", { branch: value }), () =>
      store.createWorktree(actionSourceWorkspaceId, value),
    );
  };

  const openWorktree = (row: WorktreeLifecycleRow, focus = true) => {
    const openSource = resolveWorktreeOpenSource(
      list,
      actionSourceWorkspaceId ?? null,
    );
    if (openSource?.workspaceId) {
      return store.openWorktree(
        openSource.workspaceId,
        row.worktree.path,
        focus,
      );
    }
    if (!openSource?.cwd) {
      throw new Error(t("The repository root is unavailable."));
    }
    return store.openWorktreeFromCwd(openSource.cwd, row.worktree.path, focus);
  };

  const openWorktreeResource = async (
    row: WorktreeLifecycleRow,
    view: InspectorView,
  ) => {
    const result = await openWorktree(row, true);
    const targetWorkspaceId = lifecycleOpenedWorkspaceId(result);
    if (!targetWorkspaceId) {
      throw new Error(
        t("Herdr opened the checkout without returning a workspace ID."),
      );
    }
    window.dispatchEvent(
      new CustomEvent<WorkspaceInspectorRequest>(
        WORKSPACE_INSPECTOR_REQUEST_EVENT,
        {
          detail: {
            connectionId: connectionClient.connectionId,
            generation: connectionClient.generation,
            workspaceId: targetWorkspaceId,
            view,
          },
        },
      ),
    );
    window.setTimeout(onClose, 0);
    return result;
  };

  const removeWorktree = async (row: WorktreeLifecycleRow) => {
    let targetWorkspaceId = row.workspace?.workspace_id;
    let workspaceHint = row.workspace;
    let temporaryWorkspace = false;
    if (!targetWorkspaceId) {
      const opened = await openWorktree(row, false);
      targetWorkspaceId = lifecycleOpenedWorkspaceId(opened);
      if (!targetWorkspaceId) {
        throw new Error(
          t("Herdr opened the checkout without returning a workspace ID."),
        );
      }
      workspaceHint = removalWorkspaceHint(
        opened,
        row,
        list,
        targetWorkspaceId,
      );
      temporaryWorkspace = true;
    }

    return removeTemporaryWorkspaceSafely({
      workspaceId: targetWorkspaceId,
      temporary: temporaryWorkspace,
      remove: () =>
        store.removeWorktree(targetWorkspaceId, false, workspaceHint),
      close: async (workspaceId) => {
        if (!connectionClient.isCurrent()) {
          throw new Error(
            t(
              "Connection changed before the temporary workspace could be closed.",
            ),
          );
        }
        await store.closeWorkspace(workspaceId);
      },
    });
  };

  const repoName =
    list?.source.repo_name ??
    selectedWorkspace?.worktree?.repo_name ??
    t("Repository");
  const repoRoot =
    list?.source.repo_root ?? selectedWorkspace?.worktree?.repo_root ?? "";

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("Worktree Lifecycle")}
      description={
        <span className="lifecycle-source">
          <span>{repoName}</span>
          <code title={list?.source.repo_root}>{repoRoot}</code>
        </span>
      }
      headerActions={
        <IconButton
          label={t("Refresh lifecycle status")}
          tooltip={t("Refresh")}
          icon={
            <RefreshCw
              size={15}
              className={repositoryLoading ? "is-spinning" : undefined}
            />
          }
          disabled={repositoryLoading || operationRunning}
          onClick={() => void load(true, true)}
        />
      }
      size="lg"
      className="worktree-lifecycle-dialog"
      bodyClassName="worktree-lifecycle-body"
    >
      <div className="lifecycle-toolbar">
        <Button
          variant="secondary"
          title={
            actionSourceWorkspaceId
              ? t("Create a linked worktree")
              : t(
                  "Open this repository's main checkout before creating a worktree",
                )
          }
          disabled={!actionSourceWorkspaceId || operationRunning}
          onClick={() => {
            setNewWorktreeBranch(luckyWorktreeBranchName());
            setNewWorktreeOpen(true);
          }}
        >
          <GitBranch size={15} />
          {t("New worktree")}
        </Button>
        <Button
          title={t("Open an existing checkout")}
          disabled={!repositoryWorkspaceId || operationRunning}
          onClick={() => setOpenWorktreeOpen(true)}
        >
          <FolderOpen size={15} />
          {t("Open existing")}
        </Button>
      </div>

      {operation ? (
        <div
          className={`lifecycle-operation is-${operation.status}`}
          role={operation.status === "failed" ? "alert" : "status"}
        >
          {operation.status === "running" ? (
            <Spinner size="sm" tone="accent" />
          ) : (
            <span className="lifecycle-operation-mark" />
          )}
          <div>
            <strong>{operation.label}</strong>
            <span>
              {operation.detail ??
                (operation.status === "running"
                  ? t("Waiting for Herdr.")
                  : operation.status === "succeeded"
                    ? t("Repository state refreshed.")
                    : t("Operation failed."))}
            </span>
          </div>
        </div>
      ) : null}

      {repositoryLoading && !list ? (
        <div className="lifecycle-loading" role="status">
          <Spinner size="sm" />
          <span>{t("Loading repository lifecycle...")}</span>
        </div>
      ) : error && !list ? (
        <div className="lifecycle-empty is-error">
          <strong>{t("Repository lifecycle unavailable")}</strong>
          <span>{error}</span>
          <Button variant="secondary" onClick={() => void load(true, true)}>
            {t("Retry")}
          </Button>
        </div>
      ) : (
        <div>
          <div
            className="lifecycle-overview"
            aria-label={t("Repository summary")}
          >
            <div>
              <strong>{rows.length}</strong>
              <span>{t("Checkouts")}</span>
            </div>
            <div>
              <strong>{openCount}</strong>
              <span>{t("Open")}</span>
            </div>
            <div>
              <strong>{changedCount}</strong>
              <span>{t("With changes")}</span>
            </div>
          </div>

          {error ? <p className="lifecycle-error">{error}</p> : null}
          <div className="lifecycle-list" role="list">
            {rows.map((row) => {
              const rowKey = row.worktree.path;
              return (
                <WorktreeLifecycleRowItem
                  key={rowKey}
                  row={row}
                  operationRunning={operationRunning}
                  rowBusy={
                    operation?.status === "running" && operation.key === rowKey
                  }
                  runOperation={(key, label, action) => {
                    void runOperation(key, label, action);
                  }}
                  onFocus={(targetWorkspaceId) => {
                    void store.focusWorkspace(targetWorkspaceId);
                    onClose();
                  }}
                  onOpen={(targetRow) => openWorktree(targetRow)}
                  onOpenResource={openWorktreeResource}
                  onRemove={setRemoveRow}
                />
              );
            })}
          </div>
        </div>
      )}

      <Dialog
        open={newWorktreeOpen}
        onOpenChange={setNewWorktreeOpen}
        title={t("New Worktree")}
        size="sm"
        onSubmit={() => createWorktree(newWorktreeBranch)}
        footer={
          <>
            <Button size="md" onClick={() => setNewWorktreeOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button size="md" variant="primary" type="submit">
              {t("Create")}
            </Button>
          </>
        }
      >
        <TextField
          ref={focusAndSelect}
          label={t("Branch")}
          fullWidth
          value={newWorktreeBranch}
          onValueChange={setNewWorktreeBranch}
          placeholder={t("Branch name")}
        />
      </Dialog>
      <WorktreeOpenDialog
        open={openWorktreeOpen}
        workspaceId={repositoryWorkspaceId ?? null}
        sourceWorkspaceId={actionSourceWorkspaceId ?? null}
        sourceCwd={list?.source.repo_root ?? null}
        onClose={() => {
          setOpenWorktreeOpen(false);
          void store.refresh().then(() => load(false, true));
        }}
      />
      <ConfirmDialog
        open={!!removeRow}
        onOpenChange={(next) => {
          if (!next) setRemoveRow(null);
        }}
        title={t("Remove Worktree")}
        message={
          removeRow
            ? removeRow.workspace
              ? t('Remove worktree "{name}"?', {
                  name: lifecycleWorktreeTitle(removeRow.worktree),
                })
              : t(
                  'Remove closed worktree "{name}"? It will be opened in the background so Herdr can remove it.',
                  { name: lifecycleWorktreeTitle(removeRow.worktree) },
                )
            : t("Remove this worktree?")
        }
        confirmLabel={t("Remove")}
        tone="danger"
        onConfirm={() => {
          const row = removeRow;
          setRemoveRow(null);
          if (!row) return;
          void runOperation(row.worktree.path, t("Removing worktree"), () =>
            removeWorktree(row),
          );
        }}
      />
    </Dialog>
  );
}
