import { isCancelledError } from "@tanstack/react-query";
import { FileDiff, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConnectionClient } from "../api";
import { thyraLocalStorage } from "../browserStorage";
import {
  GIT_DIFF_CODE_TONES,
  gitDiffCode,
  gitDiffCodeLabel,
} from "../gitDiffStatus";
import { t } from "../i18n";
import {
  type GitDiffSummaryMode,
  invalidateGitDiffFiles,
  refreshGitDiffSummary,
  useGitDiffSummaryState,
} from "../inspectorQueries";
import type { GitDiffEntry } from "../types";
import { IconButton } from "./ui/IconButton";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Token } from "./ui/Token";
import "./ChangesList.css";

/** The file shown by Changes: every summary entry of one path in one scope. */
export type ChangesSelection = {
  mode: GitDiffSummaryMode;
  entries: GitDiffEntry[];
};

const MODE_KEY = "diffViewerScope";

/** Summary entries by path, so a file both staged and unstaged is one row. */
export function groupEntriesByPath(entries: GitDiffEntry[]) {
  const groups = new Map<string, GitDiffEntry[]>();
  for (const entry of entries) {
    groups.set(entry.path, [...(groups.get(entry.path) ?? []), entry]);
  }
  return [...groups.values()];
}

export function GitStatusTokens({ entries }: { entries: GitDiffEntry[] }) {
  return [...new Set(entries.map(gitDiffCode))].map((code) => (
    <Token
      key={code}
      tone={GIT_DIFF_CODE_TONES[code]}
      code
      role="img"
      aria-label={gitDiffCodeLabel(code)}
      title={gitDiffCodeLabel(code)}
    >
      {code}
    </Token>
  ));
}

/** The Changes list: scope, refresh, and one row per changed file. */
export function ChangesList({
  client,
  workspaceId,
  resourceKey,
  selection,
  onSelectionChange,
}: {
  client: ConnectionClient;
  workspaceId: string;
  resourceKey: string;
  selection: ChangesSelection;
  onSelectionChange: (
    selection: ChangesSelection,
    meta?: { userInitiated?: boolean },
  ) => void;
}) {
  const [mode, setMode] = useState<GitDiffSummaryMode>(() =>
    thyraLocalStorage.getItem(MODE_KEY) === "branch-main"
      ? "branch-main"
      : "working",
  );
  const [error, setError] = useState<string | null>(null);
  const { summary, loading } = useGitDiffSummaryState(
    client,
    workspaceId,
    mode,
    resourceKey,
  );
  const groups = useMemo(
    () => groupEntriesByPath(summary?.entries ?? []),
    [summary],
  );
  const selectedPath =
    selection.mode === mode ? selection.entries[0]?.path : undefined;

  const load = useCallback(
    (restart: boolean) => {
      setError(null);
      if (restart) invalidateGitDiffFiles(client, workspaceId);
      refreshGitDiffSummary(client, workspaceId, mode, resourceKey, {
        afterCurrent: restart,
      }).catch((cause: Error) => {
        // A cancelled request was retired for a newer one.
        if (client.isCurrent() && !isCancelledError(cause)) {
          setError(cause.message);
        }
      });
    },
    [client, mode, resourceKey, workspaceId],
  );

  useEffect(() => {
    thyraLocalStorage.setItem(MODE_KEY, mode);
    load(false);
  }, [load, mode]);

  // Keep the shown file when it is still changed, else show the first one.
  useEffect(() => {
    const kept = groups.find((group) => group[0]?.path === selectedPath);
    onSelectionChange({ mode, entries: kept ?? groups[0] ?? [] });
    // Only a new summary (or scope) changes what is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, mode]);

  return (
    <aside className="changes-list" aria-label={t("Diff Viewer")}>
      <div className="ui-bar changes-list-bar">
        <SegmentedControl
          className="changes-list-scope"
          stretch
          aria-label={t("Diff scope")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "working", label: t("Working tree") },
            { value: "branch-main", label: t("Against main") },
          ]}
        />
        <IconButton
          label={loading ? t("Refreshing changes") : t("Refresh changes")}
          aria-busy={loading}
          disabled={loading}
          onClick={() => load(true)}
          icon={
            <RefreshCw className={loading ? "is-spinning" : ""} size={15} />
          }
        />
      </div>
      {error ? <p className="modal-error">{error}</p> : null}
      <div className="changes-list-rows" aria-label={t("Changed files")}>
        {groups.map((group) => {
          const path = group[0]!.path;
          const slash = path.lastIndexOf("/");
          const additions = group.reduce(
            (sum, e) => sum + (e.additions ?? 0),
            0,
          );
          const deletions = group.reduce(
            (sum, e) => sum + (e.deletions ?? 0),
            0,
          );
          return (
            <button
              type="button"
              key={path}
              className="changes-row"
              aria-current={path === selectedPath ? "true" : undefined}
              title={path}
              onClick={() =>
                onSelectionChange(
                  { mode, entries: group },
                  { userInitiated: true },
                )
              }
            >
              <GitStatusTokens entries={group} />
              <span className="changes-row-name">{path.slice(slash + 1)}</span>
              <span className="changes-row-dir">
                {path.slice(0, slash + 1)}
              </span>
              {additions || deletions ? (
                <span
                  className="changes-row-stats"
                  aria-label={t("Line changes")}
                >
                  <span className="changes-row-add">+{additions}</span>
                  <span className="changes-row-del">-{deletions}</span>
                </span>
              ) : null}
            </button>
          );
        })}
        {groups.length ? null : (
          <div className="diff-content-state">
            {summary || !loading ? (
              <FileDiff size={16} aria-hidden="true" />
            ) : (
              <span className="file-loading-spinner" />
            )}
            {summary || !loading ? t("No changes") : t("Loading diff")}
          </div>
        )}
      </div>
    </aside>
  );
}
