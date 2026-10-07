// Worktree lifecycle actions and the notices that report removal cleanup.
import { t } from "../i18n";
import type { Workspace } from "../types";
import { action, noticeFor } from "./actions";
import {
  failWith,
  type Notice,
  setForConnection,
  state,
  type StoreConnectionLease,
} from "./core";
import { adoptBrowserTarget, browserSelectionIsCurrent } from "./navigation";
import { refreshNow } from "./refresh";

type WorktreeRemovalCleanup = {
  terminated_processes?: number;
  recovered_stale_checkout?: boolean;
  preserved_path?: string;
  warning?: string;
};

export const WORKTREE_REMOVED_EVENT = "thyra:worktree-removed";

export interface WorktreeRemovedTarget {
  connectionId: string;
  generation: number;
  workspace: Workspace;
}

export function worktreeRemovalCompletionNotice(
  cleanup: WorktreeRemovalCleanup | undefined,
): Notice {
  if (!cleanup?.recovered_stale_checkout && !cleanup?.warning) {
    return { kind: "success", message: t("Worktree removed") };
  }

  const stopped = Number(cleanup.terminated_processes ?? 0);
  const recoveryDetails = [
    stopped > 0
      ? stopped === 1
        ? t("Stopped 1 process still using the checkout.")
        : t("Stopped {count} processes still using the checkout.", {
            count: stopped,
          })
      : "",
    cleanup.preserved_path
      ? t("Stale files were preserved at {path}.", {
          path: cleanup.preserved_path,
        })
      : cleanup.recovered_stale_checkout
        ? t(
            "The checkout was already absent; stale Herdr state was reconciled.",
          )
        : "",
    cleanup.warning ?? "",
  ].filter(Boolean);

  return {
    kind: cleanup.warning ? "error" : "success",
    message: cleanup.warning
      ? t("Worktree removed with cleanup warning")
      : t("Worktree removed"),
    detail: recoveryDetails.join("\n"),
  };
}

/**
 * Open a worktree by path or branch from a workspace, or from a repository
 * root: a linked checkout can remain open after its main workspace is closed,
 * and Herdr accepts the root as the source so the GUI can reopen main without
 * inventing or guessing a workspace ID.
 */
function openWorktree(
  source: { workspace_id: string } | { cwd: string },
  target: string,
  focus: boolean,
) {
  const navigation = state.browserNavigation;
  const trimmed = target.trim();
  const locator = trimmed.startsWith("/")
    ? { path: trimmed }
    : { branch: trimmed };
  return action(async (lease) => {
    const result = await lease.client.call("worktree.open", {
      ...source,
      ...locator,
      focus: focus && state.navigationMode !== "browser-local",
    });
    if (focus && browserSelectionIsCurrent(navigation))
      adoptBrowserTarget(lease, result);
    return result;
  });
}

function announceWorktreeRemoved(
  lease: StoreConnectionLease,
  workspace: Workspace | undefined,
) {
  if (!workspace || typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WorktreeRemovedTarget>(WORKTREE_REMOVED_EVENT, {
      detail: {
        connectionId: lease.connectionId,
        generation: lease.generation,
        workspace,
      },
    }),
  );
}

export const worktreeActions = {
  createWorktree(workspaceId: string, branch: string) {
    const navigation = state.browserNavigation;
    return action(
      async (lease) => {
        noticeFor(lease, {
          kind: "info",
          message: t("Creating worktree"),
          detail: t(
            "Updating origin's default branch before creating {branch}.",
            { branch },
          ),
          detailMode: "output",
          detailTitle: t("Fetch origin's default branch"),
          loading: true,
        });
        const result = await lease.client.call("worktree.create", {
          workspace_id: workspaceId,
          branch,
          focus: state.navigationMode !== "browser-local",
        });
        if (browserSelectionIsCurrent(navigation))
          adoptBrowserTarget(lease, result);
        const commit = String(result?.base_sync?.commit ?? "").slice(0, 12);
        const base = String(
          result?.base_sync?.base ?? t("origin's default branch"),
        );
        noticeFor(lease, {
          kind: "success",
          message: t("Worktree created"),
          detail: commit
            ? t("{branch} starts from {base} at {commit}.", {
                branch,
                base,
                commit,
              })
            : t("{branch} starts from the latest {base}.", { branch, base }),
          autoDismissMs: 5000,
        });
        return result;
      },
      { failureNotice: failWith(t("Failed to create worktree")) },
    );
  },

  openWorktree(workspaceId: string, target: string, focus = true) {
    return openWorktree({ workspace_id: workspaceId }, target, focus);
  },

  openWorktreeFromCwd(cwd: string, target: string, focus = true) {
    return openWorktree({ cwd }, target, focus);
  },

  removeWorktree(
    workspaceId: string,
    force = false,
    workspaceHint?: Workspace,
  ) {
    return action(
      async (lease) => {
        const removedWorkspace =
          state.workspaces.find(
            (workspace) => workspace.workspace_id === workspaceId,
          ) ?? workspaceHint;
        noticeFor(lease, {
          kind: "info",
          message: t("Removing worktree"),
          loading: true,
        });
        const result = await lease.client.call(
          "worktree.remove",
          {
            workspace_id: workspaceId,
            force,
          },
          // Deleting large checkouts can legitimately take minutes. Let
          // disconnects end the browser wait instead of reporting a timeout
          // while deletion continues.
          { timeoutMs: null },
        );
        await refreshNow(lease);
        setForConnection(lease, {
          terminalAttachEpoch: state.terminalAttachEpoch + 1,
        });
        announceWorktreeRemoved(lease, removedWorkspace);
        noticeFor(lease, worktreeRemovalCompletionNotice(result?.cleanup));
        return result;
      },
      { failureNotice: failWith(t("Failed to remove worktree")) },
    );
  },
};
