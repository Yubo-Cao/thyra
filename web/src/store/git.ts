// Git actions on a workspace checkout: pull, per-file and repository actions.
import {
  gitFileActionLabel,
  gitFileActionSuccessMessage,
  gitRepoActionSuccessMessage,
  type GitFileAction,
  type GitRepoAction,
  type GitWorkingCounts,
} from "../gitActions";
import { t } from "../i18n";
import type { GitDiffEntry } from "../types";
import { action, noticeFor } from "./actions";
import { failWith, leaseIsCurrent } from "./core";
import { refreshNow } from "./refresh";

type GitFileEntry = Pick<
  GitDiffEntry,
  "path" | "old_path" | "mtime_ms" | "size"
>;

function gitFileActionParams(
  workspaceId: string,
  gitAction: GitFileAction,
  entry: GitFileEntry,
) {
  return {
    workspace_id: workspaceId,
    action: gitAction,
    path: entry.path,
    old_path: entry.old_path,
    mtime_ms: entry.mtime_ms,
    size: entry.size,
  };
}

export const gitActions = {
  gitPullWorkspace(workspaceId: string) {
    return action(
      async (lease) => {
        noticeFor(lease, {
          kind: "info",
          message: t("Running git pull"),
          detail: "git pull --ff-only",
          detailMode: "output",
          detailTitle: t("Command"),
          loading: true,
        });
        const result = await lease.client.call("git.pull", {
          workspace_id: workspaceId,
        });
        const output = [result?.stdout, result?.stderr]
          .filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          )
          .join("\n")
          .trim();
        noticeFor(lease, {
          kind: "success",
          message: t("Git pull completed"),
          detail: output ? output.slice(0, 1400) : t("Already up to date."),
          detailMode: output ? "output" : "text",
          detailTitle: output ? "git pull --ff-only" : undefined,
        });
        return result;
      },
      {
        refresh: "immediate",
        failureNotice: failWith(t("Git pull failed"), {
          detailMode: "output",
          detailTitle: "git pull --ff-only",
        }),
      },
    );
  },

  runGitFileAction(
    workspaceId: string,
    gitAction: GitFileAction,
    entry: GitFileEntry,
  ) {
    const label = gitFileActionLabel(gitAction);
    return action(
      async (lease) => {
        const result = await lease.client.call(
          "git.file_action",
          gitFileActionParams(workspaceId, gitAction, entry),
        );
        noticeFor(lease, {
          kind: "success",
          message: gitFileActionSuccessMessage(gitAction),
          detail: entry.path,
          autoDismissMs: 5000,
        });
        return result;
      },
      {
        refresh: "immediate",
        failureNotice: failWith(t("{action} failed", { action: label }), {
          detailMode: "text",
        }),
      },
    );
  },

  runGitFileActionBatch(
    workspaceId: string,
    gitAction: GitFileAction,
    entries: GitFileEntry[],
  ) {
    const label = gitFileActionLabel(gitAction);
    let completed = 0;
    return action(
      async (lease) => {
        try {
          for (const entry of entries) {
            await lease.client.call(
              "git.file_action",
              gitFileActionParams(workspaceId, gitAction, entry),
            );
            completed += 1;
          }
        } catch (error) {
          if (completed && leaseIsCurrent(lease)) void refreshNow(lease);
          throw error;
        }
        noticeFor(lease, {
          kind: "success",
          message:
            completed === 1
              ? t("{message} (1 file)", {
                  message: gitFileActionSuccessMessage(gitAction),
                })
              : t("{message} ({count} files)", {
                  message: gitFileActionSuccessMessage(gitAction),
                  count: completed,
                }),
          autoDismissMs: 5000,
        });
        return completed;
      },
      {
        refresh: "immediate",
        failureNotice: (error) => ({
          kind: "error",
          message: t("{action} failed", { action: label }),
          detail: t("{completed} of {total} files completed. {error}", {
            completed,
            total: entries.length,
            error: error.message,
          }),
          detailMode: "text",
        }),
      },
    );
  },

  runGitRepoAction(
    workspaceId: string,
    gitAction: GitRepoAction,
    expectedCounts?: Partial<GitWorkingCounts>,
  ) {
    return action(
      async (lease) => {
        const result = await lease.client.call("git.repo_action", {
          workspace_id: workspaceId,
          action: gitAction,
          expected_counts: expectedCounts,
        });
        noticeFor(lease, {
          kind: "success",
          message: gitRepoActionSuccessMessage(gitAction),
          autoDismissMs: 5000,
        });
        return result;
      },
      {
        refresh: "immediate",
        failureNotice: failWith(t("Git action failed"), {
          detailMode: "text",
        }),
      },
    );
  },
};
