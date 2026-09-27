import {
  FileDiff,
  FolderTree,
  GitFork,
  History,
  Maximize2,
  Minimize2,
  PanelBottom,
  PanelRight,
} from "lucide-react";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ConnectionClient } from "../api";
import { thyraLocalStorage } from "../browserStorage";
import { t } from "../i18n";
import {
  type NewReviewAnnotation,
  type ReviewAnnotation,
} from "../annotations";
import { lazyWithReload } from "../lazyWithReload";
import { shortcutTitle, useShortcutPreferences } from "../shortcutPreferences";
import type { GitDiffEntry, Pane, Workspace } from "../types";
import {
  DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  inspectorNavigationRatioAtPosition,
  readInspectorPreferences,
  resourceOwnerKey,
  resourceStateKey,
  writeInspectorNavigationRatio,
  type InspectorDock,
  type InspectorSplitView,
  type InspectorView,
  type WorkspaceInspectorState,
} from "../workspaceResource";
import { AgentHistoryDrawer, SplitResizer } from "./AgentHistoryDrawer";
import { paneHasAgentHistory } from "./agentSession";
import {
  type ActiveDiffSelection,
  DiffViewerPanel,
  type DiffViewerPanelHandle,
  type DiffViewerPanelProps,
} from "./DiffViewerPanel";
import { FileExplorerPanel } from "./FileExplorerDialog";
import {
  type ActiveFilePreviewSelection,
  FilePreviewContent,
} from "./FilePreviewContent";
import { workspaceInspectorLayout } from "./workspaceInspectorLayout";
import { CloseButton } from "./ui/CloseButton";
import { IconButton } from "./ui/IconButton";
import { Tabs } from "./ui/Tabs";
import { Token } from "./ui/Token";
import "./WorkspaceInspectorHost.css";

const DiffContentView = lazyWithReload("diff-content-view", () =>
  import("./DiffContentView").then((module) => ({
    default: module.DiffContentView,
  })),
);

function changedCount(workspace?: Workspace) {
  const status = workspace?.worktree?.git_status;
  return status
    ? status.staged + status.unstaged + status.untracked + status.conflicted
    : 0;
}

function checkoutLabel(workspace?: Workspace) {
  if (!workspace) return t("Unavailable checkout");
  return (
    workspace.worktree?.git_status?.branch ||
    workspace.worktree?.repo_name ||
    workspace.label ||
    workspace.workspace_id
  );
}

const INSPECTOR_RESOURCE_HORIZONTAL_PADDING = 16;

export function WorkspaceInspectorHost({
  state,
  onReady,
  visible,
  workspace,
  historyPane,
  fileSelection,
  previewRequestRef,
  diffSelection,
  connectionClient,
  onFileSelectionChange,
  onDiffSelectionChange,
  onOpenDiffFile,
  annotations,
  onCreateAnnotation,
  onReanchorFileAnnotations,
  onReanchorDiffAnnotations,
  onEditAnnotation,
  onOpenDocument,
  onRefreshFile,
  onViewChange,
  onDockChange,
  onExpandedChange,
  onClose,
  onBack,
}: {
  state: WorkspaceInspectorState;
  onReady?: () => void;
  visible: boolean;
  workspace?: Workspace;
  historyPane?: Pane;
  fileSelection: ActiveFilePreviewSelection;
  previewRequestRef: React.MutableRefObject<number>;
  diffSelection: ActiveDiffSelection;
  connectionClient: ConnectionClient;
  onFileSelectionChange: Parameters<
    typeof FileExplorerPanel
  >[0]["onPreviewChange"];
  onDiffSelectionChange: DiffViewerPanelProps["onSelectionChange"];
  onOpenDocument: (path: string, fragment?: string) => void;
  onRefreshFile: () => void;
  onOpenDiffFile: (entry: ActiveDiffSelection["entry"]) => void;
  annotations: readonly ReviewAnnotation[];
  onCreateAnnotation: (input: NewReviewAnnotation) => void;
  onReanchorFileAnnotations: (path: string, text: string) => void;
  onReanchorDiffAnnotations: (
    path: string,
    kind: GitDiffEntry["kind"],
    patch: string,
  ) => void;
  onEditAnnotation: (id: string) => void;
  onViewChange: (view: InspectorView) => void;
  onDockChange: (dock: InspectorDock) => void;
  onExpandedChange: (expanded: boolean) => void;
  onClose: () => void;
  onBack: () => void;
}) {
  const hostRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    onReady?.();
  }, [onReady]);
  const diffViewerRef = useRef<DiffViewerPanelHandle | null>(null);
  const splitId = useId();
  const [hostWidth, setHostWidth] = useState(0);
  const [fileDiffState, setFileDiffState] = useState<{
    resourceKey: string;
    entries: GitDiffEntry[];
  }>(() => ({ resourceKey: "", entries: [] }));
  const [drillInByView, setDrillInByView] = useState<
    Record<InspectorView, boolean>
  >(() => ({
    files: state.view === "files" && !!fileSelection.entry,
    changes: false,
    history: false,
  }));
  const resourceKey = resourceOwnerKey(state.scope);
  const contentResourceKey = resourceStateKey(state.scope);
  const fileDiffEntries =
    fileDiffState.resourceKey === contentResourceKey
      ? fileDiffState.entries
      : [];
  const setFileDiffEntries = useCallback(
    (entries: GitDiffEntry[]) =>
      setFileDiffState({ resourceKey: contentResourceKey, entries }),
    [contentResourceKey],
  );
  const [navigationPreferences, setNavigationPreferences] = useState(() =>
    readInspectorPreferences(thyraLocalStorage, state.scope),
  );
  useShortcutPreferences();
  const defaultNavigationRatio = state.expanded
    ? inspectorNavigationRatioAtPosition(
        300,
        hostWidth - INSPECTOR_RESOURCE_HORIZONTAL_PADDING,
      )
    : DEFAULT_INSPECTOR_NAVIGATION_RATIO;
  const navigationRatios = {
    files: state.expanded
      ? (navigationPreferences.expandedNavigationRatios.files ??
        defaultNavigationRatio)
      : navigationPreferences.filesNavigationRatio,
    changes: state.expanded
      ? (navigationPreferences.expandedNavigationRatios.changes ??
        defaultNavigationRatio)
      : navigationPreferences.changesNavigationRatio,
  };
  const { compact, splitEnabled } = workspaceInspectorLayout(hostWidth);
  // The navigation/detail split is draggable whenever both panes fit side by
  // side, not only in the expanded layout, so docked inspectors can resize
  // the Files/Changes list too.
  const navigationIds = {
    files: `${splitId}-files-navigation`,
    changes: `${splitId}-changes-navigation`,
  };
  const detailIds = {
    files: `${splitId}-files-detail`,
    changes: `${splitId}-changes-detail`,
  };

  const setNavigationRatio = (view: InspectorSplitView, ratio: number) => {
    setNavigationPreferences((current) =>
      state.expanded
        ? {
            ...current,
            expandedNavigationRatios: {
              ...current.expandedNavigationRatios,
              [view]: ratio,
            },
          }
        : {
            ...current,
            [view === "files"
              ? "filesNavigationRatio"
              : "changesNavigationRatio"]: ratio,
          },
    );
  };
  const commitNavigationRatio = (view: InspectorSplitView, ratio: number) => {
    writeInspectorNavigationRatio(
      thyraLocalStorage,
      state.scope,
      view,
      ratio,
      state.expanded,
    );
  };
  const splitStyle = (view: InspectorSplitView) =>
    ({
      "--workspace-inspector-navigation-width": `${navigationRatios[view] * 100}%`,
    }) as CSSProperties;
  const changeCount = changedCount(workspace);
  const historyAvailable = paneHasAgentHistory(historyPane);
  const detailAvailable =
    state.view === "files"
      ? !!fileSelection.entry
      : state.view === "changes"
        ? !!diffSelection.entry
        : false;
  const hasDetail = detailAvailable && drillInByView[state.view];
  const fileChangesEntries = fileSelection.entry
    ? fileDiffEntries.filter(
        (entry) => entry.path === fileSelection.entry?.path,
      )
    : [];
  const primaryFileChangesEntry =
    fileChangesEntries[fileChangesEntries.length - 1] ?? null;
  const fileDiffSelectionMatches = fileChangesEntries.some(
    (entry) =>
      diffSelection.entry?.path === entry.path &&
      diffSelection.entry.kind === entry.kind,
  );
  const fileChangesKey = fileChangesEntries
    .map((entry) => `${entry.kind}:${entry.status}:${entry.path}`)
    .join("|");

  useEffect(() => {
    if (state.view !== "files" || !fileSelection.entry) return;
    setDrillInByView((current) => ({ ...current, files: true }));
  }, [fileSelection.entry, state.view]);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" || state.view !== "files") return;
    if (!(event.target as HTMLElement).matches("[role='tab']")) return;
    const treeItem = hostRef.current?.querySelector<HTMLElement>(
      ".inspector-files-resource .file-row[role='treeitem'][tabindex='0']",
    );
    if (!treeItem) return;
    event.preventDefault();
    treeItem.focus({ preventScroll: true });
    treeItem.scrollIntoView({ block: "nearest" });
  };

  useEffect(() => {
    const preferences = readInspectorPreferences(
      thyraLocalStorage,
      state.scope,
    );
    setNavigationPreferences(preferences);
  }, [contentResourceKey, state.scope]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setHostWidth(host.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <aside
      ref={hostRef}
      className={`workspace-inspector workspace-inspector-${state.dock} ${
        state.expanded ? "is-expanded" : ""
      } ${compact ? "is-compact" : ""} ${hasDetail ? "has-detail" : ""}`}
      aria-label={t("Workspace Inspector")}
      data-view={state.view}
    >
      <header className="workspace-inspector-head">
        <div className="workspace-inspector-identity">
          <span className="workspace-inspector-repo">
            {workspace?.worktree?.repo_name ||
              workspace?.label ||
              t("Workspace")}
          </span>
          <span className="workspace-inspector-checkout">
            {checkoutLabel(workspace)}
            {workspace?.worktree?.is_linked_worktree ? (
              <Token
                tone="accent"
                icon={<GitFork size={11} aria-hidden="true" />}
                title={t("Linked worktree")}
              >
                {t("Worktree")}
              </Token>
            ) : null}
          </span>
          {workspace?.worktree?.checkout_path || workspace?.cwd ? (
            <code
              className="workspace-inspector-path"
              title={workspace.worktree?.checkout_path ?? workspace.cwd}
            >
              {workspace.worktree?.checkout_path ?? workspace.cwd}
            </code>
          ) : null}
        </div>
        {/* ArrowDown from the Files tab enters the file tree; the other
            tab keys are handled by Tabs. */}
        <div className="workspace-inspector-tabs" onKeyDown={handleTabKeyDown}>
          <Tabs
            aria-label={t("Inspector view")}
            value={state.view}
            onChange={(view) => {
              if (view !== "history" || historyAvailable) onViewChange(view);
            }}
            items={[
              {
                id: "files",
                icon: <FolderTree size={14} />,
                label: t("Files"),
              },
              {
                id: "changes",
                icon: <FileDiff size={14} />,
                label: (
                  <>
                    {t("Changes")}
                    {changeCount > 0 ? (
                      <Token tone="warning">{changeCount}</Token>
                    ) : null}
                  </>
                ),
              },
              {
                id: "history",
                icon: <History size={14} />,
                label: (
                  <span
                    title={
                      historyAvailable
                        ? t("Agent history")
                        : t("Select an active agent pane to view history")
                    }
                  >
                    {t("History")}
                  </span>
                ),
                disabled: !historyAvailable && state.view !== "history",
              },
            ]}
          />
        </div>
        <div className="workspace-inspector-actions">
          <IconButton
            className="workspace-inspector-dock-action"
            label={
              state.dock === "right"
                ? t("Dock Inspector at bottom")
                : t("Dock Inspector at right")
            }
            tooltip={
              state.dock === "right" ? t("Dock at bottom") : t("Dock at right")
            }
            icon={
              state.dock === "right" ? (
                <PanelBottom size={15} />
              ) : (
                <PanelRight size={15} />
              )
            }
            onClick={() =>
              onDockChange(state.dock === "right" ? "bottom" : "right")
            }
          />
          <IconButton
            className="workspace-inspector-expand-action"
            label={
              state.expanded
                ? t("Restore Inspector dock")
                : t("Expand Inspector")
            }
            tooltip={shortcutTitle(
              state.expanded
                ? t("Restore Inspector dock")
                : t("Expand Inspector"),
              "inspector.expand",
            )}
            icon={
              state.expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />
            }
            aria-pressed={state.expanded}
            onClick={() => onExpandedChange(!state.expanded)}
          />
          <CloseButton
            label={t("Close Workspace Inspector")}
            tooltip={t("Close Inspector")}
            onClick={onClose}
          />
        </div>
      </header>

      {!workspace ? (
        <div className="workspace-inspector-unavailable">
          <strong>{t("Checkout unavailable")}</strong>
          <span>
            {t("The workspace used to route this Inspector is no longer open.")}
          </span>
        </div>
      ) : (
        <div className="workspace-inspector-body">
          <div
            className={`workspace-inspector-resource inspector-files-resource ${
              state.view === "files" ? "" : "is-hidden"
            } ${splitEnabled ? "has-split-resizer" : ""}`}
            style={splitEnabled ? splitStyle("files") : undefined}
          >
            <div
              id={navigationIds.files}
              className="workspace-inspector-navigation"
            >
              <FileExplorerPanel
                open
                workspaceId={workspace.workspace_id}
                resourceKey={resourceKey}
                initialDirectory={state.initialDirectory}
                activePath={fileSelection.entry?.path}
                previewRequestRef={previewRequestRef}
                keyboardActive={
                  state.view === "files" && (!compact || !hasDetail)
                }
                onClose={onClose}
                onPreviewChange={(selection, meta) => {
                  if (selection.entry && meta?.userInitiated) {
                    setDrillInByView((current) => ({
                      ...current,
                      files: true,
                    }));
                  }
                  onFileSelectionChange?.(selection, meta);
                }}
                onActiveDiffEntriesChange={setFileDiffEntries}
              />
            </div>
            {splitEnabled ? (
              <SplitResizer
                ratio={navigationRatios.files}
                resetRatio={defaultNavigationRatio}
                inset={INSPECTOR_RESOURCE_HORIZONTAL_PADDING}
                label={t("Resize file navigation")}
                controls={`${navigationIds.files} ${detailIds.files}`}
                onChange={(ratio) => setNavigationRatio("files", ratio)}
                onCommit={(ratio) => commitNavigationRatio("files", ratio)}
              />
            ) : null}
            <div id={detailIds.files} className="workspace-inspector-detail">
              <FilePreviewContent
                entry={fileSelection.entry}
                preview={fileSelection.preview}
                loading={fileSelection.loading}
                error={fileSelection.error}
                fragment={fileSelection.fragment}
                onOpenFile={onOpenDocument}
                onRefresh={onRefreshFile}
                backAction={
                  compact && drillInByView.files && fileSelection.entry
                    ? {
                        label: t("Files"),
                        onClick: () => {
                          setDrillInByView((current) => ({
                            ...current,
                            files: false,
                          }));
                          onBack();
                        },
                      }
                    : undefined
                }
                annotations={annotations}
                onCreateAnnotation={onCreateAnnotation}
                onReanchorAnnotations={onReanchorFileAnnotations}
                onOpenChanges={
                  primaryFileChangesEntry
                    ? () =>
                        diffViewerRef.current?.selectWorkingEntries(
                          fileChangesEntries,
                        )
                    : undefined
                }
                changesKey={fileChangesKey || undefined}
                changesContent={
                  primaryFileChangesEntry ? (
                    <Suspense
                      fallback={
                        <div className="diff-content-state">
                          <span className="file-loading-spinner" />
                          {t("Loading diff viewer")}
                        </div>
                      }
                    >
                      <DiffContentView
                        key={`${contentResourceKey}:file-changes`}
                        entry={
                          fileDiffSelectionMatches
                            ? diffSelection.entry
                            : primaryFileChangesEntry
                        }
                        file={
                          fileDiffSelectionMatches ? diffSelection.file : null
                        }
                        loading={
                          !fileDiffSelectionMatches || diffSelection.loading
                        }
                        error={
                          fileDiffSelectionMatches ? diffSelection.error : null
                        }
                        entries={fileChangesEntries}
                        files={
                          fileDiffSelectionMatches ? diffSelection.files : {}
                        }
                        fileErrors={
                          fileDiffSelectionMatches
                            ? diffSelection.fileErrors
                            : {}
                        }
                        resourceKey={`${contentResourceKey}:file:${fileChangesKey}`}
                        mobile={compact}
                        connectionClient={connectionClient}
                        annotations={annotations}
                        onCreateAnnotation={onCreateAnnotation}
                        onReanchorAnnotations={onReanchorDiffAnnotations}
                        onEditAnnotation={onEditAnnotation}
                        onSelectFile={(entry) =>
                          diffViewerRef.current?.selectWorkingEntry(entry)
                        }
                        embedded
                      />
                    </Suspense>
                  ) : undefined
                }
              />
            </div>
          </div>
          <div
            className={`workspace-inspector-resource inspector-changes-resource ${
              state.view === "changes" ? "" : "is-hidden"
            } ${splitEnabled ? "has-split-resizer" : ""}`}
            style={splitEnabled ? splitStyle("changes") : undefined}
          >
            <div
              id={navigationIds.changes}
              className="workspace-inspector-navigation"
            >
              <DiffViewerPanel
                ref={diffViewerRef}
                workspaceId={workspace.workspace_id}
                resourceKey={resourceKey}
                onOpenFile={onOpenDiffFile}
                onSelectionChange={(selection, meta) => {
                  if (selection.entry && meta?.userInitiated) {
                    setDrillInByView((current) => ({
                      ...current,
                      changes: true,
                    }));
                  }
                  onDiffSelectionChange?.(selection, meta);
                }}
              />
            </div>
            {splitEnabled ? (
              <SplitResizer
                ratio={navigationRatios.changes}
                resetRatio={defaultNavigationRatio}
                inset={INSPECTOR_RESOURCE_HORIZONTAL_PADDING}
                label={t("Resize file navigation")}
                controls={`${navigationIds.changes} ${detailIds.changes}`}
                onChange={(ratio) => setNavigationRatio("changes", ratio)}
                onCommit={(ratio) => commitNavigationRatio("changes", ratio)}
              />
            ) : null}
            <div id={detailIds.changes} className="workspace-inspector-detail">
              {state.view === "changes" ? (
                <Suspense
                  fallback={
                    <div className="diff-content-view">
                      <div className="diff-content-state">
                        <span className="file-loading-spinner" />
                        {t("Loading Diff Viewer")}
                      </div>
                    </div>
                  }
                >
                  <DiffContentView
                    key={contentResourceKey}
                    selectionRevision={diffSelection.selectionRevision}
                    entry={diffSelection.entry}
                    file={diffSelection.file}
                    loading={diffSelection.loading}
                    error={diffSelection.error}
                    entries={diffSelection.entries}
                    files={diffSelection.files}
                    fileErrors={diffSelection.fileErrors}
                    summaryLoading={diffSelection.summaryLoading}
                    mobile={compact}
                    resourceKey={contentResourceKey}
                    connectionClient={connectionClient}
                    annotations={annotations}
                    onCreateAnnotation={onCreateAnnotation}
                    onReanchorAnnotations={onReanchorDiffAnnotations}
                    onEditAnnotation={onEditAnnotation}
                    onSelectFile={(target) =>
                      diffViewerRef.current?.selectEntry(target)
                    }
                    onOpenFile={onOpenDiffFile}
                    backAction={
                      compact && hasDetail
                        ? {
                            label: t("Changed files"),
                            onClick: () => {
                              setDrillInByView((current) => ({
                                ...current,
                                changes: false,
                              }));
                              onBack();
                            },
                          }
                        : undefined
                    }
                  />
                </Suspense>
              ) : null}
            </div>
          </div>
          <div
            className={`workspace-inspector-resource inspector-history-resource ${
              state.view === "history" ? "" : "is-hidden"
            }`}
          >
            {historyAvailable && historyPane ? (
              <AgentHistoryDrawer
                pane={historyPane}
                open={visible && state.open && state.view === "history"}
                embedded
                wide={!compact}
                onOpenChange={(open) => {
                  if (!open) onClose();
                }}
              />
            ) : (
              <div className="workspace-inspector-unavailable">
                <strong>{t("No active agent session")}</strong>
                <span>{t("Select an agent pane to inspect its history.")}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
