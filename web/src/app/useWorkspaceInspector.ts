import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ConnectionClient } from "../api";
import { thyraLocalStorage } from "../browserStorage";
import type { TerminalWorkspaceFileRequest } from "../components/TerminalView";
import { t } from "../i18n";
import { type State, store } from "../store";
import type { Pane } from "../types";
import {
  inspectorMaximumSize,
  readInspectorPreferences,
  resolveWorkspaceForScope,
  resourceScopeForWorkspace,
  sameResourceOwner,
  WORKSPACE_INSPECTOR_REQUEST_EVENT,
  type WorkspaceInspectorRequest,
  type WorkspaceInspectorState,
  writeInspectorPreferences,
} from "../workspaceResource";
import type { MobileView } from "./useShellLayout";

type OpenInspectorOptions = {
  /** Open this file (checkout-relative or absolute) in the editor. */
  path?: string;
  line?: number;
  originPaneId?: string;
};

/** `path#L12` or `path:12` style fragments name a line. */
function fragmentLine(fragment?: string): number | undefined {
  const line = Number(/^L?(\d+)/.exec(fragment ?? "")?.[1]);
  return Number.isFinite(line) && line > 0 ? line : undefined;
}

/**
 * The Workspace Inspector: VS Code (or a simple upload panel) docked beside
 * the terminal for one workspace, following workspace and connection changes.
 */
export function useWorkspaceInspector({
  s,
  connectionClient,
  resourceUiKey,
  mobile,
  setMobileView,
}: {
  s: Pick<State, "lastRefresh" | "status" | "workspaces">;
  connectionClient: ConnectionClient;
  resourceUiKey: string;
  mobile: boolean;
  setMobileView: (view: MobileView) => void;
}) {
  const [state, setState] = useState<WorkspaceInspectorState | null>(null);
  const stateRef = useRef<WorkspaceInspectorState | null>(null);
  const pendingRequestRef = useRef<WorkspaceInspectorRequest | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fileNonceRef = useRef(0);
  const focusedWorkspace = s.workspaces.find((w) => w.focused);

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
  /** Forget the inspector (workspace or connection gone). */
  const reset = useCallback(() => {
    commit(null);
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
            ":is(.pane-layout-cell.is-active,.pane-switcher-layout,.workspace-terminal-surface>.terminal-shell) .terminal-engine-input",
          )
          ?.focus();
      });
    }
  }, [commit, mobile, setMobileView]);
  const open = useCallback(
    (workspaceId?: string, options: OpenInspectorOptions = {}) => {
      const snapshot = store.get();
      const workspace = workspaceId
        ? snapshot.workspaces.find(
            (candidate) => candidate.workspace_id === workspaceId,
          )
        : snapshot.workspaces.find((candidate) => candidate.focused);
      if (!workspace) {
        store.notify({
          kind: "error",
          message: t("Cannot open the editor"),
          detail: t("The target workspace is no longer open."),
        });
        return;
      }
      const scope = resourceScopeForWorkspace(
        connectionClient.connectionId,
        workspace,
      );
      const current = stateRef.current;
      const sameOwner = !!current && sameResourceOwner(current.scope, scope);
      const stageWidth = stageRef.current?.clientWidth ?? 0;
      const stageHeight = stageRef.current?.clientHeight ?? 0;
      const preferences = readInspectorPreferences(thyraLocalStorage, scope, {
        rightSize: stageWidth > 0 ? stageWidth * 0.5 : undefined,
      });
      const dock = sameOwner ? current.dock : preferences.dock;
      const preferredSize = sameOwner
        ? current.size
        : dock === "right"
          ? preferences.rightSize
          : preferences.bottomSize;
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
      const nextState: WorkspaceInspectorState = {
        scope,
        open: true,
        dock,
        size,
        expanded: sameOwner ? current.expanded : preferences.expanded,
        returnTabId:
          originPane?.tab_id ?? workspace.active_tab_id ?? current?.returnTabId,
        file: options.path
          ? {
              path: options.path,
              line: options.line,
              nonce: ++fileNonceRef.current,
            }
          : sameOwner
            ? current.file
            : undefined,
      };
      if (!workspace.focused) void store.focusWorkspace(workspace.workspace_id);
      commitAndSave(nextState);
      if (mobile) setMobileView("inspector");
    },
    [commitAndSave, connectionClient.connectionId, mobile, setMobileView],
  );
  const openEditor = useCallback(
    (workspaceId?: string) => open(workspaceId),
    [open],
  );
  const openFile = useCallback(
    (
      workspaceId: string,
      entry: { path: string },
      originPaneId?: string,
      fragment?: string,
    ) =>
      open(workspaceId, {
        path: entry.path,
        line: fragmentLine(fragment),
        originPaneId,
      }),
    [open],
  );
  const close = useCallback(() => {
    const current = stateRef.current;
    if (!current) return;
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
    if (tabId) void store.focusTab(tabId);
  }, [commit, setMobileView]);
  const toggle = useCallback(() => {
    if (stateRef.current?.open) close();
    else open();
  }, [close, open]);
  const setExpanded = useCallback(
    (expanded: boolean) => {
      const current = stateRef.current;
      if (current) commitAndSave({ ...current, expanded });
    },
    [commitAndSave],
  );
  const keepForWorkspace = useCallback(
    (workspaceId: string, originPane?: Pane) => {
      if (!stateRef.current?.open) {
        activateTerminalSurface();
        return;
      }
      open(workspaceId, { originPaneId: originPane?.pane_id });
    },
    [activateTerminalSurface, open],
  );
  const openForPane = useCallback(
    (pane: Pane) => open(pane.workspace_id, { originPaneId: pane.pane_id }),
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
      openFile(request.workspaceId, { path: request.path }, request.paneId);
    },
    [connectionClient, openFile],
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
      if (
        !store
          .get()
          .workspaces.some(
            (candidate) => candidate.workspace_id === detail.workspaceId,
          )
      ) {
        pendingRequestRef.current = detail;
        return;
      }
      pendingRequestRef.current = null;
      open(detail.workspaceId);
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
    open(pending.workspaceId);
  }, [connectionClient, open, s.workspaces]);

  const resourceKeyRef = useRef(resourceUiKey);
  useLayoutEffect(() => {
    if (resourceKeyRef.current === resourceUiKey) return;
    resourceKeyRef.current = resourceUiKey;
    pendingRequestRef.current = null;
    reset();
  }, [reset, resourceUiKey]);
  useEffect(() => {
    if (!mobile) return;
    setMobileView(stateRef.current?.open ? "inspector" : "session");
  }, [mobile, setMobileView]);
  // The open editor follows the focused workspace.
  useLayoutEffect(() => {
    const current = stateRef.current;
    if (!current?.open || !focusedWorkspace) return;
    const routed = resolveWorkspaceForScope(current.scope, s.workspaces);
    if (routed?.workspace_id === focusedWorkspace.workspace_id) return;
    keepForWorkspace(focusedWorkspace.workspace_id);
  }, [focusedWorkspace, keepForWorkspace, s.workspaces]);
  useLayoutEffect(() => {
    const current = stateRef.current;
    if (!current) return;
    const workspace = resolveWorkspaceForScope(current.scope, s.workspaces);
    if (!workspace) {
      if (s.status === "connected" && s.lastRefresh > 0) reset();
      return;
    }
    if (workspace.workspace_id === current.scope.workspaceId) return;
    commit({
      ...current,
      scope: resourceScopeForWorkspace(
        connectionClient.connectionId,
        workspace,
      ),
    });
  }, [commit, connectionClient, reset, s.lastRefresh, s.status, s.workspaces]);

  const workspace = state
    ? resolveWorkspaceForScope(state.scope, s.workspaces)
    : undefined;

  return {
    state,
    stateRef,
    stageRef,
    workspace,
    commit,
    commitAndSave,
    activateTerminalSurface,
    openEditor,
    openFile,
    openForPane,
    close,
    toggle,
    setExpanded,
    keepForWorkspace,
    openTerminalWorkspaceFile,
  };
}
export type WorkspaceInspector = ReturnType<typeof useWorkspaceInspector>;
