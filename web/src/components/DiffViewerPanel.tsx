import { thyraLocalStorage } from "../browserStorage";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileDiff,
  Folder,
  RefreshCw,
} from "lucide-react";
import type { GitDiffEntry } from "../types";
import { useStoreSelector } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import { gitDiffCode, gitDiffCodeLabel } from "../gitDiffStatus";
import {
  lastStepCompletionKey,
  useLastStepCompletion,
} from "../lastStepCompletionStore";
import {
  refreshGitDiffSummary,
  retireGitDiffSummary,
  useGitDiffSummaryState,
} from "../gitDiffSummaryStore";
import { store } from "../store";
import { getLocale, t } from "../i18n";
import { copyTextFromUserGesture } from "../terminalClipboard";
import { bumpFileExplorerRefresh } from "../fileExplorerRefresh";
import {
  buildGitFileMenuItems,
  buildGitRepoMenuItems,
  countWorkingEntries,
  gitFileConfirmCopy,
  gitFolderConfirmCopy,
  gitRepoConfirmCopy,
  type GitFileMenuItem,
  type GitRepoMenuItem,
} from "../gitActions";
import { keyboardContextMenuPoint, treeKeyboardAction } from "./treeKeyboard";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { ContextMenu } from "./ui/ContextMenu";
import { IconButton } from "./ui/IconButton";
import { SegmentedControl } from "./ui/SegmentedControl";
import {
  type ActiveDiffSelection,
  advanceDiffCacheRevision,
  beginDiffFileSelection,
  boundedDiffFiles,
  buildActiveDiffSelection,
  buildDiffTree,
  collectTreeEntries,
  type DiffCache,
  diffCacheKey,
  diffCacheRevision,
  diffEntryKey,
  diffRuntimeContextKey,
  type DiffScope,
  diffScopeStorageKey,
  type DiffSelectionMeta,
  type DiffTreeNode,
  expandedDirsForEntries,
  loadDiffScope,
  mergeResolvedDiffFile,
  readDiffCache,
  requestDiffFile,
  resolveSelectedEntry,
  retireDiffCache,
  sortDiffTreeChildren,
  treeOrderedDiffEntries,
  writeDiffCache,
  writeStoredSelection,
} from "./diffViewerResources";
import "./DiffViewerPanel.css";

export {
  type ActiveDiffSelection,
  beginDiffFileSelection,
  buildActiveDiffSelection,
  clearDiffViewerResourceCache,
  diffCacheKey,
  diffRuntimeContextKey,
  diffSelectionStorageKey,
  type DiffSelectionMeta,
  expandedDirsForEntries,
  expandedDirsForSelection,
  mergeResolvedDiffFile,
  prefetchDiffFilesInBatches,
  prefetchDiffViewerWorkspace,
} from "./diffViewerResources";

export type DiffViewerPanelHandle = {
  selectEntry: (entry: GitDiffEntry) => void;
  selectWorkingEntry: (entry: GitDiffEntry) => void;
  selectWorkingEntries: (entries: GitDiffEntry[]) => void;
};

export type DiffViewerPanelProps = {
  workspaceId?: string;
  resourceKey?: string;
  onSelectionChange?: (
    selection: ActiveDiffSelection,
    meta?: DiffSelectionMeta,
  ) => void;
  onOpenFile?: (entry: GitDiffEntry) => void;
};

const DIFF_TREE_INDENT = 9;
const DIFF_TREE_BASE_INDENT = 6;
const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;

function diffStatsForEntries(entries: GitDiffEntry[]) {
  return entries.reduce(
    (total, entry) => ({
      additions: total.additions + (entry.additions ?? 0),
      deletions: total.deletions + (entry.deletions ?? 0),
      hasStats:
        total.hasStats ||
        typeof entry.additions === "number" ||
        typeof entry.deletions === "number",
    }),
    { additions: 0, deletions: 0, hasStats: false },
  );
}

type DiffContextMenuState = {
  x: number;
  y: number;
  path: string;
  entries: GitDiffEntry[];
  directory?: boolean;
};

type DiffConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
  run: () => void;
};

export const DiffViewerPanel = forwardRef<
  DiffViewerPanelHandle,
  DiffViewerPanelProps
>(function DiffViewerPanel(
  { workspaceId, resourceKey, onSelectionChange, onOpenFile },
  ref,
) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const connectionClient = useConnectionClient();
  const focusedWorkspace = workspaces.find((w) => w.focused);
  const workspace = workspaceId
    ? workspaces.find((w) => w.workspace_id === workspaceId)
    : focusedWorkspace;
  const cacheWorkspaceId = workspace?.workspace_id;
  const cacheResourceKey = resourceKey ?? cacheWorkspaceId;
  const completionKey = lastStepCompletionKey(
    connectionClient.connectionId,
    cacheWorkspaceId,
  );
  const completionRevision = useLastStepCompletion(completionKey);
  const completionRevisionRef = useRef({
    key: completionKey,
    revision: completionRevision,
  });
  const [diffScope, setDiffScope] = useState<DiffScope>(() =>
    loadDiffScope(connectionClient.connectionId, cacheResourceKey),
  );
  const sharedSummaryState = useGitDiffSummaryState(
    connectionClient,
    cacheWorkspaceId,
    diffScope,
    cacheResourceKey,
  );
  const [cache, setCache] = useState<DiffCache>(() =>
    readDiffCache(
      connectionClient,
      cacheWorkspaceId,
      loadDiffScope(connectionClient.connectionId, cacheResourceKey),
      cacheResourceKey,
    ),
  );
  const summaryLoading = sharedSummaryState.loading;
  const [fileLoadingKey, setFileLoadingKey] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set([""]),
  );
  const activeContextRef = useRef(
    diffRuntimeContextKey(
      connectionClient,
      cacheWorkspaceId,
      diffScope,
      cacheResourceKey,
    ),
  );
  const selectionRevisionRef = useRef(0);
  const selectedEntryKeyRef = useRef(
    cache.selected ? diffEntryKey(cache.selected) : "",
  );
  const pendingWorkingEntriesRef = useRef<GitDiffEntry[]>([]);
  const preferredSummarySelectionRef = useRef<GitDiffEntry | null>(null);
  const diffScopeRef = useRef(diffScope);
  diffScopeRef.current = diffScope;
  const onSelectionChangeRef = useRef(onSelectionChange);
  const [contextMenu, setContextMenu] = useState<DiffContextMenuState | null>(
    null,
  );
  const [confirmState, setConfirmState] = useState<DiffConfirmState | null>(
    null,
  );
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggeredRef = useRef(false);

  useLayoutEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useLayoutEffect(() => {
    activeContextRef.current = diffRuntimeContextKey(
      connectionClient,
      cacheWorkspaceId,
      diffScope,
      cacheResourceKey,
    );
  }, [cacheResourceKey, cacheWorkspaceId, connectionClient, diffScope]);

  const isCurrentContext = (
    workspaceId: string | undefined,
    scope: DiffScope,
  ) =>
    connectionClient.isCurrent() &&
    activeContextRef.current ===
      diffRuntimeContextKey(
        connectionClient,
        workspaceId,
        scope,
        cacheResourceKey,
      );

  const updateCache = (patch: Partial<DiffCache>) => {
    setCache((current) => {
      const selected =
        patch.selected === undefined ? current.selected : patch.selected;
      const next = {
        ...current,
        ...patch,
        selected,
        files: boundedDiffFiles(patch.files ?? current.files, selected),
        fileErrors: patch.fileErrors
          ? { ...patch.fileErrors }
          : { ...current.fileErrors },
      };
      writeDiffCache(
        connectionClient,
        cacheWorkspaceId,
        diffScope,
        next,
        cacheResourceKey,
      );
      return next;
    });
  };

  useEffect(() => {
    const summary = sharedSummaryState.summary;
    if (
      !workspace?.workspace_id ||
      !summary ||
      cache.summary === summary ||
      !isCurrentContext(workspace.workspace_id, diffScope)
    ) {
      return;
    }
    const selected = resolveSelectedEntry(
      connectionClient,
      workspace.workspace_id,
      diffScope,
      summary.entries,
      preferredSummarySelectionRef.current ?? cache.selected,
      cacheResourceKey,
    );
    preferredSummarySelectionRef.current = null;
    advanceDiffCacheRevision(
      diffCacheKey(
        connectionClient,
        workspace.workspace_id,
        diffScope,
        cacheResourceKey,
      ),
    );
    selectedEntryKeyRef.current = selected ? diffEntryKey(selected) : "";
    updateCache({
      summary,
      selected,
      files: {},
      fileErrors: {},
      error: null,
    });
    setExpandedDirs(expandedDirsForEntries(summary.entries));
    const pendingEntries = pendingWorkingEntriesRef.current;
    if (diffScope === "working" && pendingEntries.length) {
      pendingWorkingEntriesRef.current = [];
      const currentEntries = pendingEntries.flatMap((target) => {
        const match = summary.entries.find(
          (entry) =>
            entry.path === target.path &&
            entry.kind === target.kind &&
            entry.status === target.status,
        );
        return match ? [match] : [];
      });
      for (const target of currentEntries) {
        void loadFileRef.current(target, { userInitiated: true });
      }
    }
    // The shared snapshot is the synchronization boundary; cache adoption is
    // intentionally driven only when that immutable snapshot changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedSummaryState.summary]);

  const diffSelection = useCallback(
    (
      source: DiffCache = cache,
      patch: Partial<ActiveDiffSelection> = {},
    ): ActiveDiffSelection => ({
      ...buildActiveDiffSelection(
        source,
        patch,
        fileLoadingKey,
        summaryLoading,
      ),
      selectionRevision: selectionRevisionRef.current,
    }),
    [cache, fileLoadingKey, summaryLoading],
  );

  useEffect(() => {
    onSelectionChangeRef.current?.(diffSelection(cache));
  }, [cache, diffSelection]);

  const loadSummary = async (
    previousSelected = cache.selected,
    afterCurrent = false,
    clearCurrent = false,
  ) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    const workspaceId = workspace.workspace_id;
    const scope = diffScope;
    preferredSummarySelectionRef.current = previousSelected;
    advanceDiffCacheRevision(
      diffCacheKey(connectionClient, workspaceId, scope, cacheResourceKey),
    );
    setFileLoadingKey(null);
    updateCache(
      clearCurrent
        ? {
            summary: null,
            selected: null,
            files: {},
            fileErrors: {},
            error: null,
          }
        : { error: null },
    );
    try {
      await refreshGitDiffSummary(
        connectionClient,
        workspaceId,
        scope,
        cacheResourceKey,
        { afterCurrent },
      );
    } catch (e) {
      if (isCurrentContext(workspaceId, scope)) {
        updateCache({ error: (e as Error).message });
      }
    }
  };

  useEffect(() => {
    const previous = completionRevisionRef.current;
    completionRevisionRef.current = {
      key: completionKey,
      revision: completionRevision,
    };
    if (
      !cacheWorkspaceId ||
      previous.key !== completionKey ||
      previous.revision === completionRevision
    ) {
      return;
    }

    if (diffScopeRef.current === "last-step") {
      retireGitDiffSummary(
        connectionClient,
        cacheWorkspaceId,
        "last-step",
        cacheResourceKey,
      );
      void loadSummary(cache.selected, false, true);
      return;
    }
    retireDiffCache(
      diffCacheKey(
        connectionClient,
        cacheWorkspaceId,
        "last-step",
        cacheResourceKey,
      ),
    );
    retireGitDiffSummary(
      connectionClient,
      cacheWorkspaceId,
      "last-step",
      cacheResourceKey,
    );
    // Completion notifications are not debounced with pane-list refreshes, so
    // rapid quiet-to-active edges cannot leave the prior step cached forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheWorkspaceId, completionKey, completionRevision]);

  const loadFile = async (
    entry: GitDiffEntry,
    meta: DiffSelectionMeta = {},
  ) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    const workspaceId = workspace.workspace_id;
    const scope = diffScope;
    const key = diffEntryKey(entry);
    const cacheKey = diffCacheKey(
      connectionClient,
      workspaceId,
      scope,
      cacheResourceKey,
    );
    const revision = diffCacheRevision(cacheKey);
    if (meta.userInitiated) selectionRevisionRef.current += 1;
    selectedEntryKeyRef.current = key;
    setCache((current) => {
      const next = beginDiffFileSelection(current, entry);
      writeDiffCache(
        connectionClient,
        cacheWorkspaceId,
        scope,
        next,
        cacheResourceKey,
      );
      return next;
    });
    const immediateFileErrors = { ...cache.fileErrors };
    delete immediateFileErrors[key];
    writeStoredSelection(
      connectionClient.connectionId,
      cacheResourceKey,
      scope,
      entry,
    );
    const cachedFile = cache.files[key];
    if (cachedFile) {
      setFileLoadingKey(null);
      onSelectionChangeRef.current?.(
        diffSelection(cache, {
          entry,
          file: cachedFile,
          fileErrors: immediateFileErrors,
          error: null,
        }),
        meta,
      );
      return;
    }
    setFileLoadingKey(key);
    onSelectionChangeRef.current?.(
      diffSelection(cache, {
        entry,
        file: null,
        loading: true,
        error: null,
        fileErrors: immediateFileErrors,
      }),
      meta,
    );
    try {
      const file = await requestDiffFile(
        connectionClient,
        workspaceId,
        scope,
        entry,
        revision,
        cache.summary?.snapshot_id,
      );
      if (
        !isCurrentContext(workspaceId, scope) ||
        diffCacheRevision(cacheKey) !== revision
      ) {
        return;
      }
      setCache((current) => {
        if (diffCacheRevision(cacheKey) !== revision) return current;
        const next = mergeResolvedDiffFile(current, entry, file);
        writeDiffCache(
          connectionClient,
          cacheWorkspaceId,
          scope,
          next,
          cacheResourceKey,
        );
        return next;
      });
      if (selectedEntryKeyRef.current === key) {
        onSelectionChangeRef.current?.(
          diffSelection(cache, {
            entry,
            file,
            files: boundedDiffFiles({ ...cache.files, [key]: file }, entry),
            fileErrors: Object.fromEntries(
              Object.entries(cache.fileErrors).filter(
                ([errorKey]) => errorKey !== key,
              ),
            ),
            loading: false,
            error: null,
          }),
          meta,
        );
      }
    } catch (e) {
      if (
        !isCurrentContext(workspaceId, scope) ||
        diffCacheRevision(cacheKey) !== revision
      ) {
        return;
      }
      const message = (e as Error).message;
      setCache((current) => {
        if (diffCacheRevision(cacheKey) !== revision) return current;
        const requestIsSelected =
          current.selected !== null && diffEntryKey(current.selected) === key;
        const next = {
          ...current,
          error: requestIsSelected ? message : current.error,
          fileErrors: { ...current.fileErrors, [key]: message },
        };
        writeDiffCache(
          connectionClient,
          cacheWorkspaceId,
          scope,
          next,
          cacheResourceKey,
        );
        return next;
      });
      if (selectedEntryKeyRef.current === key) {
        onSelectionChangeRef.current?.(
          diffSelection(cache, {
            entry,
            file: null,
            loading: false,
            error: message,
            fileErrors: { ...cache.fileErrors, [key]: message },
          }),
          meta,
        );
      }
    } finally {
      if (
        isCurrentContext(workspaceId, scope) &&
        diffCacheRevision(cacheKey) === revision
      ) {
        setFileLoadingKey((current) => (current === key ? null : current));
      }
    }
  };

  const loadFileRef = useRef(loadFile);
  useLayoutEffect(() => {
    loadFileRef.current = loadFile;
  });
  useImperativeHandle(ref, () => {
    const selectWorkingEntries = (targets: GitDiffEntry[]) => {
      if (!targets.length) return;
      if (diffScopeRef.current === "working") {
        for (const target of targets) {
          void loadFileRef.current(target, { userInitiated: true });
        }
        return;
      }
      pendingWorkingEntriesRef.current = targets;
      setDiffScope("working");
    };
    return {
      selectEntry: (target) => {
        void loadFileRef.current(target, { userInitiated: true });
      },
      selectWorkingEntry: (target) => selectWorkingEntries([target]),
      selectWorkingEntries,
    };
  }, []);

  const selectedDiffEntryKey = cache.selected
    ? diffEntryKey(cache.selected)
    : "";
  const selectedDiffFile = selectedDiffEntryKey
    ? cache.files[selectedDiffEntryKey]
    : undefined;

  useEffect(() => {
    thyraLocalStorage.setItem(
      diffScopeStorageKey(connectionClient.connectionId, cacheResourceKey),
      diffScope,
    );
  }, [cacheResourceKey, connectionClient.connectionId, diffScope]);

  useEffect(() => {
    const cached = readDiffCache(
      connectionClient,
      cacheWorkspaceId,
      diffScope,
      cacheResourceKey,
    );
    setFileLoadingKey(null);
    selectedEntryKeyRef.current = cached.selected
      ? diffEntryKey(cached.selected)
      : "";
    const pendingWorkingEntries =
      diffScope === "working" ? pendingWorkingEntriesRef.current : [];
    const preferredWorkingEntry =
      pendingWorkingEntries[pendingWorkingEntries.length - 1] ?? null;
    setCache(cached);
    setExpandedDirs(
      expandedDirsForEntries(
        cached.summary?.entries ?? (cached.selected ? [cached.selected] : []),
      ),
    );
    onSelectionChangeRef.current?.({
      entry: cached.selected,
      file: cached.selected
        ? (cached.files[diffEntryKey(cached.selected)] ?? null)
        : null,
      loading: false,
      error: cached.error,
      entries: treeOrderedDiffEntries(cached.summary?.entries ?? []),
      files: cached.files,
      fileErrors: cached.fileErrors,
      summaryLoading: false,
    });
    void loadSummary(preferredWorkingEntry ?? cached.selected);
    // Reopen against a fresh workspace snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheResourceKey, cacheWorkspaceId, connectionClient, diffScope]);

  useEffect(() => {
    if (cache.selected) void loadFile(cache.selected);
    else {
      onSelectionChangeRef.current?.(
        diffSelection(cache, {
          entry: null,
          file: null,
          loading: false,
          error: null,
        }),
      );
    }
    // Load the selected file whenever summary refresh changes selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cacheWorkspaceId,
    connectionClient,
    diffScope,
    selectedDiffEntryKey,
    selectedDiffFile,
  ]);

  const selectedKey = cache.selected ? diffEntryKey(cache.selected) : null;
  const tree = useMemo(
    () => buildDiffTree(cache.summary?.entries ?? []),
    [cache.summary?.entries],
  );
  const workingCounts = useMemo(
    () => countWorkingEntries(cache.summary?.entries ?? []),
    [cache.summary?.entries],
  );

  const clearLongPressTimer = () => {
    if (!longPressTimerRef.current) return;
    clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };
  }, []);

  const openContextMenu = (
    target: {
      path: string;
      entries: GitDiffEntry[];
      directory?: boolean;
    },
    x: number,
    y: number,
  ) => {
    if (diffScopeRef.current !== "working") return;
    clearLongPressTimer();
    setContextMenu({ x, y, ...target });
  };

  const handleEntryPointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    target: {
      path: string;
      entries: GitDiffEntry[];
      directory?: boolean;
    },
  ) => {
    if (event.pointerType === "mouse") return;
    longPressTriggeredRef.current = false;
    longPressStartRef.current = { x: event.clientX, y: event.clientY };
    clearLongPressTimer();
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      openContextMenu(target, event.clientX, event.clientY);
    }, LONG_PRESS_MS);
  };

  const handleEntryPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = longPressStartRef.current;
    if (!start) return;
    const dx = Math.abs(event.clientX - start.x);
    const dy = Math.abs(event.clientY - start.y);
    if (dx > LONG_PRESS_MOVE_PX || dy > LONG_PRESS_MOVE_PX) {
      clearLongPressTimer();
      longPressStartRef.current = null;
    }
  };

  const handleEntryPointerEnd = () => {
    clearLongPressTimer();
    longPressStartRef.current = null;
  };

  const copyPath = (path: string, kind: "relative" | "absolute") => {
    void copyTextFromUserGesture(path).then(
      () =>
        store.notify({
          kind: "success",
          message:
            kind === "relative"
              ? t("Relative path copied")
              : t("Absolute path copied"),
          detail: path,
          autoDismissMs: 5000,
        }),
      (error) =>
        store.notify({
          kind: "error",
          message:
            kind === "relative"
              ? t("Failed to copy relative path")
              : t("Failed to copy absolute path"),
          detail: error instanceof Error ? error.message : String(error),
        }),
    );
  };

  const afterGitMutation = async (workspaceId: string) => {
    bumpFileExplorerRefresh(connectionClient, workspaceId);
    await loadSummary(cache.selected, true);
  };

  const runGitFileMenuAction = (
    item: GitFileMenuItem,
    menu: DiffContextMenuState,
  ) => {
    const actionWorkspaceId = workspace?.workspace_id;
    if (!actionWorkspaceId) return;
    const matches = menu.entries.filter((entry) =>
      item.action === "discard_unstaged"
        ? entry.kind === "unstaged"
        : item.action === "delete_untracked"
          ? entry.kind === "untracked"
          : item.action === "unstage"
            ? entry.kind === "staged"
            : entry.kind !== "staged",
    );
    const targets = menu.directory
      ? matches.length
        ? matches
        : menu.entries
      : [matches[0] ?? menu.entries[0]].filter(
          (entry): entry is GitDiffEntry => !!entry,
        );
    if (!targets.length) return;
    const execute = async () => {
      if (menu.directory && targets.length > 1) {
        await store.runGitFileActionBatch(
          actionWorkspaceId,
          item.action,
          targets,
        );
        // A failed batch can still have changed earlier files.
      } else {
        const result = await store.runGitFileAction(
          actionWorkspaceId,
          item.action,
          targets[0],
        );
        if (!result) return;
      }
      await afterGitMutation(actionWorkspaceId);
    };
    if (item.destructive) {
      const copy = menu.directory
        ? gitFolderConfirmCopy(item.action, menu.path, targets.length)
        : gitFileConfirmCopy(item.action, targets[0].path);
      if (copy) {
        setConfirmState({ ...copy, run: () => void execute() });
        return;
      }
    }
    void execute();
  };

  const runGitRepoMenuAction = (item: GitRepoMenuItem) => {
    const actionWorkspaceId = workspace?.workspace_id;
    if (!actionWorkspaceId) return;
    const execute = async () => {
      const result = await store.runGitRepoAction(
        actionWorkspaceId,
        item.action,
        workingCounts,
      );
      if (!result) return;
      await afterGitMutation(actionWorkspaceId);
    };
    if (item.destructive) {
      const copy = gitRepoConfirmCopy(item.action, item.count);
      if (copy) {
        setConfirmState({ ...copy, run: () => void execute() });
        return;
      }
    }
    void execute();
  };

  const toggleDir = (path: string) => {
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderTreeNode = (node: DiffTreeNode, depth: number): ReactNode[] => {
    const items: ReactNode[] = [];
    const children = sortDiffTreeChildren(node.children.values());

    for (const child of children) {
      const isFile = child.entries.length > 0;
      const open = expandedDirs.has(child.path);
      if (!isFile) {
        items.push(
          <button
            type="button"
            className="diff-tree-row diff-tree-folder"
            style={{
              paddingLeft: DIFF_TREE_BASE_INDENT + depth * DIFF_TREE_INDENT,
            }}
            key={child.path}
            onClick={() => {
              if (longPressTriggeredRef.current) {
                longPressTriggeredRef.current = false;
                return;
              }
              toggleDir(child.path);
            }}
            onContextMenu={(event) => {
              if (diffScope !== "working") return;
              event.preventDefault();
              event.stopPropagation();
              openContextMenu(
                {
                  path: child.path,
                  entries: collectTreeEntries(child),
                  directory: true,
                },
                event.clientX,
                event.clientY,
              );
            }}
            onKeyDown={(event) => {
              if (diffScope !== "working") return;
              if (
                treeKeyboardAction(event.key, event.shiftKey) !== "context-menu"
              ) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              const point = keyboardContextMenuPoint(event.currentTarget);
              openContextMenu(
                {
                  path: child.path,
                  entries: collectTreeEntries(child),
                  directory: true,
                },
                point.x,
                point.y,
              );
            }}
            onPointerDown={(event) =>
              handleEntryPointerDown(event, {
                path: child.path,
                entries: collectTreeEntries(child),
                directory: true,
              })
            }
            onPointerMove={handleEntryPointerMove}
            onPointerUp={handleEntryPointerEnd}
            onPointerCancel={handleEntryPointerEnd}
            onPointerLeave={handleEntryPointerEnd}
          >
            <span className="diff-tree-twisty">
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
            <Folder size={15} />
            <span className="diff-tree-name">{child.name}</span>
          </button>,
        );
        if (open) items.push(...renderTreeNode(child, depth + 1));
        continue;
      }

      const primary = child.entries[0];
      const selected = child.entries.some(
        (entry) => diffEntryKey(entry) === selectedKey,
      );
      const stats = diffStatsForEntries(child.entries);
      const statusCodes = Array.from(
        new Set(child.entries.map((entry) => gitDiffCode(entry))),
      ).sort();
      items.push(
        <button
          type="button"
          key={child.path}
          className={`diff-tree-row diff-tree-file ${selected ? "is-selected" : ""}`}
          style={{
            paddingLeft: DIFF_TREE_BASE_INDENT + depth * DIFF_TREE_INDENT,
          }}
          onClick={() => {
            if (longPressTriggeredRef.current) {
              longPressTriggeredRef.current = false;
              return;
            }
            void loadFile(primary, { userInitiated: true });
          }}
          onContextMenu={(event) => {
            if (diffScope !== "working") return;
            event.preventDefault();
            event.stopPropagation();
            openContextMenu(child, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (diffScope !== "working") return;
            if (
              treeKeyboardAction(event.key, event.shiftKey) !== "context-menu"
            ) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            const point = keyboardContextMenuPoint(event.currentTarget);
            openContextMenu(child, point.x, point.y);
          }}
          onPointerDown={(event) => handleEntryPointerDown(event, child)}
          onPointerMove={handleEntryPointerMove}
          onPointerUp={handleEntryPointerEnd}
          onPointerCancel={handleEntryPointerEnd}
          onPointerLeave={handleEntryPointerEnd}
        >
          <span className="diff-tree-twisty" />
          <File size={15} />
          <span className="diff-tree-name">{child.name}</span>
          <span className="diff-tree-badges">
            {statusCodes.map((code) => (
              <span
                className={`git-status-code git-status-${code.toLowerCase()}`}
                key={code}
                role="img"
                aria-label={gitDiffCodeLabel(code)}
                title={gitDiffCodeLabel(code)}
              >
                {code}
              </span>
            ))}
          </span>
          {stats.hasStats ? (
            <span className="diff-tree-stats" aria-label={t("Line changes")}>
              <span className="diff-stat-add">+{stats.additions}</span>
              <span className="diff-stat-del">-{stats.deletions}</span>
            </span>
          ) : null}
        </button>,
      );
    }
    return items;
  };

  return (
    <aside className="diff-viewer-side" aria-label={t("Diff Viewer")}>
      <div className="diff-panel-toolbar">
        <SegmentedControl
          className="diff-scope-toggle"
          stretch
          aria-label={t("Diff scope")}
          value={diffScope}
          onChange={setDiffScope}
          options={[
            {
              value: "last-step",
              ariaLabel: t("Last step"),
              title: t("Last step"),
              label: (
                <>
                  <span className="diff-scope-label-full" aria-hidden="true">
                    {t("Last step")}
                  </span>
                  <span className="diff-scope-label-short" aria-hidden="true">
                    {t("Last")}
                  </span>
                </>
              ),
            },
            {
              value: "working",
              ariaLabel: t("Working tree"),
              title: t("Working tree"),
              label: (
                <>
                  <span className="diff-scope-label-full" aria-hidden="true">
                    {t("Working tree")}
                  </span>
                  <span className="diff-scope-label-short" aria-hidden="true">
                    {/* Chinese needs no abbreviation; "Working" and "Main"
                        mean an agent status and the main worktree elsewhere. */}
                    {getLocale() === "en" ? "Working" : t("Working tree")}
                  </span>
                </>
              ),
            },
            {
              value: "branch-main",
              ariaLabel: t("Against main"),
              title: t("Against main"),
              label: (
                <>
                  <span className="diff-scope-label-full" aria-hidden="true">
                    {t("Against main")}
                  </span>
                  <span className="diff-scope-label-short" aria-hidden="true">
                    {getLocale() === "en" ? "Main" : t("Against main")}
                  </span>
                </>
              ),
            },
          ]}
        />
        <div
          className="diff-toolbar-actions"
          role="group"
          aria-label={t("Diff actions")}
        >
          <IconButton
            className="diff-refresh"
            label={
              summaryLoading ? t("Refreshing changes") : t("Refresh changes")
            }
            aria-busy={summaryLoading}
            disabled={summaryLoading}
            onClick={() => void loadSummary(cache.selected, true)}
            icon={
              <RefreshCw
                className={summaryLoading ? "is-spinning" : ""}
                size={15}
              />
            }
          />
        </div>
      </div>

      {!workspace ? (
        <p className="modal-error">{t("No workspace is focused.")}</p>
      ) : null}

      {cache.error ? <p className="modal-error">{cache.error}</p> : null}

      <div className="diff-list diff-tree" aria-label={t("Changed files")}>
        {summaryLoading && !cache.summary ? (
          <DiffSkeleton />
        ) : cache.summary?.entries.length ? (
          renderTreeNode(tree, 0)
        ) : (
          <div className="diff-empty">
            <FileDiff size={18} />
            <span>
              {diffScope === "last-step" &&
              cache.summary?.baseline_available === false
                ? t("No completed agent step yet")
                : t("No changes")}
            </span>
          </div>
        )}
      </div>
      {fileLoadingKey ? (
        <div className="diff-loading-inline">{t("Loading diff...")}</div>
      ) : null}
      <ContextMenu
        position={contextMenu ? { x: contextMenu.x, y: contextMenu.y } : null}
        aria-label={t("Git actions")}
        header={
          contextMenu ? { title: contextMenu.path, subtitle: "Git" } : undefined
        }
        onClose={() => setContextMenu(null)}
        items={
          contextMenu
            ? [
                {
                  id: "path",
                  title: contextMenu.directory ? t("Folder") : t("File"),
                  items: [
                    ...(!contextMenu.directory &&
                    onOpenFile &&
                    contextMenu.entries[0]
                      ? [
                          {
                            id: "open",
                            label: t("Open file"),
                            onAction: () => onOpenFile(contextMenu.entries[0]!),
                          },
                        ]
                      : []),
                    {
                      id: "copy-relative",
                      label: t("Copy relative path"),
                      onAction: () => copyPath(contextMenu.path, "relative"),
                    },
                    ...(cache.summary?.root
                      ? [
                          {
                            id: "copy-absolute",
                            label: t("Copy absolute path"),
                            onAction: () =>
                              copyPath(
                                `${cache.summary?.root}/${contextMenu.path}`,
                                "absolute",
                              ),
                          },
                        ]
                      : []),
                  ],
                },
                {
                  id: "git",
                  title: "Git",
                  items: buildGitFileMenuItems(
                    contextMenu.entries,
                    contextMenu.directory,
                  ).map((item) => ({
                    id: `file:${item.action}`,
                    label: item.label,
                    danger: item.danger,
                    onAction: () => runGitFileMenuAction(item, contextMenu),
                  })),
                },
                {
                  id: "repository",
                  title: t("Repository"),
                  items: buildGitRepoMenuItems(workingCounts).map((item) => ({
                    id: `repo:${item.action}`,
                    label: item.label,
                    danger: item.danger,
                    disabled: item.count === 0,
                    description: String(item.count),
                    onAction: () => runGitRepoMenuAction(item),
                  })),
                },
              ]
            : []
        }
      />
      <ConfirmDialog
        open={!!confirmState}
        onOpenChange={(next) => {
          if (!next) setConfirmState(null);
        }}
        title={confirmState?.title ?? ""}
        message={confirmState?.message ?? ""}
        confirmLabel={confirmState?.confirmLabel ?? t("Confirm")}
        tone="danger"
        onConfirm={() => confirmState?.run()}
      />
    </aside>
  );
});

function DiffSkeleton() {
  return (
    <div className="diff-skeleton-list">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="diff-skeleton-row" key={index}>
          <span className="diff-skeleton-badge" />
          <span className="diff-skeleton-lines">
            <span className="diff-skeleton-line diff-skeleton-line-name" />
            <span className="diff-skeleton-line diff-skeleton-line-status" />
          </span>
        </div>
      ))}
    </div>
  );
}
