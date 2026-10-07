import { type Query, QueryClient, useQuery } from "@tanstack/react-query";
import { bridge, type ConnectionClient } from "./api";
import { t } from "./i18n";
import { appStore } from "./store/core";
import type { GitDiffEntry, GitDiffFile, GitDiffSummary } from "./types";

// RPC result caches of the lazily loaded inspector: diff summaries, file
// previews and per-file patches. Only lazy chunks import this
// module, so TanStack Query never loads with the app shell. Every key starts
// with [connectionId, client generation, kind], so a connection switch or a
// generation bump drops every other scope (and aborts its requests).
type Scope = Pick<ConnectionClient, "connectionId" | "generation">;

export const inspectorQueries = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: Number.POSITIVE_INFINITY,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
      networkMode: "always",
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});
const queryCache = inspectorQueries.getQueryCache();

export function scopedKey(client: Scope, kind: string, ...parts: unknown[]) {
  return [client.connectionId, client.generation, kind, ...parts];
}

// Retention budgets per kind. Query has no size-based eviction, so each load
// evicts the oldest idle, unobserved results of its kind beyond the budget.
const budgets = new Map<
  unknown,
  { max: number; size: (data: any) => number }
>();
const loadOrder = new WeakMap<Query, number>();
let loads = 0;

export function retainQueries<T>(
  kind: string,
  max: number,
  size: (data: T) => number = () => 1,
) {
  budgets.set(kind, { max, size });
}

queryCache.subscribe((event) => {
  if (event.type !== "updated" || event.action.type !== "success") return;
  const kind = event.query.queryKey[2];
  const budget = budgets.get(kind);
  if (!budget) return;
  loadOrder.set(event.query, ++loads);
  let total = 0;
  const newestFirst = queryCache
    .findAll({ predicate: (query) => query.queryKey[2] === kind })
    .filter((query) => query.state.data !== undefined)
    .sort((a, b) => (loadOrder.get(b) ?? 0) - (loadOrder.get(a) ?? 0));
  for (const query of newestFirst) {
    total += budget.size(query.state.data);
    if (
      total > budget.max &&
      query !== event.query &&
      !query.getObserversCount() &&
      query.state.fetchStatus === "idle"
    ) {
      queryCache.remove(query);
    }
  }
});

let scope: unknown[] = [];
appStore.subscribe((state) => {
  const next = [state.activeConnectionId, bridge.clientGeneration];
  if (next[0] === scope[0] && next[1] === scope[1]) return;
  scope = next;
  inspectorQueries.removeQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] !== next[0] || queryKey[1] !== next[1],
  });
});

/** Runs a query's function even when it holds data; `restart` aborts a running one. */
export function fetchFresh<T>(
  options: {
    queryKey: unknown[];
    queryFn: (context: { signal: AbortSignal }) => Promise<T>;
  },
  restart = false,
): Promise<T> {
  const defaulted = inspectorQueries.defaultQueryOptions(options);
  const query = queryCache.build(inspectorQueries, defaulted);
  if (restart) void query.cancel({ silent: true });
  return query.fetch(defaulted) as Promise<T>;
}

// --- Git diff summaries ---

export type GitDiffSummaryMode = "working" | "branch-main";

retainQueries("git-diff-summary", 24);

function gitDiffSummaryQuery(
  client: ConnectionClient,
  workspaceId: string,
  mode: GitDiffSummaryMode,
  resourceKey = workspaceId,
) {
  return {
    queryKey: scopedKey(
      client,
      "git-diff-summary",
      resourceKey,
      workspaceId,
      mode,
    ),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const summary = (await client.call(
        "git.diff_summary",
        { workspace_id: workspaceId, mode },
        { signal },
      )) as GitDiffSummary;
      if (!client.isCurrent()) {
        throw new Error(t("connection changed during diff summary request"));
      }
      return summary;
    },
  };
}

/** The shared summary of a workspace, loaded by `refreshGitDiffSummary`. */
export function useGitDiffSummaryState(
  client: ConnectionClient,
  workspaceId: string | undefined,
  mode: GitDiffSummaryMode,
  resourceKey = workspaceId,
) {
  const { data, fetchStatus } = useQuery(
    {
      ...gitDiffSummaryQuery(client, workspaceId ?? "", mode, resourceKey),
      enabled: false,
    },
    inspectorQueries,
  );
  return {
    summary: workspaceId ? (data ?? null) : null,
    loading: !!workspaceId && fetchStatus === "fetching",
  };
}

/**
 * Loads a fresh summary, sharing a request that is already running.
 * `afterCurrent` aborts that request and starts over, for callers that just
 * changed the working tree.
 */
export function refreshGitDiffSummary(
  client: ConnectionClient,
  workspaceId: string,
  mode: GitDiffSummaryMode,
  resourceKey = workspaceId,
  options: { afterCurrent?: boolean } = {},
): Promise<GitDiffSummary> {
  return fetchFresh(
    gitDiffSummaryQuery(client, workspaceId, mode, resourceKey),
    options.afterCurrent,
  );
}

export function retireGitDiffSummaryResource(
  client: Scope,
  resourceKey: string,
) {
  inspectorQueries.removeQueries({
    queryKey: scopedKey(client, "git-diff-summary", resourceKey),
  });
}

// --- Git diff files ---

retainQueries<GitDiffFile>(
  "git-diff-file",
  16 * 1024 * 1024,
  (file) => file.diff.length * 2,
);

/** One file's patch; `invalidateGitDiffFiles` refetches the shown ones. */
export function gitDiffFileQuery(
  client: ConnectionClient,
  workspaceId: string,
  mode: GitDiffSummaryMode,
  entry: GitDiffEntry,
) {
  return {
    queryKey: scopedKey(
      client,
      "git-diff-file",
      workspaceId,
      mode,
      entry.kind,
      entry.path,
      entry.old_path ?? "",
    ),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const file = (await client.call(
        "git.diff_file",
        {
          workspace_id: workspaceId,
          mode,
          path: entry.path,
          old_path: entry.old_path,
          kind: entry.kind,
        },
        { signal },
      )) as GitDiffFile;
      if (!client.isCurrent()) {
        throw new Error(t("connection changed during diff request"));
      }
      return file;
    },
  };
}

export function invalidateGitDiffFiles(client: Scope, workspaceId: string) {
  void inspectorQueries.invalidateQueries({
    queryKey: scopedKey(client, "git-diff-file", workspaceId),
  });
}
