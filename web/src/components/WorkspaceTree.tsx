import { useHostCapable } from "../capabilities";
import { thyraLocalStorage, thyraStorageEventKey } from "../browserStorage";
import { store, useStoreSelector } from "../store";
import type { GitStatusSummary, Pane, Tab, Workspace } from "../types";
import { shortId } from "../utils";
import { t } from "../i18n";
import {
  clearTerminalComposerDrafts,
  terminalComposerCloseWarning,
  terminalComposerDraftPaneIds,
} from "../terminalComposer";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLongPress } from "./useLongPress";
import type { ContextMenuState } from "./ContextMenu";
import { LazyThemedSelect } from "./LazyThemedSelect";
import { Latched } from "./LazyBoundary";
import { createWorkspaceDialog } from "./lazyPanels";
import { lazyPanel } from "../lazyWithReload";
import { buildWorkspaceHierarchy, worktreeCreationSource } from "../worktree";
import {
  ArrowDownWideNarrow,
  ChevronDown,
  ChevronRight,
  Columns2,
  GitBranch,
  Layers,
  Pin,
  Plus,
} from "lucide-react";
import { LazyWorktreeLifecycleDialog as WorktreeLifecycleDialog } from "./LazyWorktreeLifecycleDialog";
import {
  WORKSPACE_PINS_STORAGE_KEY,
  isWorkspacePinned,
  parseWorkspacePins,
  serializeWorkspacePins,
  setWorkspacePinned,
} from "../workspacePins";
import {
  COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY,
  isWorktreeGroupCollapsed,
  parseCollapsedWorktreeGroups,
  serializeCollapsedWorktreeGroups,
  setWorktreeGroupCollapsed,
} from "../workspaceTreeCollapse";
import {
  showWorkspaceBranchBadge,
  workspaceDisplayName,
} from "../workspaceTreeBadges";
import { pruneClosedWorkspacePreferenceKeys } from "../workspacePreferences";
import { connectionStorageKey } from "../connectionStorage";
import {
  AGENT_ORDER_STORAGE_KEY,
  moveAgentPane,
  sortAgentPanes,
  groupOrderedAgentPanes,
  AGENT_LIST_PREFERENCES_STORAGE_KEY,
  parseAgentListPreferences,
  type AgentSort,
  type AgentGrouping,
  parseAgentOrder,
  serializeAgentOrder,
} from "../agentOrder";
import {
  WORKSPACE_AGENT_LAYOUT_STORAGE_KEY,
  type WorkspaceAgentLayout,
  parseWorkspaceAgentLayout,
} from "../workspaceAgentLayout";
import { useConnectionClient } from "../useConnectionClient";
import { activePaneIdForSnapshot } from "../paneJump";
import {
  AgentContextMenu,
  type AgentMenuState,
  AgentRow,
} from "./WorkspaceAgentRows";
import { groupAgentPanesByWorkspace, paneHasAgent } from "./agentSession";
import {
  focusTreeItem,
  keyboardContextMenuPoint,
  treeKeyboardAction,
  workspaceTreeItemIsTabStop,
} from "./treeKeyboard";
import { TREE_DEPTH_INDENT } from "./treeIndent";
import { groupPanesByTab, shouldShowTabGroups } from "../paneIdentity";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Token } from "./ui/Token";
import "./WorkspaceTree.css";
import { useShallow } from "zustand/react/shallow";

const EMPTY_AGENT_PANES_BY_WORKSPACE = new Map<string, Pane[]>();
const EMPTY_AGENT_PANES: Pane[] = [];

function stringArraysEqual(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function gitChangedCount(status: GitStatusSummary) {
  return status.staged + status.unstaged + status.untracked + status.conflicted;
}

function gitStatusTitle(status?: GitStatusSummary) {
  if (!status) return "";
  if (status.error)
    return t("git status unavailable: {error}", { error: status.error });
  const parts = [
    status.branch ? t("branch: {branch}", { branch: status.branch }) : null,
    status.upstream
      ? t("upstream: {upstream}", { upstream: status.upstream })
      : null,
    status.ahead ? t("ahead: {count}", { count: status.ahead }) : null,
    status.behind ? t("behind: {count}", { count: status.behind }) : null,
    status.staged ? t("staged: {count}", { count: status.staged }) : null,
    status.unstaged ? t("unstaged: {count}", { count: status.unstaged }) : null,
    status.untracked
      ? t("untracked: {count}", { count: status.untracked })
      : null,
    status.conflicted
      ? t("conflicted: {count}", { count: status.conflicted })
      : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function AgentLayoutControl({
  value,
  onChange,
}: {
  value: WorkspaceAgentLayout;
  onChange: (value: WorkspaceAgentLayout) => void;
}) {
  return (
    <div className="workspace-agent-layout-control">
      <span>{t("Agents")}</span>
      <SegmentedControl
        aria-label={t("Agent list layout")}
        value={value}
        onChange={onChange}
        options={[
          { value: "compact", label: t("Compact") },
          { value: "nested", label: t("Nested") },
          { value: "separate", label: t("Separate") },
        ]}
      />
    </div>
  );
}

function GitStatusBadges({
  status,
  showBranch = true,
}: {
  status?: GitStatusSummary;
  showBranch?: boolean;
}) {
  if (!status) return null;
  if (status.error) {
    return (
      <Token code tone="danger" title={gitStatusTitle(status)}>
        git?
      </Token>
    );
  }

  const changed = gitChangedCount(status);
  const branch = status.branch || "git";
  const hasVisibleBadge =
    showBranch || changed > 0 || status.ahead > 0 || status.behind > 0;
  if (!hasVisibleBadge) return null;
  return (
    <span className="git-status" title={gitStatusTitle(status)}>
      {showBranch ? (
        <Token code className="git-branch">
          {branch}
        </Token>
      ) : null}
      {changed > 0 ? (
        <Token code tone="warning">
          Δ{changed}
        </Token>
      ) : null}
      {status.ahead > 0 ? (
        <Token code tone="accent">
          ↑{status.ahead}
        </Token>
      ) : null}
      {status.behind > 0 ? (
        <Token code tone="accent">
          ↓{status.behind}
        </Token>
      ) : null}
    </span>
  );
}

// Menus and dialogs load on first use; Latched keeps them mounted afterwards
// so follow-up dialogs survive the menu closing.
export const workspaceContextMenu = lazyPanel("workspace-context-menu", () =>
  import("./ContextMenu").then((module) => module.ContextMenu),
);
const confirmDialogPanel = lazyPanel("tree-confirm-dialog", () =>
  import("./ui/ConfirmDialog").then((module) => module.ConfirmDialog),
);
const ContextMenu = workspaceContextMenu.Component;
const ConfirmDialog = confirmDialogPanel.Component;
const CreateWorkspaceDialog = createWorkspaceDialog.Component;

export function WorkspaceTree({
  agentsFirst = false,
  onSelect,
  onBrowseFiles,
  onReviewChanges,
  onSelectAgent,
  onBrowseFilesForAgent,
  onReviewChangesForAgent,
}: {
  agentsFirst?: boolean;
  onSelect?: (workspace: Workspace) => void;
  onBrowseFiles?: (workspace: Workspace) => void;
  onReviewChanges?: (workspace: Workspace) => void;
  onSelectAgent?: (pane: Pane) => void;
  onBrowseFilesForAgent?: (pane: Pane) => void;
  onReviewChangesForAgent?: (pane: Pane) => void;
}) {
  const s = useStoreSelector(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      connectionGeneration: state.connectionGeneration,
      lastRefresh: state.lastRefresh,
      layout: state.layout,
      panes: state.panes,
      selectedPaneId: state.selectedPaneId,
      status: state.status,
      tabs: state.tabs,
      workspaces: state.workspaces,
    })),
  );
  const connectionClient = useConnectionClient();
  const host = useHostCapable();
  const agentOrderStorageKey = connectionStorageKey(
    s.activeConnectionId,
    AGENT_ORDER_STORAGE_KEY,
  );
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [agentMenu, setAgentMenu] = useState<AgentMenuState | null>(null);
  const [pendingClosePane, setPendingClosePane] = useState<Pane | null>(null);
  // The confirmation keeps naming the pane while it animates closed.
  const lastClosePaneRef = useRef<Pane | null>(null);
  if (pendingClosePane) lastClosePaneRef.current = pendingClosePane;
  const closePaneShown = pendingClosePane ?? lastClosePaneRef.current;
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(
    null,
  );
  const [workspaceDropTarget, setWorkspaceDropTarget] = useState<{
    workspaceId: string;
    position: "before" | "after";
  } | null>(null);
  const [draggedAgentPaneId, setDraggedAgentPaneId] = useState<string | null>(
    null,
  );
  const [agentDropTarget, setAgentDropTarget] = useState<{
    paneId: string;
    position: "before" | "after";
  } | null>(null);
  const [agentListPreferences, setAgentListPreferences] = useState(() =>
    parseAgentListPreferences(
      thyraLocalStorage.getItem(AGENT_LIST_PREFERENCES_STORAGE_KEY),
    ),
  );
  const [collapsedAgentGroups, setCollapsedAgentGroups] = useState<Set<string>>(
    new Set(),
  );
  const manualAgentOrder =
    agentListPreferences.sort === "manual" &&
    agentListPreferences.grouping === "none";
  const [agentPaneOrder, setAgentPaneOrder] = useState<string[]>(() =>
    parseAgentOrder(thyraLocalStorage.getItem(agentOrderStorageKey)),
  );
  const [agentLayout, setAgentLayout] = useState<WorkspaceAgentLayout>(() =>
    parseWorkspaceAgentLayout(
      thyraLocalStorage.getItem(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY),
    ),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [lifecycleWorkspaceId, setLifecycleWorkspaceId] = useState<
    string | null
  >(null);
  const lastPrunedWorkspaceRefresh = useRef(0);
  const pinsStorageKey = connectionStorageKey(
    s.activeConnectionId,
    WORKSPACE_PINS_STORAGE_KEY,
  );
  const collapsedGroupsStorageKey = connectionStorageKey(
    s.activeConnectionId,
    COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY,
  );
  const [pinnedWorkspaceKeys, setPinnedWorkspaceKeys] = useState<string[]>(() =>
    parseWorkspacePins(thyraLocalStorage.getItem(pinsStorageKey)),
  );
  const [collapsedWorktreeGroupKeys, setCollapsedWorktreeGroupKeys] = useState<
    string[]
  >(() =>
    parseCollapsedWorktreeGroups(
      thyraLocalStorage.getItem(collapsedGroupsStorageKey),
    ),
  );
  const pinnedWorkspaceSet = new Set(pinnedWorkspaceKeys);
  const collapsedWorktreeGroupSet = new Set(collapsedWorktreeGroupKeys);
  const activePaneId = activePaneIdForSnapshot(s) ?? null;
  const agentsByWorkspace = useMemo(
    () => groupAgentPanesByWorkspace(s.panes),
    [s.panes],
  );
  const tabCountsByWorkspace = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of s.tabs) {
      counts.set(tab.workspace_id, (counts.get(tab.workspace_id) ?? 0) + 1);
    }
    return counts;
  }, [s.tabs]);
  const defaultAgentPanes = useMemo(() => {
    const workspaceNumbers = new Map(
      s.workspaces.map((workspace) => [
        workspace.workspace_id,
        workspace.number,
      ]),
    );
    return s.panes.filter(paneHasAgent).sort((left, right) => {
      const workspaceOrder =
        (workspaceNumbers.get(left.workspace_id) ?? 0) -
        (workspaceNumbers.get(right.workspace_id) ?? 0);
      return workspaceOrder || left.pane_id.localeCompare(right.pane_id);
    });
  }, [s.panes, s.workspaces]);
  const agentPanes = useMemo(
    () =>
      sortAgentPanes(
        defaultAgentPanes,
        agentPaneOrder,
        agentListPreferences.sort,
      ),
    [agentPaneOrder, defaultAgentPanes, agentListPreferences.sort],
  );

  const agentGroups = groupOrderedAgentPanes(
    agentPanes,
    agentListPreferences.grouping,
    new Map(
      s.workspaces.map((workspace) => [
        workspace.workspace_id,
        workspaceDisplayName(workspace),
      ]),
    ),
  );
  useEffect(() => {
    thyraLocalStorage.setItem(
      AGENT_LIST_PREFERENCES_STORAGE_KEY,
      JSON.stringify(agentListPreferences),
    );
  }, [agentListPreferences]);

  useEffect(() => {
    setMenu(null);
    setAgentMenu(null);
    setPendingClosePane(null);
    setDraggedWorkspaceId(null);
    setWorkspaceDropTarget(null);
    setDraggedAgentPaneId(null);
    setAgentDropTarget(null);
  }, [connectionClient]);
  useEffect(() => {
    thyraLocalStorage.setItem(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY, agentLayout);
  }, [agentLayout]);
  useEffect(() => {
    thyraLocalStorage.setItem(
      agentOrderStorageKey,
      serializeAgentOrder(agentPaneOrder),
    );
  }, [agentOrderStorageKey, agentPaneOrder]);
  useEffect(() => {
    thyraLocalStorage.setItem(
      pinsStorageKey,
      serializeWorkspacePins(pinnedWorkspaceKeys),
    );
  }, [pinnedWorkspaceKeys, pinsStorageKey]);
  useEffect(() => {
    thyraLocalStorage.setItem(
      collapsedGroupsStorageKey,
      serializeCollapsedWorktreeGroups(collapsedWorktreeGroupKeys),
    );
  }, [collapsedGroupsStorageKey, collapsedWorktreeGroupKeys]);
  useEffect(() => {
    if (
      s.status !== "connected" ||
      s.lastRefresh === 0 ||
      s.lastRefresh <= lastPrunedWorkspaceRefresh.current
    ) {
      return;
    }
    lastPrunedWorkspaceRefresh.current = s.lastRefresh;
    setPinnedWorkspaceKeys((current) => {
      const next = pruneClosedWorkspacePreferenceKeys(current, s.workspaces);
      return stringArraysEqual(current, next) ? current : next;
    });
    setCollapsedWorktreeGroupKeys((current) => {
      const next = pruneClosedWorkspacePreferenceKeys(current, s.workspaces);
      return stringArraysEqual(current, next) ? current : next;
    });
  }, [s.lastRefresh, s.status, s.workspaces]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const key = thyraStorageEventKey(event);
      if (key === pinsStorageKey) {
        setPinnedWorkspaceKeys(parseWorkspacePins(event.newValue));
      } else if (key === collapsedGroupsStorageKey) {
        setCollapsedWorktreeGroupKeys(
          parseCollapsedWorktreeGroups(event.newValue),
        );
      } else if (key === WORKSPACE_AGENT_LAYOUT_STORAGE_KEY) {
        setAgentLayout(parseWorkspaceAgentLayout(event.newValue));
      } else if (key === AGENT_LIST_PREFERENCES_STORAGE_KEY) {
        setAgentListPreferences(parseAgentListPreferences(event.newValue));
      } else if (key === agentOrderStorageKey) {
        setAgentPaneOrder(parseAgentOrder(event.newValue));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [agentOrderStorageKey, collapsedGroupsStorageKey, pinsStorageKey]);

  const updatePinnedWorkspace = (workspace: Workspace, pinned: boolean) => {
    setPinnedWorkspaceKeys((current) =>
      setWorkspacePinned(current, workspace, pinned),
    );
    if (!pinned && workspace.worktree?.is_linked_worktree) {
      const parent = worktreeCreationSource(s.workspaces, workspace);
      if (parent) {
        setCollapsedWorktreeGroupKeys((current) =>
          setWorktreeGroupCollapsed(current, parent, false),
        );
      }
    }
  };
  const updateCollapsedWorktreeGroup = (
    workspace: Workspace,
    collapsed: boolean,
  ) => {
    setCollapsedWorktreeGroupKeys((current) =>
      setWorktreeGroupCollapsed(current, workspace, collapsed),
    );
  };

  const clearWorkspaceDrag = () => {
    setDraggedWorkspaceId(null);
    setWorkspaceDropTarget(null);
  };
  const clearAgentDrag = () => {
    setDraggedAgentPaneId(null);
    setAgentDropTarget(null);
  };
  const workspaceDropPosition = (e: React.DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };
  const onWorkspaceDragStart = (
    workspace: Workspace,
    e: React.DragEvent<HTMLDivElement>,
  ) => {
    clearAgentDrag();
    setDraggedWorkspaceId(workspace.workspace_id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", workspace.workspace_id);
  };
  const onWorkspaceDragOver = (
    workspace: Workspace,
    e: React.DragEvent<HTMLDivElement>,
  ) => {
    if (!draggedWorkspaceId || draggedWorkspaceId === workspace.workspace_id) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const position = workspaceDropPosition(e);
    setWorkspaceDropTarget((current) =>
      current?.workspaceId === workspace.workspace_id &&
      current.position === position
        ? current
        : { workspaceId: workspace.workspace_id, position },
    );
  };
  const onWorkspaceDrop = (
    workspace: Workspace,
    e: React.DragEvent<HTMLDivElement>,
  ) => {
    e.preventDefault();
    const draggedId = draggedWorkspaceId;
    const position = workspaceDropPosition(e);
    clearWorkspaceDrag();
    if (!draggedId || draggedId === workspace.workspace_id) return;
    const orderedIds = [...s.workspaces]
      .sort((a, b) => a.number - b.number)
      .map((candidate) => candidate.workspace_id);
    const from = orderedIds.indexOf(draggedId);
    const to = orderedIds.indexOf(workspace.workspace_id);
    if (from < 0 || to < 0) return;
    // workspace.move inserts before the entry currently at insert_index, so
    // an insertion point past the dragged row lands one slot earlier.
    const insertIndex = position === "before" ? to : to + 1;
    if (from < insertIndex ? insertIndex - 1 === from : insertIndex === from) {
      return;
    }
    void store.moveWorkspace(draggedId, insertIndex);
  };
  const onAgentDragStart = (pane: Pane, e: React.DragEvent<HTMLDivElement>) => {
    clearWorkspaceDrag();
    setDraggedAgentPaneId(pane.pane_id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", pane.pane_id);
  };
  const onAgentDragOver = (pane: Pane, e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedAgentPaneId || draggedAgentPaneId === pane.pane_id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const position = workspaceDropPosition(e);
    setAgentDropTarget((current) =>
      current?.paneId === pane.pane_id && current.position === position
        ? current
        : { paneId: pane.pane_id, position },
    );
  };
  const onAgentDrop = (pane: Pane, e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedAgentPaneId) return;
    e.preventDefault();
    const draggedPaneId = draggedAgentPaneId;
    const position = workspaceDropPosition(e);
    clearAgentDrag();
    if (draggedPaneId === pane.pane_id) return;
    setAgentPaneOrder(
      moveAgentPane(
        agentPanes.map((candidate) => candidate.pane_id),
        draggedPaneId,
        pane.pane_id,
        position,
      ),
    );
  };

  if (s.workspaces.length === 0) {
    return (
      <>
        <div
          key="workspaces"
          className="panel tree workspace-tree-panel"
          tabIndex={-1}
        >
          <div className="panel-head">
            <h2>{t("Workspaces")}</h2>
            {host ? (
              <IconButton
                label={t("New workspace")}
                icon={<Plus size={16} />}
                onClick={() => setCreateOpen(true)}
              />
            ) : null}
          </div>
          <div className="workspace-tree-content">
            <p className="muted">
              {s.status === "connected"
                ? t("No workspaces.")
                : t("Connect to the bridge to load workspaces.")}
            </p>
          </div>
          <AgentLayoutControl value={agentLayout} onChange={setAgentLayout} />
        </div>
        <Latched open={createOpen}>
          <CreateWorkspaceDialog
            open={createOpen}
            onClose={() => setCreateOpen(false)}
          />
        </Latched>
      </>
    );
  }

  const { topLevel, childrenByParent } = buildWorkspaceHierarchy(
    s.workspaces,
    pinnedWorkspaceSet,
  );
  const focusedRepoWorkspace = s.workspaces.find(
    (workspace) => workspace.focused && workspace.worktree,
  );

  const workspacePanel = (
    <div
      key="workspaces"
      className="panel tree workspace-tree-panel"
      tabIndex={-1}
    >
      <div className="panel-head">
        <h2>{t("Workspaces")}</h2>
        {/* Creating workspaces and worktrees are instance-admin actions. */}
        {host ? (
          <div className="panel-actions">
            {focusedRepoWorkspace ? (
              <IconButton
                label={t("Open worktree lifecycle")}
                tooltip={t("Worktree lifecycle")}
                icon={<GitBranch size={14} />}
                onClick={() =>
                  setLifecycleWorkspaceId(focusedRepoWorkspace.workspace_id)
                }
              />
            ) : null}
            <IconButton
              label={t("New workspace")}
              icon={<Plus size={16} />}
              onClick={() => setCreateOpen(true)}
            />
          </div>
        ) : null}
      </div>
      <div
        className="workspace-tree-content"
        role="tree"
        aria-label={t("Workspaces and agents")}
      >
        {topLevel.map((w) => (
          <WorkspaceRow
            key={w.workspace_id}
            w={w}
            depth={0}
            childrenByParent={childrenByParent}
            agentsByWorkspace={
              agentLayout === "nested"
                ? agentsByWorkspace
                : EMPTY_AGENT_PANES_BY_WORKSPACE
            }
            tabCountsByWorkspace={tabCountsByWorkspace}
            alwaysShowTabCount={agentLayout === "compact"}
            activePaneId={activePaneId}
            pinnedWorkspaceKeys={pinnedWorkspaceSet}
            collapsedWorktreeGroupKeys={collapsedWorktreeGroupSet}
            onCollapsedChange={updateCollapsedWorktreeGroup}
            onSelect={onSelect}
            onSelectAgent={onSelectAgent}
            onAgentContextMenu={(pane, x, y) => setAgentMenu({ pane, x, y })}
            onContextMenu={(w, x, y) => setMenu({ workspace: w, x, y })}
            // Reordering changes every user's list: instance admins only.
            workspaceDrag={
              host
                ? {
                    isDragging: draggedWorkspaceId === w.workspace_id,
                    dropPosition:
                      workspaceDropTarget?.workspaceId === w.workspace_id
                        ? workspaceDropTarget.position
                        : null,
                    onDragStart: (e) => onWorkspaceDragStart(w, e),
                    onDragOver: (e) => onWorkspaceDragOver(w, e),
                    onDrop: (e) => onWorkspaceDrop(w, e),
                    onDragEnd: clearWorkspaceDrag,
                  }
                : undefined
            }
          />
        ))}
      </div>
      <AgentLayoutControl value={agentLayout} onChange={setAgentLayout} />
    </div>
  );
  const agentSortLabels: Record<AgentSort, string> = {
    attention: t("Attention first"),
    workspace: t("Workspace order"),
    manual: t("Manual order"),
  };
  const agentGroupingLabels: Record<AgentGrouping, string> = {
    none: t("No grouping"),
    status: t("Status"),
    workspace: t("Workspace"),
    agent: t("Agent type"),
  };
  const agentsPanel =
    agentLayout === "separate" ? (
      <div key="agents" className="panel agents-panel">
        <div className="panel-head">
          <h2>{t("Agents")}</h2>
          <div className="panel-actions agent-list-controls">
            <LazyThemedSelect
              className="agent-list-control"
              icon={<ArrowDownWideNarrow size={15} aria-hidden="true" />}
              align="end"
              aria-label={t("Agent sort order")}
              title={t("Sort agents: {order}", {
                order: agentSortLabels[agentListPreferences.sort],
              })}
              value={agentListPreferences.sort}
              options={[
                { value: "attention", label: agentSortLabels.attention },
                { value: "workspace", label: agentSortLabels.workspace },
                { value: "manual", label: agentSortLabels.manual },
              ]}
              onChange={(sort) => {
                clearAgentDrag();
                setAgentListPreferences((current) => ({
                  ...current,
                  sort: sort as AgentSort,
                }));
              }}
            />
            <LazyThemedSelect
              className={`agent-list-control ${agentListPreferences.grouping !== "none" ? "is-active" : ""}`}
              icon={<Layers size={15} aria-hidden="true" />}
              align="end"
              aria-label={t("Agent grouping")}
              title={t("Group agents: {grouping}", {
                grouping: agentGroupingLabels[agentListPreferences.grouping],
              })}
              value={agentListPreferences.grouping}
              options={[
                { value: "none", label: agentGroupingLabels.none },
                { value: "status", label: agentGroupingLabels.status },
                { value: "workspace", label: agentGroupingLabels.workspace },
                { value: "agent", label: agentGroupingLabels.agent },
              ]}
              onChange={(grouping) => {
                clearAgentDrag();
                setAgentListPreferences((current) => ({
                  ...current,
                  grouping: grouping as AgentGrouping,
                }));
              }}
            />
          </div>
        </div>
        <div className="agents-list">
          {agentPanes.length > 0 ? (
            agentGroups.map((group) => {
              const groupKey = `${agentListPreferences.grouping}:${group.key}`;
              const collapsed = collapsedAgentGroups.has(groupKey);
              return (
                <div key={groupKey} className="agent-list-group">
                  {agentListPreferences.grouping !== "none" ? (
                    <Button
                      fullWidth
                      className="agent-group-toggle"
                      aria-expanded={!collapsed}
                      onClick={() =>
                        setCollapsedAgentGroups((current) => {
                          const next = new Set(current);
                          if (next.has(groupKey)) next.delete(groupKey);
                          else next.add(groupKey);
                          return next;
                        })
                      }
                    >
                      {collapsed ? (
                        <ChevronRight size={13} />
                      ) : (
                        <ChevronDown size={13} />
                      )}
                      <span>{group.label}</span>
                      <Token>{group.panes.length}</Token>
                    </Button>
                  ) : null}
                  {(!collapsed || agentListPreferences.grouping === "none") &&
                    group.panes.map((pane) => {
                      const workspace = s.workspaces.find(
                        (candidate) =>
                          candidate.workspace_id === pane.workspace_id,
                      );
                      return (
                        <AgentRow
                          key={pane.pane_id}
                          pane={pane}
                          selected={
                            pane.pane_id === activePaneId ||
                            (!activePaneId && pane.focused)
                          }
                          showPaneId
                          variant="standalone"
                          workspaceLabel={
                            workspace
                              ? workspaceDisplayName(workspace)
                              : pane.workspace_id
                          }
                          onSelect={onSelectAgent}
                          onOpenMenu={(x, y) => setAgentMenu({ pane, x, y })}
                          drag={
                            manualAgentOrder
                              ? {
                                  isDragging:
                                    draggedAgentPaneId === pane.pane_id,
                                  dropPosition:
                                    agentDropTarget?.paneId === pane.pane_id
                                      ? agentDropTarget.position
                                      : null,
                                  onDragStart: (event) =>
                                    onAgentDragStart(pane, event),
                                  onDragOver: (event) =>
                                    onAgentDragOver(pane, event),
                                  onDrop: (event) => onAgentDrop(pane, event),
                                  onDragEnd: clearAgentDrag,
                                }
                              : undefined
                          }
                        />
                      );
                    })}
                </div>
              );
            })
          ) : (
            <p className="muted">{t("No agent sessions.")}</p>
          )}
        </div>
      </div>
    ) : null;

  return (
    <>
      {agentsFirst ? agentsPanel : workspacePanel}
      {agentsFirst ? workspacePanel : agentsPanel}
      <Latched open={!!menu}>
        <ContextMenu
          state={menu}
          pinnedWorkspaceKeys={pinnedWorkspaceSet}
          onPinnedChange={updatePinnedWorkspace}
          onBrowseFiles={onBrowseFiles}
          onReviewChanges={onReviewChanges}
          onClose={() => setMenu(null)}
        />
      </Latched>
      <AgentContextMenu
        state={agentMenu}
        onClose={() => setAgentMenu(null)}
        onFocus={(pane) => {
          void store.focusPane(pane.pane_id);
          onSelectAgent?.(pane);
        }}
        onBrowseFiles={onBrowseFilesForAgent}
        onReviewChanges={onReviewChangesForAgent}
        onClosePane={setPendingClosePane}
      />
      <Latched open={!!pendingClosePane}>
        <ConfirmDialog
          open={!!pendingClosePane}
          title={t("Close Agent Pane")}
          message={
            closePaneShown
              ? t('Close pane "{pane}"?{warning}', {
                  pane: shortId(closePaneShown.pane_id),
                  warning: terminalComposerCloseWarning(
                    terminalComposerDraftPaneIds(
                      s.activeConnectionId,
                      s.connectionGeneration,
                      [closePaneShown.pane_id],
                    ).length,
                  ),
                })
              : t("Close this pane?")
          }
          confirmLabel={t("Close")}
          tone="danger"
          onOpenChange={(open) => {
            if (!open) setPendingClosePane(null);
          }}
          onConfirm={() => {
            if (pendingClosePane) {
              clearTerminalComposerDrafts(
                s.activeConnectionId,
                s.connectionGeneration,
                [pendingClosePane.pane_id],
              );
              store.closePane(pendingClosePane.pane_id);
            }
          }}
        />
      </Latched>
      <Latched open={createOpen}>
        <CreateWorkspaceDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
        />
      </Latched>
      <WorktreeLifecycleDialog
        open={!!lifecycleWorkspaceId}
        workspaceId={lifecycleWorkspaceId}
        onClose={() => setLifecycleWorkspaceId(null)}
      />
    </>
  );
}

type WorkspaceDragProps = {
  isDragging: boolean;
  dropPosition: "before" | "after" | null;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
};

function workspaceSubtreeContainsActiveItem(
  workspace: Workspace,
  childrenByParent: ReadonlyMap<string, Workspace[]>,
  agentsByWorkspace: ReadonlyMap<string, Pane[]>,
  activePaneId: string | null,
): boolean {
  if (workspace.focused) return true;
  const agents = agentsByWorkspace.get(workspace.workspace_id) ?? [];
  if (
    agents.some(
      (pane) =>
        pane.pane_id === activePaneId || (!activePaneId && pane.focused),
    )
  ) {
    return true;
  }
  return (childrenByParent.get(workspace.workspace_id) ?? []).some((child) =>
    workspaceSubtreeContainsActiveItem(
      child,
      childrenByParent,
      agentsByWorkspace,
      activePaneId,
    ),
  );
}

function WorkspaceRow({
  w,
  depth,
  childrenByParent,
  agentsByWorkspace,
  tabCountsByWorkspace,
  alwaysShowTabCount = false,
  activePaneId,
  pinnedWorkspaceKeys,
  collapsedWorktreeGroupKeys,
  onCollapsedChange,
  onSelect,
  onSelectAgent,
  onAgentContextMenu,
  onContextMenu,
  workspaceDrag,
}: {
  w: Workspace;
  depth: number;
  childrenByParent: Map<string, Workspace[]>;
  agentsByWorkspace: ReadonlyMap<string, Pane[]>;
  tabCountsByWorkspace: ReadonlyMap<string, number>;
  alwaysShowTabCount?: boolean;
  activePaneId: string | null;
  pinnedWorkspaceKeys: ReadonlySet<string>;
  collapsedWorktreeGroupKeys: ReadonlySet<string>;
  onCollapsedChange: (workspace: Workspace, collapsed: boolean) => void;
  onSelect?: (workspace: Workspace) => void;
  onSelectAgent?: (pane: Pane) => void;
  onAgentContextMenu: (pane: Pane, x: number, y: number) => void;
  onContextMenu: (w: Workspace, x: number, y: number) => void;
  workspaceDrag?: WorkspaceDragProps;
}) {
  const children = childrenByParent.get(w.workspace_id) ?? [];
  const agents = agentsByWorkspace.get(w.workspace_id) ?? EMPTY_AGENT_PANES;
  const tabCount = tabCountsByWorkspace.get(w.workspace_id) ?? 0;
  const tabCountVisible = alwaysShowTabCount || tabCount > 1;
  // Keep the previous list while the fields the row shows are unchanged.
  const shownTabs = useRef<Tab[]>([]);
  const workspaceTabs = useStoreSelector((state) => {
    const left = shownTabs.current;
    const right = state.tabs.filter(
      (tab) => tab.workspace_id === w.workspace_id,
    );
    const same =
      left.length === right.length &&
      left.every(
        (tab, index) =>
          tab.tab_id === right[index]?.tab_id &&
          tab.label === right[index]?.label &&
          tab.pane_count === right[index]?.pane_count &&
          tab.focused === right[index]?.focused,
      );
    return same ? left : (shownTabs.current = right);
  });
  const tabGroups = useMemo(
    () => groupPanesByTab(agents, workspaceTabs),
    [agents, workspaceTabs],
  );
  const showTabGroups = shouldShowTabGroups(tabGroups);
  const isChild = depth > 0;
  const hasChildren = children.length > 0;
  const hasNestedItems = hasChildren || agents.length > 0;
  const hasActiveAgent = agents.some(
    (pane) => pane.pane_id === activePaneId || (!activePaneId && pane.focused),
  );
  const hiddenDescendantActive = children.some((child) =>
    workspaceSubtreeContainsActiveItem(
      child,
      childrenByParent,
      agentsByWorkspace,
      activePaneId,
    ),
  );
  const collapsed =
    hasNestedItems && isWorktreeGroupCollapsed(collapsedWorktreeGroupKeys, w);
  const pinned = isWorkspacePinned(pinnedWorkspaceKeys, w);
  const openMenu = (x: number, y: number) => {
    onContextMenu(w, x, y);
  };
  const selectWorkspace = () => {
    store.focusWorkspace(w.workspace_id);
    onSelect?.(w);
  };

  const longPress = useLongPress(openMenu);

  return (
    <>
      <div
        className={`tree-row clickable-row ${w.focused ? "is-focused" : ""} ${
          hasActiveAgent ? "has-active-agent" : ""
        } ${isChild ? "is-child" : ""} ${pinned ? "is-pinned" : ""} ${
          tabCountVisible ? "has-tab-count" : ""
        } ${workspaceDrag?.isDragging ? "is-dragging" : ""} ${
          workspaceDrag?.dropPosition
            ? `drop-${workspaceDrag.dropPosition}`
            : ""
        }`}
        style={{ paddingLeft: 8 + depth * TREE_DEPTH_INDENT }}
        role="treeitem"
        draggable={!!workspaceDrag}
        onDragStart={workspaceDrag?.onDragStart}
        onDragOver={workspaceDrag?.onDragOver}
        onDrop={workspaceDrag?.onDrop}
        onDragEnd={workspaceDrag?.onDragEnd}
        tabIndex={
          workspaceTreeItemIsTabStop({
            workspaceFocused: w.focused,
            directAgentActive: hasActiveAgent,
            collapsed,
            hiddenDescendantActive,
          })
            ? 0
            : -1
        }
        aria-level={depth + 1}
        aria-selected={w.focused}
        aria-expanded={hasNestedItems ? !collapsed : undefined}
        onClick={(e) => {
          if (longPress.consumeClick(e)) return;
          selectWorkspace();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const action = treeKeyboardAction(event.key, event.shiftKey);
          if (!action) return;
          if (
            action === "next" ||
            action === "previous" ||
            action === "first" ||
            action === "last"
          ) {
            event.preventDefault();
            focusTreeItem(event.currentTarget, action);
            return;
          }
          if (action === "expand") {
            event.preventDefault();
            if (hasNestedItems && collapsed) {
              onCollapsedChange(w, false);
            } else {
              focusTreeItem(event.currentTarget, "next");
            }
            return;
          }
          if (action === "collapse") {
            event.preventDefault();
            if (hasNestedItems && !collapsed) {
              onCollapsedChange(w, true);
            } else {
              focusTreeItem(event.currentTarget, "previous");
            }
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (action === "activate") {
            selectWorkspace();
          } else {
            const point = keyboardContextMenuPoint(event.currentTarget);
            openMenu(point.x, point.y);
          }
        }}
        {...longPress.handlers}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY);
        }}
        title={
          w.worktree
            ? [
                `${w.worktree.repo_name} · ${w.worktree.checkout_path}`,
                gitStatusTitle(w.worktree.git_status),
              ]
                .filter(Boolean)
                .join("\n")
            : w.workspace_id
        }
      >
        {hasNestedItems ? (
          <IconButton
            className="workspace-group-toggle"
            tabIndex={-1}
            label={collapsed ? t("Expand workspace") : t("Collapse workspace")}
            icon={
              collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />
            }
            aria-expanded={!collapsed}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openMenu(event.clientX, event.clientY);
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCollapsedChange(w, !collapsed);
            }}
          />
        ) : (
          <span className="twisty" aria-hidden="true" />
        )}
        <strong className="ws-label" title={workspaceDisplayName(w)}>
          {workspaceDisplayName(w)}
        </strong>
        {tabCountVisible ? (
          <span
            className="workspace-tab-count"
            title={t("{count} tabs", { count: tabCount })}
            aria-label={t("{count} tabs", { count: tabCount })}
          >
            {tabCount}
          </span>
        ) : null}
        {pinned ? (
          <Pin
            className="workspace-pin"
            size={11}
            fill="currentColor"
            aria-label={t("Pinned")}
          />
        ) : null}
        {w.worktree ? (
          <GitStatusBadges
            status={w.worktree.git_status}
            showBranch={showWorkspaceBranchBadge(w)}
          />
        ) : null}
      </div>
      {!collapsed ? (
        <>
          {tabGroups.map((group) => {
            const rows = group.panes.map((pane) => (
              <AgentRow
                key={pane.pane_id}
                pane={pane}
                depth={depth + (showTabGroups ? 2 : 1)}
                showPaneId
                selected={
                  pane.pane_id === activePaneId ||
                  (!activePaneId && pane.focused)
                }
                onSelect={onSelectAgent}
                onOpenMenu={(x, y) => onAgentContextMenu(pane, x, y)}
              />
            ));
            if (!showTabGroups) return rows;
            const tabFocused = workspaceTabs.some(
              (tab) => tab.tab_id === group.tabId && tab.focused,
            );
            return (
              <div
                key={group.tabId}
                className={`tab-group ${tabFocused && w.focused ? "is-current" : ""}`}
                role="group"
                aria-label={t("{tab}, {count} panes", {
                  tab: group.label,
                  count: group.paneCount,
                })}
              >
                <div
                  className="tab-group-head"
                  style={{
                    paddingLeft: 18 + (depth + 1) * TREE_DEPTH_INDENT,
                  }}
                  title={`${group.label} · ${group.tabId}`}
                  onClick={() => void store.focusTab(group.tabId)}
                >
                  {group.paneCount > 1 ? (
                    <Columns2 size={12} aria-hidden="true" />
                  ) : null}
                  <span className="tab-group-label">{group.label}</span>
                  {group.paneCount > 1 ? (
                    <Token
                      title={t("{count} panes in this tab", {
                        count: group.paneCount,
                      })}
                    >
                      {group.paneCount}
                    </Token>
                  ) : null}
                </div>
                <div
                  className="tab-group-panes"
                  style={
                    {
                      "--tab-rail-left": `${
                        18 + (depth + 1) * TREE_DEPTH_INDENT + 6
                      }px`,
                    } as React.CSSProperties
                  }
                >
                  {rows}
                </div>
              </div>
            );
          })}
          {children.map((child) => (
            <WorkspaceRow
              key={child.workspace_id}
              w={child}
              depth={depth + 1}
              childrenByParent={childrenByParent}
              agentsByWorkspace={agentsByWorkspace}
              tabCountsByWorkspace={tabCountsByWorkspace}
              alwaysShowTabCount={alwaysShowTabCount}
              activePaneId={activePaneId}
              pinnedWorkspaceKeys={pinnedWorkspaceKeys}
              collapsedWorktreeGroupKeys={collapsedWorktreeGroupKeys}
              onCollapsedChange={onCollapsedChange}
              onSelect={onSelect}
              onSelectAgent={onSelectAgent}
              onAgentContextMenu={onAgentContextMenu}
              onContextMenu={onContextMenu}
            />
          ))}
        </>
      ) : null}
    </>
  );
}
