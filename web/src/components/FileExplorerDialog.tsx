import { useEffect, useMemo, useRef, useState } from "react";
import { thyraLocalStorage } from "../browserStorage";
import { useHostCapable, workspaceCan } from "../capabilities";
import { connectionStorageKey } from "../connectionStorage";
import { t } from "../i18n";
import {
  refreshGitDiffSummary,
  useGitDiffSummaryState,
} from "../inspectorQueries";
import { useStoreSelector } from "../store";
import type { FileExplorerEntry, GitDiffEntry } from "../types";
import { useConnectionClient } from "../useConnectionClient";
import type {
  ActiveFilePreviewSelection,
  FilePreviewSelectionMeta,
} from "./FilePreviewContent";
import {
  FILE_SHOW_HIDDEN_PREFIX,
  buildGitStatusMaps,
  explorerRuntimeContextKey,
  filePreviewCacheKey,
  initialWorkspacePath,
  invalidateFilePreviewCache,
  isExplorerDirectoryEntry,
  isFilesystemPath,
  readCachedPreview,
  readExplorerViewMemory,
  requestFilePreview,
  writeExplorerViewMemory,
} from "./fileExplorerResources";
import { FileManager, type FileManagerChange } from "./files/FileManager";
import { SegmentedControl } from "./ui/SegmentedControl";
import "./FileExplorerDialog.css";

export { isExplorerDirectoryEntry };

type PreviewChange = (
  selection: ActiveFilePreviewSelection,
  meta?: FilePreviewSelectionMeta,
) => void;

export function FileExplorerPanel(props: {
  open: boolean;
  workspaceId?: string;
  resourceKey?: string;
  initialDirectory?: string;
  activePath?: string;
  previewRequestRef?: React.MutableRefObject<number>;
  keyboardActive?: boolean;
  /** Unused: the Inspector that hosts the explorer owns closing. */
  onClose?: () => void;
  onPreviewChange?: PreviewChange;
  onActiveDiffEntriesChange?: (entries: GitDiffEntry[]) => void;
}) {
  if (!props.open) return null;
  return (
    <aside className="file-explorer-side" aria-label={t("File Explorer")}>
      <FileExplorerContent {...props} />
    </aside>
  );
}

/**
 * The Inspector's Files view: a workspace/filesystem scope switch over the
 * file manager, plus the preview requests its file selections start.
 */
function FileExplorerContent({
  workspaceId,
  resourceKey,
  initialDirectory,
  previewRequestRef,
  activePath,
  keyboardActive = false,
  onPreviewChange,
  onActiveDiffEntriesChange,
}: Parameters<typeof FileExplorerPanel>[0]) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const client = useConnectionClient();
  const workspace = workspaceId
    ? workspaces.find((w) => w.workspace_id === workspaceId)
    : workspaces.find((w) => w.focused);
  // Viewers (and share-link guests) browse and download, never write.
  const readOnly = !workspaceCan(workspace, "edit");
  const host = useHostCapable();
  const cacheWorkspaceId = workspace?.workspace_id;
  const cacheResourceKey = resourceKey ?? cacheWorkspaceId ?? "focused";
  const showHiddenKey = connectionStorageKey(
    client.connectionId,
    `${FILE_SHOW_HIDDEN_PREFIX}${cacheResourceKey}`,
  );
  const [showHidden, setShowHidden] = useState(
    () => thyraLocalStorage.getItem(showHiddenKey) === "true",
  );
  useEffect(() => {
    thyraLocalStorage.setItem(showHiddenKey, String(showHidden));
  }, [showHidden, showHiddenKey]);

  const runtimeContext = explorerRuntimeContextKey(
    client,
    cacheWorkspaceId,
    cacheResourceKey,
  );
  // An explicit host directory (for example an agent cwd outside the checkout)
  // opens Filesystem mode there. Record it before the mode state initializes.
  const initialFilesystemDirectory =
    initialDirectory && isFilesystemPath(initialDirectory)
      ? initialDirectory
      : null;
  const initialDirectoryKey = initialFilesystemDirectory
    ? `${runtimeContext}\n${initialFilesystemDirectory}`
    : null;
  const appliedInitialDirectory = useRef<string | null>(null);
  if (
    initialDirectoryKey &&
    appliedInitialDirectory.current !== initialDirectoryKey
  ) {
    appliedInitialDirectory.current = initialDirectoryKey;
    writeExplorerViewMemory(runtimeContext, {
      mode: "filesystem",
      directory: initialFilesystemDirectory ?? undefined,
    });
  }
  // Filesystem mode is view-local: remembered for this session per connection
  // and workspace, never persisted, and never a permission for other views.
  const [filesystemContext, setFilesystemContext] = useState<string | null>(
    () =>
      readExplorerViewMemory(runtimeContext).mode === "filesystem"
        ? runtimeContext
        : null,
  );
  useEffect(() => {
    setFilesystemContext(
      readExplorerViewMemory(runtimeContext).mode === "filesystem"
        ? runtimeContext
        : null,
    );
  }, [runtimeContext, initialDirectoryKey]);
  const filesystem = host && filesystemContext === runtimeContext;
  const setMode = (mode: "workspace" | "filesystem") => {
    writeExplorerViewMemory(runtimeContext, { mode });
    setFilesystemContext(mode === "filesystem" ? runtimeContext : null);
  };

  const gitSummary = useGitDiffSummaryState(
    client,
    cacheWorkspaceId,
    "working",
    cacheResourceKey,
  );
  // Git paths map onto the checkout's real path, which the first listing
  // reports; workspaces without a checkout path learn their root from it too.
  const [realRoot, setRealRoot] = useState<string | null>(null);
  const rootPath = initialWorkspacePath(workspace) || realRoot || "";
  const gitStatus = useMemo(
    () => buildGitStatusMaps(gitSummary.summary, realRoot ?? rootPath),
    [gitSummary.summary, realRoot, rootPath],
  );
  const activeDiffEntries = useMemo(
    () =>
      activePath ? (gitStatus.fileStatuses.get(activePath)?.entries ?? []) : [],
    [activePath, gitStatus],
  );
  useEffect(() => {
    onActiveDiffEntriesChange?.(activeDiffEntries);
  }, [activeDiffEntries, onActiveDiffEntriesChange]);

  const refreshGit = () => {
    if (!cacheWorkspaceId || !client.isCurrent()) return;
    void refreshGitDiffSummary(
      client,
      cacheWorkspaceId,
      "working",
      cacheResourceKey,
      { afterCurrent: true },
    ).catch(() => {
      // Git status is supplementary; keep the file explorer usable on failure.
    });
  };
  useEffect(refreshGit, [cacheWorkspaceId, cacheResourceKey, client]);

  // Links, quick-open and explorer selections retire each other at start,
  // before either the cached preview or a deferred response is published.
  const ownSequence = useRef(0);
  const sequence = previewRequestRef ?? ownSequence;
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const loadPreview = async (entry: FileExplorerEntry) => {
    if (!cacheWorkspaceId || isExplorerDirectoryEntry(entry)) return;
    onActiveDiffEntriesChange?.(
      gitStatus.fileStatuses.get(entry.path)?.entries ?? [],
    );
    const id = ++sequence.current;
    const current = () => client.isCurrent() && sequence.current === id;
    const meta = { userInitiated: true };
    setPreviewPath(entry.path);
    const cached = readCachedPreview(
      filePreviewCacheKey(client, cacheWorkspaceId, entry.path),
    );
    onPreviewChange?.(
      { entry, preview: cached ?? null, loading: !cached, error: null },
      meta,
    );
    try {
      const preview = await requestFilePreview(cacheWorkspaceId, entry.path, {
        refresh: Boolean(cached),
        client,
      });
      if (current()) {
        onPreviewChange?.(
          { entry, preview, loading: false, error: null },
          meta,
        );
      }
    } catch (reason) {
      if (current() && !cached) {
        onPreviewChange?.(
          {
            entry,
            preview: null,
            loading: false,
            error: (reason as Error).message,
          },
          meta,
        );
      }
    }
  };

  const onChanged = ({ paths, removed, moved }: FileManagerChange) => {
    if (!cacheWorkspaceId) return;
    const selection = activePath ?? previewPath;
    let affected = false;
    for (const path of paths) {
      invalidateFilePreviewCache(client, cacheWorkspaceId, path, true);
      if (selection === path || selection?.startsWith(`${path}/`)) {
        affected = true;
      }
    }
    if (!filesystem) refreshGit();
    if (!affected || !selection) return;
    // A renamed or moved preview follows its file to the new path.
    const move = moved?.find(
      (item) =>
        selection === item.from || selection.startsWith(`${item.from}/`),
    );
    const next = move
      ? `${move.path}${selection.slice(move.from.length)}`
      : removed
        ? null
        : selection;
    if (!next) {
      sequence.current += 1;
      setPreviewPath(null);
      onPreviewChange?.(
        { entry: null, preview: null, loading: false, error: null },
        { userInitiated: true },
      );
      return;
    }
    void loadPreview({
      name: next.split("/").pop() ?? next,
      path: next,
      type: "file",
      size: 0,
      mtime_ms: 0,
      hidden: false,
    });
  };

  if (!workspace) {
    return <p className="modal-error">{t("No workspace is focused.")}</p>;
  }
  const rootLabel =
    workspace.worktree?.repo_name || workspace.label || rootPath;
  return (
    <div className="file-explorer-content">
      {host ? (
        <div className="ui-bar file-explorer-modebar">
          {/* Browsing the whole host is an instance-admin action. */}
          <SegmentedControl
            className="file-explorer-mode-switch"
            aria-label={t("Explorer scope")}
            value={filesystem ? "filesystem" : "workspace"}
            onChange={setMode}
            options={[
              {
                value: "workspace",
                label: t("Workspace"),
                title: t("Browse this workspace checkout"),
              },
              {
                value: "filesystem",
                label: t("Filesystem"),
                title: t("Browse any path on the connected host"),
              },
            ]}
          />
          <span className="file-explorer-mode-root" title={rootPath}>
            {rootPath}
          </span>
        </div>
      ) : null}
      <FileManager
        key={
          filesystem
            ? (initialDirectoryKey ?? `${runtimeContext}:fs`)
            : runtimeContext
        }
        client={client}
        workspaceId={workspace.workspace_id}
        scope={filesystem ? "filesystem" : "workspace"}
        resourceKey={cacheResourceKey}
        rootPath={rootPath}
        rootLabel={rootLabel}
        memoryContext={runtimeContext}
        initialLocation={initialFilesystemDirectory ?? rootPath}
        readOnly={readOnly}
        showHidden={showHidden}
        onShowHiddenChange={setShowHidden}
        activePath={activePath ?? previewPath ?? undefined}
        keyboardActive={keyboardActive}
        gitStatus={filesystem ? undefined : gitStatus}
        onOpenFile={(entry) => void loadPreview(entry)}
        onChanged={onChanged}
        onRootResolved={filesystem ? undefined : setRealRoot}
      />
    </div>
  );
}
