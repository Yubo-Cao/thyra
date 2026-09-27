// Worktree lifecycle and per-repository automation settings, including the
// notices that report worktree hook output and removal cleanup.
import { t } from "../i18n";
import type { Workspace } from "../types";
import { action, noticeFor } from "./actions";
import {
  DEFAULT_NOTICE_AUTO_DISMISS_MS,
  failWith,
  type Notice,
  setForConnection,
  state,
  type StoreConnectionLease,
} from "./core";
import { adoptBrowserTarget, browserSelectionIsCurrent } from "./navigation";
import { refreshNow } from "./refresh";

type WorktreeHookEvent =
  | "worktree.created"
  | "worktree.opened"
  | "worktree.before_remove"
  | "worktree.removed";

type WorktreeHookRunResult = {
  event: WorktreeHookEvent;
  status: "skipped" | "succeeded" | "failed";
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

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

function hookEventLabel(event: WorktreeHookEvent): string {
  switch (event) {
    case "worktree.before_remove":
      return t("Worktree teardown hook");
    case "worktree.opened":
      return t("Worktree opened hook");
    case "worktree.removed":
      return t("Worktree removed hook");
    case "worktree.created":
      return t("Worktree setup hook");
  }
}

function hookOutput(
  result: Pick<WorktreeHookRunResult, "stdout" | "stderr" | "error">,
) {
  return [result.stderr, result.stdout, result.error]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .join("\n")
    .trim();
}

export function summarizeDirectHookResult(
  result: WorktreeHookRunResult | undefined,
): Notice | null {
  if (!result || result.status === "skipped") return null;
  const output = hookOutput(result);
  return {
    kind: result.status === "succeeded" ? "success" : "error",
    message:
      result.status === "succeeded"
        ? t("{hook} completed", { hook: hookEventLabel(result.event) })
        : typeof result.exit_code === "number"
          ? t("{hook} failed (exit {code})", {
              hook: hookEventLabel(result.event),
              code: result.exit_code,
            })
          : t("{hook} failed", { hook: hookEventLabel(result.event) }),
    detail: output ? output.slice(0, 1400) : undefined,
    detailMode: output ? "output" : undefined,
    detailTitle: output
      ? t("{hook} output", { hook: hookEventLabel(result.event) })
      : undefined,
    ...(result.status === "succeeded"
      ? { autoDismissMs: DEFAULT_NOTICE_AUTO_DISMISS_MS }
      : {}),
  };
}

export function worktreeRemovalCompletionNotice(
  cleanup: WorktreeRemovalCleanup | undefined,
  removedHookNotice: Notice | null,
): Notice | null {
  if (!cleanup?.recovered_stale_checkout && !cleanup?.warning) {
    return removedHookNotice;
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

  if (removedHookNotice) {
    const cleanupWarning = Boolean(cleanup.warning);
    return {
      ...removedHookNotice,
      kind: cleanupWarning ? "error" : removedHookNotice.kind,
      message:
        cleanupWarning && removedHookNotice.kind !== "error"
          ? t("Worktree removed with cleanup warning")
          : removedHookNotice.message,
      detail: [
        cleanupWarning && removedHookNotice.kind !== "error"
          ? removedHookNotice.message
          : "",
        removedHookNotice.detail,
        ...recoveryDetails,
      ]
        .filter(Boolean)
        .join("\n"),
      detailTitle:
        removedHookNotice.detail || cleanupWarning
          ? t("Worktree removal details")
          : undefined,
    };
  }

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
    const openedNotice = summarizeDirectHookResult(result?.opened_hook);
    if (openedNotice) noticeFor(lease, openedNotice);
    return result;
  });
}

function autoSyncUpdatedNotice(enabled: boolean, detail?: string): Notice {
  return {
    kind: "success",
    message: enabled
      ? t("Automatic branch updates enabled")
      : t("Automatic branch updates disabled"),
    detail,
    autoDismissMs: 5000,
  };
}

const autoSyncFailure = () =>
  failWith(t("Failed to update automatic sync settings"));

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
        const setupNotice = summarizeDirectHookResult(result?.setup_hook);
        if (setupNotice) {
          noticeFor(lease, setupNotice);
        } else {
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
        }
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
          detail: t("Running teardown hook if configured."),
          loading: true,
        });
        const result = await lease.client.call(
          "worktree.remove",
          {
            workspace_id: workspaceId,
            force,
          },
          // Hooks are part of this RPC and can legitimately run longer than
          // Herdr's own bounded remove call. Let disconnects end the browser
          // wait instead of reporting a timeout while deletion continues.
          null,
        );
        const beforeRemoveNotice = summarizeDirectHookResult(
          result?.before_remove_hook,
        );
        if (beforeRemoveNotice) noticeFor(lease, beforeRemoveNotice);
        if (result?.skipped_remove) {
          if (!beforeRemoveNotice) noticeFor(lease, null);
          return result;
        }

        await refreshNow(lease);
        setForConnection(lease, {
          terminalAttachEpoch: state.terminalAttachEpoch + 1,
        });
        announceWorktreeRemoved(lease, removedWorkspace);
        const completionNotice = worktreeRemovalCompletionNotice(
          result?.cleanup,
          summarizeDirectHookResult(result?.removed_hook),
        );
        if (completionNotice) {
          noticeFor(lease, completionNotice);
        } else if (!beforeRemoveNotice) {
          noticeFor(lease, { kind: "success", message: t("Worktree removed") });
        }
        return result;
      },
      { failureNotice: failWith(t("Failed to remove worktree")) },
    );
  },

  setRepoWorktreeHooksEnabled(key: string, enabled: boolean) {
    return action(async (lease) => {
      const result = await lease.client.call("settings.update_repo", {
        key,
        settings: { worktree_hooks_enabled: enabled },
      });
      await refreshNow(lease);
      return result;
    });
  },

  setWorkspaceAutoSyncEnabled(workspaceId: string, enabled: boolean) {
    return action(
      async (lease) => {
        const result = await lease.client.call(
          "settings.workspace_auto_sync.update",
          { workspace_id: workspaceId, enabled },
        );
        noticeFor(
          lease,
          autoSyncUpdatedNotice(
            enabled,
            enabled
              ? t(
                  "A sync will run now, then every 10 minutes while this workspace remains open.",
                )
              : undefined,
          ),
        );
        return result;
      },
      { refresh: "none", failureNotice: autoSyncFailure() },
    );
  },

  setWorkspaceAutoSyncConfigEnabled(key: string, enabled: boolean) {
    return action(
      async (lease) => {
        const result = await lease.client.call(
          "settings.workspace_auto_sync.update_key",
          { key, enabled },
        );
        noticeFor(lease, autoSyncUpdatedNotice(enabled, key));
        return result;
      },
      { refresh: "none", failureNotice: autoSyncFailure() },
    );
  },
};
