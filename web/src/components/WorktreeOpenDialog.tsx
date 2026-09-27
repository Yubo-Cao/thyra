import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { store } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import type { ExistingWorktree, WorktreeList } from "../types";
import { resolveWorktreeOpenSource } from "../worktree";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { TextField } from "./ui/TextField";
import { Token } from "./ui/Token";
import "./WorktreeOpenDialog.css";

function worktreeTitle(worktree: ExistingWorktree) {
  if (worktree.branch) return worktree.branch;
  if (worktree.is_detached) return t("Detached HEAD");
  if (worktree.is_bare) return t("Bare repository");
  return worktree.label || worktree.path;
}

function sortWorktrees(a: ExistingWorktree, b: ExistingWorktree) {
  if (a.is_linked_worktree !== b.is_linked_worktree) {
    return a.is_linked_worktree ? 1 : -1;
  }
  return worktreeTitle(a).localeCompare(worktreeTitle(b));
}

type WorktreeListState = {
  workspaceId: string;
  loading: boolean;
  list: WorktreeList | null;
  error: string;
};

export function WorktreeOpenDialog({
  open,
  workspaceId,
  sourceWorkspaceId,
  sourceCwd,
  onClose,
}: {
  open: boolean;
  workspaceId: string | null;
  sourceWorkspaceId?: string | null;
  sourceCwd?: string | null;
  onClose: () => void;
}) {
  const connectionClient = useConnectionClient();
  const [manualTarget, setManualTarget] = useState("");
  const [query, setQuery] = useState("");
  const manualTargetRef = useRef<HTMLInputElement>(null);
  const [listState, setListState] = useState<WorktreeListState | null>(null);
  const [actionError, setActionError] = useState<{
    workspaceId: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    setManualTarget("");
    setQuery("");
    setActionError(null);
    setListState({ workspaceId, loading: true, list: null, error: "" });

    connectionClient.call("worktree.list", { workspace_id: workspaceId }).then(
      (result) => {
        if (cancelled || !connectionClient.isCurrent()) return;
        setListState({
          workspaceId,
          loading: false,
          list: result as WorktreeList,
          error: "",
        });
      },
      (err) => {
        if (cancelled || !connectionClient.isCurrent()) return;
        setListState({
          workspaceId,
          loading: false,
          list: null,
          error: (err as Error).message,
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [connectionClient, open, workspaceId]);

  const currentListState =
    listState?.workspaceId === workspaceId ? listState : null;
  const list = currentListState?.list ?? null;
  const loading =
    !!open &&
    !!workspaceId &&
    !currentListState?.list &&
    (currentListState?.loading ?? true);
  const error =
    (actionError?.workspaceId === workspaceId ? actionError.message : "") ||
    currentListState?.error ||
    "";

  // Search takes focus when worktrees load; otherwise the manual field does.
  const focusManual = !loading && !list?.worktrees.length;
  useEffect(() => {
    if (open && focusManual) manualTargetRef.current?.focus();
  }, [open, focusManual]);

  if (!workspaceId) return null;

  const actionSource = resolveWorktreeOpenSource(
    list,
    sourceWorkspaceId,
    sourceCwd,
  );
  const openTarget = (target: string) => {
    if (!connectionClient.isCurrent()) return undefined;
    if (actionSource?.workspaceId) {
      return store.openWorktree(actionSource.workspaceId, target);
    }
    if (actionSource?.cwd) {
      return store.openWorktreeFromCwd(actionSource.cwd, target);
    }
    setActionError({
      workspaceId,
      message: t("The repository source is unavailable."),
    });
    return undefined;
  };

  const normalizedQuery = query.trim().toLowerCase();
  const worktrees = [...(list?.worktrees ?? [])]
    .filter((worktree) => {
      if (!normalizedQuery) return true;
      return [
        worktree.branch,
        worktree.label,
        worktree.path,
        worktree.is_linked_worktree ? "worktree" : "main",
        worktree.is_linked_worktree ? t("worktree") : t("main"),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery));
    })
    .sort(sortWorktrees);
  const openManual = () => {
    const value = manualTarget.trim();
    if (!value) return;
    if (openTarget(value)) onClose();
  };

  const openWorktree = (worktree: ExistingWorktree) => {
    if (worktree.open_workspace_id) {
      store.focusWorkspace(worktree.open_workspace_id);
      onClose();
    } else {
      if (openTarget(worktree.path)) onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("Open Worktree")}
      description={
        list ? (
          <span className="worktree-open-source">
            <span>{list.source.repo_name}</span>
            <code>{list.source.repo_root}</code>
          </span>
        ) : undefined
      }
      size="lg"
      onSubmit={openManual}
      bodyClassName="ui-dialog-stack"
      footer={
        <>
          <Button size="md" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            size="md"
            variant="primary"
            type="submit"
            disabled={!manualTarget.trim() || !actionSource}
          >
            {t("Open")}
          </Button>
        </>
      }
    >
      {loading ? <p>{t("Loading worktrees...")}</p> : null}
      {error ? <p className="worktree-open-error">{error}</p> : null}

      {list?.worktrees.length ? (
        <TextField
          autoFocus
          label={t("Search")}
          fullWidth
          value={query}
          onValueChange={setQuery}
          placeholder={t("Branch name or checkout path")}
        />
      ) : null}

      {worktrees.length ? (
        <div className="worktree-list" role="list">
          {worktrees.map((worktree) => (
            <Button
              key={worktree.path}
              variant="secondary"
              fullWidth
              className="worktree-option"
              onClick={() => openWorktree(worktree)}
            >
              <span className="worktree-option-main">
                <span className="worktree-option-title">
                  {worktreeTitle(worktree)}
                </span>
                <span className="worktree-option-path">{worktree.path}</span>
              </span>
              <span className="worktree-option-tags">
                <Token>
                  {worktree.is_linked_worktree ? t("worktree") : t("main")}
                </Token>
                {worktree.is_prunable ? (
                  <Token tone="warning">{t("prunable")}</Token>
                ) : null}
                <Token tone="accent">
                  {worktree.open_workspace_id ? t("Focus") : t("Open")}
                </Token>
              </span>
            </Button>
          ))}
        </div>
      ) : !loading && !error ? (
        <p>
          {list?.worktrees.length
            ? t("No matching worktrees.")
            : t("No worktrees found.")}
        </p>
      ) : null}

      <TextField
        ref={manualTargetRef}
        autoFocus={focusManual}
        label={t("Branch or absolute path")}
        fullWidth
        value={manualTarget}
        onValueChange={setManualTarget}
        placeholder={t("feature/my-branch or /repo/worktree")}
        disabled={!actionSource}
      />
    </Dialog>
  );
}
