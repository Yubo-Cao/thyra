import { t } from "./i18n";
import type {
  ExistingWorktree,
  GitStatusSummary,
  Workspace,
  WorktreeList,
} from "./types";

export interface WorktreeLifecycleRow {
  worktree: ExistingWorktree;
  workspace?: Workspace;
  gitStatus?: GitStatusSummary;
}

function normalizedCheckoutPath(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/, "");
}

export function lifecycleWorktreeTitle(worktree: ExistingWorktree): string {
  if (worktree.branch) return worktree.branch;
  if (worktree.is_detached) return t("Detached HEAD");
  if (worktree.is_bare) return t("Bare repository");
  return worktree.label || worktree.path;
}

export function lifecycleGitSummary(status?: GitStatusSummary): string {
  if (!status)
    return t("Open this checkout to load Git status and use Git pull.");
  if (status.error)
    return t("Git status unavailable: {error}", { error: status.error });
  const changed = lifecycleGitChangeCount(status);
  const parts = [
    changed ? t("{count} changed", { count: changed }) : t("No local changes"),
    status.ahead ? t("{count} ahead", { count: status.ahead }) : null,
    status.behind ? t("{count} behind", { count: status.behind }) : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function lifecycleOpenedWorkspaceId(
  result: unknown,
): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const workspace = (result as { workspace?: unknown }).workspace;
  if (!workspace || typeof workspace !== "object") return undefined;
  const workspaceId = (workspace as { workspace_id?: unknown }).workspace_id;
  return typeof workspaceId === "string" && workspaceId
    ? workspaceId
    : undefined;
}

export async function removeTemporaryWorkspaceSafely<T>({
  workspaceId,
  temporary,
  remove,
  close,
}: {
  workspaceId: string;
  temporary: boolean;
  remove: () => Promise<T>;
  close: (workspaceId: string) => Promise<unknown>;
}): Promise<T> {
  let result: T;
  try {
    result = await remove();
  } catch (error) {
    if (temporary) {
      try {
        await close(workspaceId);
      } catch (cleanupError) {
        const message = error instanceof Error ? error.message : String(error);
        const cleanupMessage =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        throw new Error(
          t("{message}\nTemporary workspace cleanup failed: {cleanup}", {
            message,
            cleanup: cleanupMessage,
          }),
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }

  if (result === undefined) {
    if (temporary) await close(workspaceId);
    throw new Error(t("Worktree removal did not complete."));
  }
  return result;
}

export function lifecycleActionWarning(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  return (result as { cleanup?: { warning?: string } }).cleanup?.warning;
}

function workspaceForCheckout(
  workspaces: Workspace[],
  repoKey: string,
  path: string,
): Workspace | undefined {
  const normalizedPath = normalizedCheckoutPath(path);
  return workspaces
    .filter(
      (workspace) =>
        workspace.worktree?.repo_key === repoKey &&
        normalizedCheckoutPath(workspace.worktree.checkout_path) ===
          normalizedPath,
    )
    .sort(
      (a, b) => Number(b.focused) - Number(a.focused) || a.number - b.number,
    )[0];
}

/**
 * Joins Herdr's repository worktree inventory with currently open workspaces.
 * The inventory owns checkout existence; workspace data contributes live GUI
 * identity and git status. Open workspaces missing from a stale inventory are
 * retained so actions never disappear during a refresh race.
 */
export function buildWorktreeLifecycleRows(
  list: WorktreeList,
  workspaces: Workspace[],
): WorktreeLifecycleRow[] {
  const rowsByPath = new Map<string, WorktreeLifecycleRow>();

  for (const worktree of list.worktrees) {
    const path = normalizedCheckoutPath(worktree.path);
    const workspace = workspaceForCheckout(
      workspaces,
      list.source.repo_key,
      path,
    );
    rowsByPath.set(path, {
      worktree: {
        ...worktree,
        path,
        open_workspace_id:
          workspace?.workspace_id ?? worktree.open_workspace_id,
      },
      workspace,
      gitStatus: workspace?.worktree?.git_status,
    });
  }

  for (const workspace of workspaces) {
    const info = workspace.worktree;
    if (!info || info.repo_key !== list.source.repo_key) continue;
    const path = normalizedCheckoutPath(info.checkout_path);
    if (rowsByPath.has(path)) continue;
    rowsByPath.set(path, {
      worktree: {
        path,
        branch: info.git_status?.branch,
        is_bare: false,
        is_detached: !info.git_status?.branch,
        is_prunable: false,
        is_linked_worktree: info.is_linked_worktree,
        open_workspace_id: workspace.workspace_id,
        label: workspace.label || path.split("/").filter(Boolean).pop() || path,
      },
      workspace,
      gitStatus: info.git_status,
    });
  }

  return [...rowsByPath.values()].sort((a, b) => {
    if (a.worktree.is_linked_worktree !== b.worktree.is_linked_worktree) {
      return a.worktree.is_linked_worktree ? 1 : -1;
    }
    return (
      lifecycleWorktreeTitle(a.worktree).localeCompare(
        lifecycleWorktreeTitle(b.worktree),
      ) || a.worktree.path.localeCompare(b.worktree.path)
    );
  });
}

export function lifecycleGitChangeCount(status?: GitStatusSummary): number {
  if (!status) return 0;
  return status.staged + status.unstaged + status.untracked + status.conflicted;
}
