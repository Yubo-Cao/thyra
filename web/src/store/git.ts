// Git actions on a workspace checkout: pull.
import { t } from "../i18n";
import { action, noticeFor } from "./actions";
import { failWith } from "./core";

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
};
