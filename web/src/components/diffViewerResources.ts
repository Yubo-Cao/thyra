import { thyraLocalStorage } from "../browserStorage";
import type { ConnectionClient } from "../api";
import type { GitDiffEntry, GitDiffFile, GitDiffSummary } from "../types";
import { connectionClientScopeKey } from "../useConnectionClient";
import { connectionStorageKey } from "../connectionStorage";
import {
  refreshGitDiffSummary,
  retireGitDiffSummaryResource,
} from "../gitDiffSummaryStore";
import { diffAutoCollapseInfo } from "./diffAutoCollapse";

// Diff viewer caches and background warmups. The app shell prefetches the
// focused workspace's diff through this module, so it must stay free of the
// panel's UI: the panel itself loads lazily with the workspace inspector.
export type ActiveDiffSelection = {
  selectionRevision?: number;
  entry: GitDiffEntry | null;
  file: GitDiffFile | null;
  loading: boolean;
  error: string | null;
  entries: GitDiffEntry[];
  files: Record<string, GitDiffFile>;
  fileErrors: Record<string, string>;
  summaryLoading: boolean;
};

export type DiffSelectionMeta = {
  userInitiated?: boolean;
};

export type DiffCache = {
  summary: GitDiffSummary | null;
  selected: GitDiffEntry | null;
  files: Record<string, GitDiffFile>;
  fileErrors: Record<string, string>;
  error: string | null;
};

export type DiffScope = "working" | "branch-main" | "last-step";

const diffCache = new Map<string, DiffCache>();
const diffCacheRevisions = new Map<string, number>();
const diffPrefetches = new Map<string, Promise<void>>();
const diffFileRequests = new Map<string, Promise<GitDiffFile>>();
const DIFF_PREFETCH_CONCURRENCY = 3;
const MAX_CACHED_DIFF_FILES = 24;
const MAX_CACHED_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_CACHE_CONTEXTS = 8;
const MAX_TOTAL_CACHED_DIFF_BYTES = 24 * 1024 * 1024;
const DIFF_SCOPE_KEY = "diffViewerScope";

export function diffScopeStorageKey(
  connectionId: string,
  resourceKey?: string,
) {
  return connectionStorageKey(
    connectionId,
    resourceKey ? `${DIFF_SCOPE_KEY}:${resourceKey}` : DIFF_SCOPE_KEY,
  );
}

export function loadDiffScope(
  connectionId = "legacy-default",
  resourceKey?: string,
): DiffScope {
  const scoped = thyraLocalStorage.getItem(
    diffScopeStorageKey(connectionId, resourceKey),
  );
  const value =
    scoped ??
    (resourceKey
      ? thyraLocalStorage.getItem(diffScopeStorageKey(connectionId))
      : null);
  if (value === "branch-main") return "branch-main";
  if (value === "last-step") return "last-step";
  return "working";
}

export function diffEntryKey(entry: GitDiffEntry) {
  return `${entry.kind}:${entry.path}`;
}

function estimatedDiffBytes(file: GitDiffFile) {
  return file.diff.length * 2;
}

function diffCacheBytes(cache: DiffCache) {
  return Object.values(cache.files).reduce(
    (total, file) => total + estimatedDiffBytes(file),
    0,
  );
}

function pruneDiffCaches(activeKey: string) {
  const totalBytes = () =>
    Array.from(diffCache.values()).reduce(
      (total, cache) => total + diffCacheBytes(cache),
      0,
    );

  while (
    diffCache.size > MAX_DIFF_CACHE_CONTEXTS ||
    totalBytes() > MAX_TOTAL_CACHED_DIFF_BYTES
  ) {
    const oldestKey = Array.from(diffCache.keys()).find(
      (key) => key !== activeKey,
    );
    if (!oldestKey) return;
    advanceDiffCacheRevision(oldestKey);
    diffCache.delete(oldestKey);
  }
}

function setDiffCache(key: string, cache: DiffCache) {
  diffCache.delete(key);
  diffCache.set(key, cache);
  pruneDiffCaches(key);
}

export function boundedDiffFiles(
  files: Record<string, GitDiffFile>,
  selected: GitDiffEntry | null,
) {
  const selectedKey = selected ? diffEntryKey(selected) : null;
  const keptNewestFirst: string[] = [];
  let cachedBytes = 0;

  if (selectedKey && files[selectedKey]) {
    keptNewestFirst.push(selectedKey);
    cachedBytes = estimatedDiffBytes(files[selectedKey]);
  }

  const keys = Object.keys(files);
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    if (key === selectedKey) continue;
    if (keptNewestFirst.length >= MAX_CACHED_DIFF_FILES) break;
    const fileBytes = estimatedDiffBytes(files[key]);
    if (
      keptNewestFirst.length > 0 &&
      cachedBytes + fileBytes > MAX_CACHED_DIFF_BYTES
    ) {
      continue;
    }
    keptNewestFirst.push(key);
    cachedBytes += fileBytes;
  }

  return Object.fromEntries(
    keptNewestFirst.reverse().map((key) => [key, files[key]]),
  );
}

export function beginDiffFileSelection(
  current: DiffCache,
  entry: GitDiffEntry,
) {
  const key = diffEntryKey(entry);
  const fileErrors = { ...current.fileErrors };
  delete fileErrors[key];
  return {
    ...current,
    selected: entry,
    files: boundedDiffFiles(current.files, entry),
    fileErrors,
    error: null,
  };
}

export function mergeResolvedDiffFile(
  current: DiffCache,
  entry: GitDiffEntry,
  file: GitDiffFile,
) {
  const key = diffEntryKey(entry);
  const requestIsSelected =
    current.selected !== null && diffEntryKey(current.selected) === key;
  const selected = requestIsSelected ? entry : current.selected;
  return {
    ...current,
    selected,
    files: boundedDiffFiles({ ...current.files, [key]: file }, selected),
    fileErrors: Object.fromEntries(
      Object.entries(current.fileErrors).filter(
        ([errorKey]) => errorKey !== key,
      ),
    ),
    error: requestIsSelected ? null : current.error,
  };
}

export function buildActiveDiffSelection(
  source: DiffCache,
  patch: Partial<ActiveDiffSelection>,
  fileLoadingKey: string | null,
  summaryLoading: boolean,
): ActiveDiffSelection {
  const selected = patch.entry === undefined ? source.selected : patch.entry;
  const files = patch.files === undefined ? source.files : patch.files;
  const key = selected ? diffEntryKey(selected) : "";
  return {
    entry: selected,
    file:
      patch.file === undefined
        ? key
          ? (files[key] ?? null)
          : null
        : patch.file,
    loading:
      patch.loading ??
      (summaryLoading || (!!key && fileLoadingKey === key && !files[key])),
    error: patch.error === undefined ? source.error : patch.error,
    entries:
      patch.entries === undefined
        ? treeOrderedDiffEntries(source.summary?.entries ?? [])
        : patch.entries,
    files,
    fileErrors:
      patch.fileErrors === undefined ? source.fileErrors : patch.fileErrors,
    summaryLoading:
      patch.summaryLoading === undefined
        ? summaryLoading
        : patch.summaryLoading,
  };
}

export function diffCacheKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
  resourceKey = workspaceId,
) {
  return connectionClientScopeKey(
    client,
    "diff",
    resourceKey ?? "focused",
    scope,
  );
}

export function diffRuntimeContextKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
  resourceKey = workspaceId,
) {
  return connectionClientScopeKey(
    client,
    "diff-runtime",
    resourceKey ?? "focused",
    workspaceId ?? "missing",
    scope,
  );
}

export function diffCacheRevision(key: string): number {
  return diffCacheRevisions.get(key) ?? 0;
}

export function advanceDiffCacheRevision(key: string): number {
  const next = diffCacheRevision(key) + 1;
  diffCacheRevisions.set(key, next);
  return next;
}

export function retireDiffCache(key: string) {
  advanceDiffCacheRevision(key);
  diffCache.delete(key);
}

function diffFileRequestKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string,
  scope: DiffScope,
  entry: GitDiffEntry,
  revision: number,
  snapshotId?: string,
) {
  return connectionClientScopeKey(
    client,
    "diff-file",
    workspaceId,
    scope,
    diffEntryKey(entry),
    revision,
    snapshotId ?? "live",
  );
}

export function diffSelectionStorageKey(
  connectionId: string,
  workspaceId: string,
  scope: DiffScope,
) {
  return connectionStorageKey(
    connectionId,
    `diffViewerSelected:${workspaceId}:${scope}`,
  );
}

function readStoredSelection(
  connectionId: string,
  workspaceId: string | undefined,
  scope: DiffScope,
): GitDiffEntry | null {
  if (!workspaceId) return null;
  try {
    const raw = thyraLocalStorage.getItem(
      diffSelectionStorageKey(connectionId, workspaceId, scope),
    );
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<GitDiffEntry>;
    if (
      typeof value.path === "string" &&
      [
        "staged",
        "unstaged",
        "untracked",
        "conflicted",
        "branch",
        "last-step",
      ].includes(value.kind ?? "") &&
      typeof value.status === "string"
    ) {
      return value as GitDiffEntry;
    }
  } catch {
    // Ignore invalid persisted UI state.
  }
  return null;
}

export function writeStoredSelection(
  connectionId: string,
  workspaceId: string | undefined,
  scope: DiffScope,
  entry: GitDiffEntry,
) {
  if (!workspaceId) return;
  thyraLocalStorage.setItem(
    diffSelectionStorageKey(connectionId, workspaceId, scope),
    JSON.stringify(entry),
  );
}

export function clearDiffViewerResourceCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  resourceKey: string,
  storage: Pick<Storage, "removeItem"> = thyraLocalStorage,
) {
  for (const scope of ["working", "branch-main", "last-step"] as const) {
    retireDiffCache(diffCacheKey(client, undefined, scope, resourceKey));
    storage.removeItem(
      diffSelectionStorageKey(client.connectionId, resourceKey, scope),
    );
  }
  retireGitDiffSummaryResource(client, resourceKey);
  storage.removeItem(diffScopeStorageKey(client.connectionId, resourceKey));
  diffPrefetches.delete(
    connectionClientScopeKey(client, "diff-prefetch", resourceKey),
  );
}

function emptyDiffCache(): DiffCache {
  return {
    summary: null,
    selected: null,
    files: {},
    fileErrors: {},
    error: null,
  };
}

export function readDiffCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
  resourceKey = workspaceId,
) {
  const key = diffCacheKey(client, workspaceId, scope, resourceKey);
  const cached = diffCache.get(key);
  if (cached) {
    diffCache.delete(key);
    diffCache.set(key, cached);
    return {
      ...cached,
      files: { ...cached.files },
      fileErrors: { ...cached.fileErrors },
    };
  }
  const next = emptyDiffCache();
  setDiffCache(key, next);
  return {
    ...next,
    files: { ...next.files },
    fileErrors: { ...next.fileErrors },
  };
}

export function writeDiffCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
  patch: Partial<DiffCache>,
  resourceKey = workspaceId,
) {
  const key = diffCacheKey(client, workspaceId, scope, resourceKey);
  const current = diffCache.get(key) ?? emptyDiffCache();
  const selected =
    patch.selected === undefined ? current.selected : patch.selected;
  setDiffCache(key, {
    ...current,
    ...patch,
    selected,
    files: boundedDiffFiles(patch.files ?? current.files, selected),
    fileErrors: patch.fileErrors
      ? { ...patch.fileErrors }
      : { ...current.fileErrors },
  });
}

export function resolveSelectedEntry(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string,
  scope: DiffScope,
  entries: GitDiffEntry[],
  preferred?: GitDiffEntry | null,
  resourceKey = workspaceId,
) {
  const stored = readStoredSelection(client.connectionId, resourceKey, scope);
  const candidates = [preferred, stored].filter(Boolean) as GitDiffEntry[];
  for (const candidate of candidates) {
    const match = entries.find(
      (entry) => diffEntryKey(entry) === diffEntryKey(candidate),
    );
    if (match) return match;
  }
  return (
    entries.find((entry) => diffAutoCollapseInfo(entry) === null) ??
    entries[0] ??
    null
  );
}

export function requestDiffFile(
  client: ConnectionClient,
  workspaceId: string,
  scope: DiffScope,
  entry: GitDiffEntry,
  revision: number,
  snapshotId?: string,
) {
  if (!client.isCurrent()) {
    return Promise.reject(new Error("connection changed during diff request"));
  }
  if (scope === "last-step" && !snapshotId) {
    return Promise.reject(
      new Error("last-step diff requires a fresh summary snapshot"),
    );
  }
  const requestKey = diffFileRequestKey(
    client,
    workspaceId,
    scope,
    entry,
    revision,
    snapshotId,
  );
  const running = diffFileRequests.get(requestKey);
  if (running) return running;
  const task = client.call("git.diff_file", {
    workspace_id: workspaceId,
    mode: scope,
    path: entry.path,
    old_path: entry.old_path,
    kind: entry.kind,
    snapshot_id: snapshotId,
  }) as Promise<GitDiffFile>;
  diffFileRequests.set(
    requestKey,
    task
      .then((file) => {
        if (!client.isCurrent()) {
          throw new Error("connection changed during diff request");
        }
        return file;
      })
      .finally(() => {
        diffFileRequests.delete(requestKey);
      }),
  );
  return diffFileRequests.get(requestKey)!;
}

function cacheDiffFile(
  client: ConnectionClient,
  workspaceId: string,
  scope: DiffScope,
  entry: GitDiffEntry,
  file: GitDiffFile,
  resourceKey: string,
  revision: number,
) {
  const key = diffCacheKey(client, workspaceId, scope, resourceKey);
  if (!client.isCurrent() || diffCacheRevision(key) !== revision) return;
  const cached = readDiffCache(client, workspaceId, scope, resourceKey);
  const nextFileErrors = { ...cached.fileErrors };
  delete nextFileErrors[diffEntryKey(entry)];
  writeDiffCache(
    client,
    workspaceId,
    scope,
    {
      files: { ...cached.files, [diffEntryKey(entry)]: file },
      fileErrors: nextFileErrors,
      error: null,
    },
    resourceKey,
  );
}

export function prefetchDiffFilesInBatches(
  client: ConnectionClient,
  workspaceId: string,
  scope: DiffScope,
  entries: GitDiffEntry[],
  resourceKey = workspaceId,
  onFile?: (entry: GitDiffEntry, file: GitDiffFile, revision: number) => void,
  onFileError?: (entry: GitDiffEntry, error: string, revision: number) => void,
) {
  const key = diffCacheKey(client, workspaceId, scope, resourceKey);
  const revision = diffCacheRevision(key);
  const cached = readDiffCache(client, workspaceId, scope, resourceKey);
  const snapshotId = cached.summary?.snapshot_id;
  const queue = entries.filter((entry) => !cached.files[diffEntryKey(entry)]);
  if (!queue.length) return Promise.resolve();

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const entry = queue[cursor];
      cursor += 1;
      try {
        const file = await requestDiffFile(
          client,
          workspaceId,
          scope,
          entry,
          revision,
          snapshotId,
        );
        if (!client.isCurrent() || diffCacheRevision(key) !== revision) return;
        cacheDiffFile(
          client,
          workspaceId,
          scope,
          entry,
          file,
          resourceKey,
          revision,
        );
        onFile?.(entry, file, revision);
      } catch (e) {
        if (!client.isCurrent() || diffCacheRevision(key) !== revision) return;
        onFileError?.(entry, (e as Error).message, revision);
      }
    }
  };

  return Promise.all(
    Array.from(
      { length: Math.min(DIFF_PREFETCH_CONCURRENCY, queue.length) },
      () => worker(),
    ),
  ).then(() => undefined);
}

export type DiffTreeNode = {
  name: string;
  path: string;
  children: Map<string, DiffTreeNode>;
  entries: GitDiffEntry[];
};

function makeTreeNode(name: string, path: string): DiffTreeNode {
  return { name, path, children: new Map(), entries: [] };
}

/** Every summary entry under a tree node, so folder menus can act on the
 *  whole directory. */
export function collectTreeEntries(node: DiffTreeNode): GitDiffEntry[] {
  const entries = [...node.entries];
  for (const child of node.children.values()) {
    entries.push(...collectTreeEntries(child));
  }
  return entries;
}

export function buildDiffTree(entries: GitDiffEntry[]) {
  const root = makeTreeNode("", "");
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let child = node.children.get(part);
      if (!child) {
        child = makeTreeNode(part, path);
        node.children.set(part, child);
      }
      node = child;
    });
    node.entries.push(entry);
  }
  return root;
}

export function sortDiffTreeChildren(children: Iterable<DiffTreeNode>) {
  return [...children].sort((a, b) => {
    const aFile = a.entries.length > 0;
    const bFile = b.entries.length > 0;
    if (aFile !== bFile) return aFile ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function treeOrderedDiffEntries(entries: GitDiffEntry[]) {
  const ordered: GitDiffEntry[] = [];
  const visit = (node: DiffTreeNode) => {
    for (const child of sortDiffTreeChildren(node.children.values())) {
      if (child.entries.length) {
        ordered.push(...child.entries);
      } else {
        visit(child);
      }
    }
  };
  visit(buildDiffTree(entries));
  return ordered;
}

export function expandedDirsForSelection(entry: GitDiffEntry | null) {
  return expandedDirsForEntries(entry ? [entry] : []);
}

export function expandedDirsForEntries(entries: GitDiffEntry[]) {
  const expanded = new Set<string>([""]);
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      expanded.add(parts.slice(0, index).join("/"));
    }
  }
  return expanded;
}

export function prefetchDiffViewerWorkspace(
  workspaceId: string | undefined,
  client: ConnectionClient,
  resourceKey = workspaceId,
) {
  if (!workspaceId || !client.isCurrent()) return Promise.resolve();
  const prefetchKey = connectionClientScopeKey(
    client,
    "diff-prefetch",
    resourceKey,
  );
  const running = diffPrefetches.get(prefetchKey);
  if (running) return running;

  const task = (async () => {
    const scope: DiffScope = "working";
    const cacheKey = diffCacheKey(client, workspaceId, scope, resourceKey);
    let revision = diffCacheRevision(cacheKey);
    const cached = readDiffCache(client, workspaceId, scope, resourceKey);
    const summary = await refreshGitDiffSummary(
      client,
      workspaceId,
      scope,
      resourceKey,
    );
    if (!client.isCurrent() || diffCacheRevision(cacheKey) !== revision) return;
    const selected = resolveSelectedEntry(
      client,
      workspaceId,
      scope,
      summary.entries,
      cached.selected,
      resourceKey,
    );
    const files: Record<string, GitDiffFile> = {};

    // A warmup publishes a fresh summary. Retire any batch that was still
    // loading files from the previously cached snapshot before replacing it.
    revision = advanceDiffCacheRevision(cacheKey);
    writeDiffCache(
      client,
      workspaceId,
      scope,
      {
        summary,
        selected,
        files,
        error: null,
      },
      resourceKey,
    );

    if (!selected) return;
    const key = diffEntryKey(selected);
    if (files[key]) return;
    const file = await requestDiffFile(
      client,
      workspaceId,
      scope,
      selected,
      revision,
    );
    if (!client.isCurrent() || diffCacheRevision(cacheKey) !== revision) return;
    writeDiffCache(
      client,
      workspaceId,
      scope,
      {
        summary,
        selected,
        files: { ...files, [key]: file },
        error: null,
      },
      resourceKey,
    );
  })()
    .catch(() => {
      // Background warmups should never surface transient bridge errors.
    })
    .finally(() => {
      if (diffPrefetches.get(prefetchKey) === task) {
        diffPrefetches.delete(prefetchKey);
      }
    });

  diffPrefetches.set(prefetchKey, task);
  return task;
}
