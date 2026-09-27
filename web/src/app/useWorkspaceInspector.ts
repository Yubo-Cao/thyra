import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ConnectionClient } from "../api";
import { thyraLocalStorage } from "../browserStorage";
import { paneHasAgentHistory } from "../components/agentSession";
import { focusIfUnchanged } from "../components/dialogFocus";
import { clearDiffContentResourceState } from "../components/diffContentState";
import type { ActiveDiffSelection } from "../components/diffViewerResources";
import type { ActiveFilePreviewSelection } from "../components/FilePreviewContent";
import type { TerminalWorkspaceFileRequest } from "../components/TerminalView";
import { t } from "../i18n";
import { activePaneIdForSnapshot } from "../paneJump";
import {
  type State,
  store,
  WORKTREE_REMOVED_EVENT,
  type WorktreeRemovedTarget,
} from "../store";
import type { FileExplorerEntry, Pane } from "../types";
import {
  type InspectorView,
  inspectorMaximumSize,
  readInspectorPreferences,
  readResourceFileSelection,
  relativePathWithinCheckout,
  resolveWorkspaceForScope,
  resourceOwnerKey,
  resourceScopeForWorkspace,
  resourceStateKey,
  sameResourceOwner,
  WORKSPACE_INSPECTOR_REQUEST_EVENT,
  type WorkspaceInspectorRequest,
  type WorkspaceInspectorState,
  writeInspectorPreferences,
  writeResourceFileSelection,
} from "../workspaceResource";
import { diffViewerResources, fileExplorerResources } from "./lazySurfaces";
import type { MobileView } from "./useShellLayout";

type OpenInspectorOptions = {
  entry?: FileExplorerEntry;
  path?: string;
  fragment?: string;
  initialDirectory?: string;
  originPaneId?: string;
  focusInspector?: boolean;
};

export function emptyActiveDiffSelection(): ActiveDiffSelection {
  return {
    entry: null,
    file: null,
    loading: false,
    error: null,
    entries: [],
    files: {},
    fileErrors: {},
    summaryLoading: false,
  };
}

export function emptyActiveFilePreviewSelection(): ActiveFilePreviewSelection {
  return { entry: null, preview: null, loading: false, error: null };
}

/** A file entry for a path the inspector opens without a directory listing. */
export function fileEntry(path: string): FileExplorerEntry {
  const name = path.split("/").filter(Boolean).pop() ?? path;
  return {
    name,
    path,
    type: "file",
    size: 0,
    mtime_ms: 0,
    hidden: name.startsWith("."),
  };
}

/** The focused workspace and its resource scope on this connection. */
function focusedWorkspaceScope(connectionId: string) {
  const workspace = store.get().workspaces.find((w) => w.focused);
  return workspace
    ? { workspace, scope: resourceScopeForWorkspace(connectionId, workspace) }
    : null;
}

/** The pane History follows in a workspace: the routed pane, else any agent. */
function historyPaneIn(
  snapshot: Pick<State, "layout" | "panes" | "selectedPaneId">,
  workspaceId: string,
  preferred?: Pane,
) {
  const activePaneId = activePaneIdForSnapshot(snapshot);
  const panes = snapshot.panes.filter(
    (pane) => pane.workspace_id === workspaceId,
  );
  const routedPane =
    preferred ??
    panes.find((pane) => pane.pane_id === activePaneId) ??
    panes.find((pane) => pane.focused);
  return paneHasAgentHistory(routedPane)
    ? routedPane
    : panes.find(paneHasAgentHistory);
}

/**
 * The Workspace Inspector (Files, Changes, History): which workspace and view
 * it shows, where it docks, its file/diff selections, and how it follows
 * workspace, tab, and connection changes.
 */
export function useWorkspaceInspector({
  s,
  connectionClient,
  resourceUiKey,
  mobile,
  setMobileView,
  activePane,
  startupReady,
}: {
  s: Pick<
    State,
    | "layout"
    | "lastRefresh"
    | "panes"
    | "pendingFocusWorkspaceId"
    | "selectedPaneId"
    | "status"
    | "workspaces"
  >;
  connectionClient: ConnectionClient;
  resourceUiKey: string;
  mobile: boolean;
  setMobileView: (view: MobileView) => void;
  activePane: Pane | undefined;
  startupReady: boolean;
}) {
  const [state, setState] = useState<WorkspaceInspectorState | null>(null);
  const stateRef = useRef<WorkspaceInspectorState | null>(null);
  const focusRequestRef = useRef<{
    state: WorkspaceInspectorState;
    source: Element | null;
  } | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const pendingRequestRef = useRef<WorkspaceInspectorRequest | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [activeDiff, setActiveDiff] = useState<ActiveDiffSelection>(
    emptyActiveDiffSelection,
  );
  const [activeFilePreview, setActiveFilePreview] =
    useState<ActiveFilePreviewSelection>(emptyActiveFilePreviewSelection);
  const previewRequestRef = useRef(0);
  const focusedWorkspace = s.workspaces.find((w) => w.focused);

  const finishFocus = useCallback(() => {
    const request = focusRequestRef.current;
    if (!request) return;
    if (stateRef.current !== request.state || !request.state.open) {
      focusRequestRef.current = null;
      return;
    }
    const target = document.querySelector<HTMLElement>(
      '.workspace-inspector-tabs [role="tab"][aria-selected="true"]',
    );
    if (focusIfUnchanged(target, request.source)) {
      focusRequestRef.current = null;
    }
  }, []);
  const commit = useCallback((next: WorkspaceInspectorState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const commitAndSave = useCallback(
    (next: WorkspaceInspectorState) => {
      commit(next);
      writeInspectorPreferences(thyraLocalStorage, next);
    },
    [commit],
  );
  /** Forget the inspector and its selections (workspace or connection gone). */
  const reset = useCallback(() => {
    previewRequestRef.current += 1;
    returnFocusRef.current = null;
    commit(null);
    setActiveDiff(emptyActiveDiffSelection());
    setActiveFilePreview(emptyActiveFilePreviewSelection());
    setMobileView("session");
  }, [commit, setMobileView]);

  const activateTerminalSurface = useCallback(() => {
    const current = stateRef.current;
    commit(current ? { ...current, open: false } : current);
    setMobileView("session");
    if (!mobile) {
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            ":is(.pane-layout-cell.is-active,.pane-switcher-layout,.workspace-terminal-surface>.terminal-shell) .xterm-helper-textarea",
          )
          ?.focus();
      });
    }
  }, [commit, mobile, setMobileView]);
  const loadFilePreview = useCallback(
    (workspaceId: string, entry: FileExplorerEntry, fragment?: string) => {
      const requestId = previewRequestRef.current + 1;
      previewRequestRef.current = requestId;
      const settle = (
        selection: Pick<ActiveFilePreviewSelection, "preview" | "error">,
      ) => {
        if (
          connectionClient.isCurrent() &&
          previewRequestRef.current === requestId
        ) {
          setActiveFilePreview({
            entry,
            fragment,
            loading: false,
            ...selection,
          });
        }
      };
      setActiveFilePreview({
        entry,
        fragment,
        preview: null,
        loading: true,
        error: null,
      });
      void fileExplorerResources()
        .then(({ requestFilePreview }) =>
          requestFilePreview(workspaceId, entry.path, {
            client: connectionClient,
            refresh: true,
          }),
        )
        .then(
          (preview) => settle({ preview, error: null }),
          (error) =>
            settle({
              preview: null,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
    },
    [connectionClient],
  );
  const open = useCallback(
    (
      view: InspectorView,
      workspaceId?: string,
      options: OpenInspectorOptions = {},
    ) => {
      const snapshot = store.get();
      const workspace = workspaceId
        ? snapshot.workspaces.find(
            (candidate) => candidate.workspace_id === workspaceId,
          )
        : snapshot.workspaces.find((candidate) => candidate.focused);
      if (!workspace) {
        store.notify({
          kind: "error",
          message:
            view === "files"
              ? t("Cannot open Files")
              : view === "changes"
                ? t("Cannot open Changes")
                : t("Cannot open History"),
          detail: t("The target workspace is no longer open."),
        });
        return;
      }

      const focusInspector = options.focusInspector ?? true;
      returnFocusRef.current =
        focusInspector && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const scope = resourceScopeForWorkspace(
        connectionClient.connectionId,
        workspace,
      );
      const current = stateRef.current;
      const sameOwner = !!current && sameResourceOwner(current.scope, scope);
      const stageWidth = stageRef.current?.clientWidth ?? 0;
      const preferences = readInspectorPreferences(thyraLocalStorage, scope, {
        rightSize: stageWidth > 0 ? stageWidth * 0.42 : undefined,
      });
      const dock = sameOwner ? current.dock : preferences.dock;
      const preferredSize = sameOwner
        ? current.size
        : dock === "right"
          ? preferences.rightSize
          : preferences.bottomSize;
      const stageHeight = stageRef.current?.clientHeight ?? 0;
      const clampToDock =
        (dock === "right" && stageWidth >= 1000) ||
        (dock === "bottom" && stageHeight > 0);
      const size = clampToDock
        ? Math.min(
            preferredSize,
            inspectorMaximumSize(dock, stageWidth, stageHeight),
          )
        : preferredSize;
      const originPane = options.originPaneId
        ? snapshot.panes.find((pane) => pane.pane_id === options.originPaneId)
        : snapshot.panes.find(
            (pane) =>
              pane.workspace_id === workspace.workspace_id && pane.focused,
          );
      const returnTabId =
        originPane?.tab_id ?? workspace.active_tab_id ?? current?.returnTabId;
      const nextState: WorkspaceInspectorState = {
        scope,
        open: true,
        view,
        dock,
        size,
        expanded: sameOwner ? current.expanded : preferences.expanded,
        returnTabId,
        originPaneId: options.originPaneId,
        initialDirectory: options.initialDirectory,
      };

      if (!workspace.focused) void store.focusWorkspace(workspace.workspace_id);
      if (!sameOwner) {
        previewRequestRef.current += 1;
        setActiveDiff(emptyActiveDiffSelection());
        setActiveFilePreview(emptyActiveFilePreviewSelection());
      }
      focusRequestRef.current = focusInspector
        ? { state: nextState, source: document.activeElement }
        : null;
      commitAndSave(nextState);
      if (mobile) setMobileView(view);
      if (focusInspector) requestAnimationFrame(finishFocus);

      const selectedPath =
        options.path ??
        (view === "files" && options.initialDirectory === undefined
          ? readResourceFileSelection(thyraLocalStorage, scope)
          : undefined);
      if (view === "files" && !selectedPath) {
        previewRequestRef.current += 1;
        setActiveFilePreview(emptyActiveFilePreviewSelection());
      }
      if (view !== "files" || !selectedPath) return;
      loadFilePreview(
        workspace.workspace_id,
        options.entry ?? fileEntry(selectedPath),
        options.fragment,
      );
    },
    [
      commitAndSave,
      connectionClient.connectionId,
      finishFocus,
      loadFilePreview,
      mobile,
      setMobileView,
    ],
  );
  const openFileExplorer = useCallback(
    (workspaceId?: string) => open("files", workspaceId),
    [open],
  );
  const openFileExplorerFile = useCallback(
    (
      workspaceId: string,
      entry: FileExplorerEntry,
      originPaneId?: string,
      fragment?: string,
    ) =>
      open("files", workspaceId, {
        entry,
        path: entry.path,
        originPaneId,
        fragment,
      }),
    [open],
  );
  const openDiffViewer = useCallback(
    (workspaceId?: string) => open("changes", workspaceId),
    [open],
  );
  const close = useCallback(() => {
    const current = stateRef.current;
    if (!current) return;
    const returnFocus = returnFocusRef.current;
    returnFocusRef.current = null;
    commit({ ...current, open: false });
    setMobileView("session");
    const snapshot = store.get();
    const returnTab = current.returnTabId
      ? snapshot.tabs.find((tab) => tab.tab_id === current.returnTabId)
      : undefined;
    const workspace = resolveWorkspaceForScope(
      current.scope,
      snapshot.workspaces,
    );
    const tabId = returnTab?.tab_id ?? workspace?.active_tab_id;
    const restoreControlFocus = () => {
      if (!returnFocus?.isConnected) return;
      requestAnimationFrame(() => returnFocus.focus());
    };
    if (tabId) {
      void Promise.resolve(store.focusTab(tabId)).finally(restoreControlFocus);
    } else {
      restoreControlFocus();
    }
  }, [commit, setMobileView]);
  const setAgentHistoryOpen = useCallback(
    (openHistory: boolean, pane?: Pane) => {
      const current = stateRef.current;
      if (!openHistory) {
        if (current?.open && current.view === "history") close();
        return;
      }
      const snapshot = store.get();
      const paneId = pane?.pane_id ?? activePaneIdForSnapshot(snapshot);
      const targetPane = paneId
        ? snapshot.panes.find((candidate) => candidate.pane_id === paneId)
        : undefined;
      if (
        !paneHasAgentHistory(targetPane) ||
        !snapshot.workspaces.some(
          (workspace) => workspace.workspace_id === targetPane.workspace_id,
        )
      ) {
        store.notify({
          kind: "error",
          message: t("Cannot open History"),
          detail: t("Select an active agent pane first."),
        });
        return;
      }
      open("history", targetPane.workspace_id, {
        originPaneId: targetPane.pane_id,
      });
    },
    [close, open],
  );
  const toggle = useCallback(() => {
    const current = stateRef.current;
    if (current?.open) {
      close();
      return;
    }
    const focused = focusedWorkspaceScope(connectionClient.connectionId);
    if (!focused) return;
    const { workspace, scope } = focused;
    const snapshot = store.get();
    const sameOwner = !!current && sameResourceOwner(current.scope, scope);
    const view = sameOwner
      ? current.view
      : readInspectorPreferences(thyraLocalStorage, scope).view;
    const historyPaneId =
      sameOwner && current.originPaneId
        ? current.originPaneId
        : activePaneIdForSnapshot(snapshot);
    const historyPane = historyPaneId
      ? snapshot.panes.find((pane) => pane.pane_id === historyPaneId)
      : undefined;
    if (
      view === "history" &&
      (!paneHasAgentHistory(historyPane) ||
        historyPane?.workspace_id !== workspace.workspace_id)
    ) {
      open("files", workspace.workspace_id);
      return;
    }
    open(view, workspace.workspace_id, {
      originPaneId: view === "history" ? historyPane?.pane_id : undefined,
    });
  }, [close, connectionClient.connectionId, open]);
  /** Toggle Files or Changes for the focused workspace, without focusing it. */
  const toggleView = useCallback(
    (view: "files" | "changes") => {
      const focused = focusedWorkspaceScope(connectionClient.connectionId);
      if (!focused) return;
      const current = stateRef.current;
      if (
        current?.open &&
        current.view === view &&
        sameResourceOwner(current.scope, focused.scope)
      ) {
        close();
        return;
      }
      open(view, focused.workspace.workspace_id, { focusInspector: false });
    },
    [close, connectionClient.connectionId, open],
  );
  const setExpanded = useCallback(
    (expanded: boolean) => {
      const current = stateRef.current;
      if (!current) return;
      const next = { ...current, expanded };
      if (focusRequestRef.current?.state === current)
        focusRequestRef.current.state = next;
      commitAndSave(next);
    },
    [commitAndSave],
  );
  const keepForWorkspace = useCallback(
    (workspaceId: string, originPane?: Pane) => {
      const current = stateRef.current;
      if (!current?.open) {
        activateTerminalSurface();
        return;
      }
      const snapshot = store.get();
      const explicitPane = originPane
        ? snapshot.panes.find(
            (candidate) => candidate.pane_id === originPane.pane_id,
          )
        : undefined;
      const historyPane = historyPaneIn(snapshot, workspaceId, explicitPane);
      const view =
        current.view === "history" && !historyPane ? "files" : current.view;
      open(view, workspaceId, {
        focusInspector: false,
        originPaneId:
          explicitPane?.pane_id ??
          (view === "history" ? historyPane?.pane_id : undefined),
      });
    },
    [activateTerminalSurface, open],
  );
  const browseFilesForPane = useCallback(
    (pane: Pane) => {
      const workspace = store
        .get()
        .workspaces.find(
          (candidate) => candidate.workspace_id === pane.workspace_id,
        );
      if (!workspace) return;
      const root = workspace.worktree?.checkout_path ?? workspace.cwd;
      const cwd = pane.foreground_cwd ?? pane.cwd;
      // A cwd outside the checkout opens the explorer's Filesystem mode there.
      const initialDirectory =
        (root ? relativePathWithinCheckout(root, cwd) : undefined) ??
        (cwd || undefined);
      open("files", workspace.workspace_id, {
        originPaneId: pane.pane_id,
        initialDirectory,
      });
    },
    [open],
  );
  const reviewChangesForPane = useCallback(
    (pane: Pane) =>
      open("changes", pane.workspace_id, { originPaneId: pane.pane_id }),
    [open],
  );
  const openTerminalWorkspaceFile = useCallback(
    (request: TerminalWorkspaceFileRequest) => {
      if (
        request.connectionId !== connectionClient.connectionId ||
        request.connectionGeneration !== connectionClient.generation ||
        !connectionClient.isCurrent()
      ) {
        return;
      }
      openFileExplorerFile(
        request.workspaceId,
        fileEntry(request.path),
        request.paneId,
      );
    },
    [connectionClient, openFileExplorerFile],
  );
  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceInspectorRequest>).detail;
      if (
        !detail ||
        detail.connectionId !== connectionClient.connectionId ||
        detail.generation !== connectionClient.generation ||
        !connectionClient.isCurrent()
      ) {
        return;
      }
      const workspace = store
        .get()
        .workspaces.find(
          (candidate) => candidate.workspace_id === detail.workspaceId,
        );
      if (!workspace) {
        pendingRequestRef.current = detail;
        return;
      }
      pendingRequestRef.current = null;
      open(detail.view, detail.workspaceId);
    };
    window.addEventListener(WORKSPACE_INSPECTOR_REQUEST_EVENT, handleRequest);
    return () =>
      window.removeEventListener(
        WORKSPACE_INSPECTOR_REQUEST_EVENT,
        handleRequest,
      );
  }, [connectionClient, open]);
  useEffect(() => {
    const pending = pendingRequestRef.current;
    if (!pending) return;
    if (
      pending.connectionId !== connectionClient.connectionId ||
      pending.generation !== connectionClient.generation
    ) {
      pendingRequestRef.current = null;
      return;
    }
    if (
      !s.workspaces.some(
        (workspace) => workspace.workspace_id === pending.workspaceId,
      )
    ) {
      return;
    }
    pendingRequestRef.current = null;
    open(pending.view, pending.workspaceId);
  }, [connectionClient, open, s.workspaces]);
  useEffect(() => {
    const handleWorktreeRemoved = (event: Event) => {
      const detail = (event as CustomEvent<WorktreeRemovedTarget>).detail;
      if (
        !detail ||
        detail.connectionId !== connectionClient.connectionId ||
        detail.generation !== connectionClient.generation ||
        !connectionClient.isCurrent()
      ) {
        return;
      }
      const scope = resourceScopeForWorkspace(
        detail.connectionId,
        detail.workspace,
      );
      const resourceKey = resourceOwnerKey(scope);
      void fileExplorerResources().then((resources) =>
        resources.clearFileExplorerResourceCache(
          connectionClient,
          resourceKey,
          thyraLocalStorage,
        ),
      );
      clearDiffContentResourceState(resourceStateKey(scope));
      void diffViewerResources().then((resources) =>
        resources.clearDiffViewerResourceCache(
          connectionClient,
          resourceKey,
          thyraLocalStorage,
        ),
      );
      writeResourceFileSelection(thyraLocalStorage, scope, null);
      const current = stateRef.current;
      if (current && sameResourceOwner(current.scope, scope)) reset();
    };
    window.addEventListener(WORKTREE_REMOVED_EVENT, handleWorktreeRemoved);
    return () =>
      window.removeEventListener(WORKTREE_REMOVED_EVENT, handleWorktreeRemoved);
  }, [connectionClient, reset]);

  const resourceKeyRef = useRef(resourceUiKey);
  useLayoutEffect(() => {
    if (resourceKeyRef.current === resourceUiKey) return;
    resourceKeyRef.current = resourceUiKey;
    pendingRequestRef.current = null;
    reset();
  }, [reset, resourceUiKey]);
  useEffect(() => {
    if (!mobile) return;
    const current = stateRef.current;
    setMobileView(current?.open ? current.view : "session");
  }, [mobile, setMobileView]);
  useLayoutEffect(() => {
    const current = stateRef.current;
    if (!current?.open || !focusedWorkspace || s.pendingFocusWorkspaceId) {
      return;
    }
    const routedWorkspace = resolveWorkspaceForScope(
      current.scope,
      s.workspaces,
    );
    if (routedWorkspace?.workspace_id === focusedWorkspace.workspace_id) return;
    keepForWorkspace(focusedWorkspace.workspace_id);
  }, [
    focusedWorkspace,
    keepForWorkspace,
    s.pendingFocusWorkspaceId,
    s.workspaces,
  ]);
  // Follow tab switches while History is open: the view pins its session to
  // originPaneId, which tab changes never update on their own. Pane focus
  // changes within the same tab keep the current pin.
  const historyTabRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const current = stateRef.current;
    const workspace =
      current?.open && current.view === "history"
        ? resolveWorkspaceForScope(current.scope, s.workspaces)
        : undefined;
    const activeTabId = workspace?.active_tab_id ?? null;
    const previousTabId = historyTabRef.current;
    historyTabRef.current = activeTabId;
    if (!current?.open || current.view !== "history" || !workspace) return;
    if (s.pendingFocusWorkspaceId) return;
    const originMissing =
      !!current.originPaneId &&
      !s.panes.some((pane) => pane.pane_id === current.originPaneId);
    const tabSwitched =
      previousTabId !== null &&
      activeTabId !== null &&
      previousTabId !== activeTabId;
    if (!originMissing && !tabSwitched) return;
    const historyPane = historyPaneIn(s, workspace.workspace_id);
    if (!historyPane || historyPane.pane_id === current.originPaneId) return;
    commit({ ...current, originPaneId: historyPane.pane_id });
  }, [commit, s]);
  useLayoutEffect(() => {
    const current = stateRef.current;
    if (!current) return;
    const workspace = resolveWorkspaceForScope(current.scope, s.workspaces);
    if (!workspace) {
      if (s.status === "connected" && s.lastRefresh > 0) reset();
      return;
    }
    if (workspace.workspace_id === current.scope.workspaceId) return;
    const scope = resourceScopeForWorkspace(
      connectionClient.connectionId,
      workspace,
    );
    commit({ ...current, scope });
    if (current.view === "files" && activeFilePreview.entry) {
      loadFilePreview(workspace.workspace_id, activeFilePreview.entry);
    }
  }, [
    activeFilePreview.entry,
    commit,
    connectionClient,
    loadFilePreview,
    reset,
    s.lastRefresh,
    s.status,
    s.workspaces,
  ]);
  const stateKey = state ? resourceStateKey(state.scope) : null;
  useEffect(() => {
    const current = stateRef.current;
    if (!current || !activeFilePreview.entry?.path) return;
    writeResourceFileSelection(
      thyraLocalStorage,
      current.scope,
      activeFilePreview.entry.path,
    );
  }, [activeFilePreview.entry?.path, stateKey]);
  useEffect(() => {
    // Warm the file list and diff only after the terminal has output, so the
    // warmup never competes with it for bandwidth on slow links.
    if (!focusedWorkspace || !startupReady) return;
    const scope = resourceScopeForWorkspace(
      connectionClient.connectionId,
      focusedWorkspace,
    );
    const resourceKey = resourceOwnerKey(scope);
    if (!state?.open || !sameResourceOwner(state.scope, scope)) {
      const workspaceId = focusedWorkspace.workspace_id;
      void fileExplorerResources().then((resources) =>
        resources.prefetchFileExplorerWorkspace(
          workspaceId,
          connectionClient,
          resourceKey,
        ),
      );
      void diffViewerResources().then((resources) =>
        resources.prefetchDiffViewerWorkspace(
          workspaceId,
          connectionClient,
          resourceKey,
        ),
      );
    }
  }, [connectionClient, focusedWorkspace, state, startupReady]);

  const historyOpen = state?.open === true && state.view === "history";
  const originPane = state?.originPaneId
    ? s.panes.find((pane) => pane.pane_id === state.originPaneId)
    : undefined;
  const historyPaneCandidate =
    originPane ??
    (state?.view === "history" && state.originPaneId ? undefined : activePane);
  const workspace = state
    ? resolveWorkspaceForScope(state.scope, s.workspaces)
    : undefined;
  const historyPane =
    historyPaneCandidate?.workspace_id === workspace?.workspace_id
      ? historyPaneCandidate
      : undefined;

  return {
    state,
    stateRef,
    stageRef,
    workspace,
    historyPane,
    historyOpen,
    agentHistoryOpen:
      historyOpen &&
      (!state.originPaneId || state.originPaneId === activePane?.pane_id),
    activeDiff,
    activeFilePreview,
    previewRequestRef,
    commit,
    commitAndSave,
    finishFocus,
    activateTerminalSurface,
    openFileExplorer,
    openFileExplorerFile,
    openDiffViewer,
    close,
    toggle,
    toggleView,
    setExpanded,
    setAgentHistoryOpen,
    keepForWorkspace,
    browseFilesForPane,
    reviewChangesForPane,
    openTerminalWorkspaceFile,
    setActiveDiff,
    setActiveFilePreview,
    loadFilePreview,
  };
}
export type WorkspaceInspector = ReturnType<typeof useWorkspaceInspector>;
