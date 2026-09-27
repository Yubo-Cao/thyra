// Import order sets the order of component CSS in the bundle (AgentIcon,
// command menu, connection switcher, tabs, workspace tree, then the layout
// sheets); keep it when adding imports.
import { useLayoutPreferences } from "./layoutPreferences";
import { shortcutTitle, useShortcutPreferences } from "./shortcutPreferences";
import { t } from "./i18n";
import { Minimize2 } from "lucide-react";
import { useCallback, useState } from "react";
import { PaneJumpOverlay, usePaneJump } from "./app/paneJump";
import { useStartupSettled } from "./startupGate";
import { Button } from "./components/ui/Button";
import { TopBar } from "./app/TopBar";
import { TabBar } from "./components/TabBar";
import { WorkspaceTree } from "./components/WorkspaceTree";
import {
  Latched,
  LazyBoundary,
  LazyPendingStatus,
} from "./components/LazyBoundary";
import { activePaneIdForSnapshot } from "./paneJump";
import {
  shallowEqual,
  type TaskNotificationTarget,
  store,
  useStoreSelector,
} from "./store";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "./useConnectionClient";
import { useAppearance } from "./app/useAppearance";
import { useAppShortcuts } from "./app/useAppShortcuts";
import { useWorkspaceInspector } from "./app/useWorkspaceInspector";
import {
  mobileTabSheet,
  PopupOverlay,
  projectLauncherPanel,
  StartupLayers,
  useIdlePrefetch,
} from "./app/lazySurfaces";
import { NoticeHost, useTaskNotificationActivation } from "./app/notices";
import { TerminalPaneLayout } from "./app/TerminalPaneLayout";
import {
  MobileTerminalControls,
  MobileViewNav,
  useMobileControls,
} from "./app/MobileControls";
import { useShellLayout } from "./app/useShellLayout";
import {
  useVisualViewportCssVars,
  ViewportDebugOverlay,
  viewportDebugEnabled,
} from "./app/viewport";
import { WorkspaceStage } from "./app/WorkspaceStage";
import "./styles/layout/app.css";
import "./styles/layout/topbar.css";
import "./styles/layout/sidebar.css";
import "./styles/layout/mobile-nav.css";

const MobileTabSheet = mobileTabSheet.Component;
const LazyProjectLauncher = projectLauncherPanel.Component;

export default function App() {
  useShortcutPreferences();
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      connectionGeneration: state.connectionGeneration,
      lastRefresh: state.lastRefresh,
      layout: state.layout,
      panes: state.panes,
      pendingFocusWorkspaceId: state.pendingFocusWorkspaceId,
      recentPaneIds: state.recentPaneIds,
      selectedPaneId: state.selectedPaneId,
      status: state.status,
      tabs: state.tabs,
      workspaces: state.workspaces,
    }),
    shallowEqual,
  );
  const connectionClient = useConnectionClient();
  const { mobile, preferences: layoutPreferences } = useLayoutPreferences();
  // Startup work the terminal and switchers do not need waits for this.
  const startupReady = useStartupSettled();
  const resourceUiKey = connectionClientScopeKey(
    connectionClient,
    "resource-ui",
  );
  const { configuration, terminalTheme } = useAppearance(
    connectionClient,
    s.status === "connected",
  );
  useVisualViewportCssVars(configuration.uiScale);
  const shell = useShellLayout(mobile);
  const { mobileView, setMobileView, setSidebarHidden, zenMode, applyZenMode } =
    shell;
  const [projectLauncherOpen, setProjectLauncherOpen] = useState(false);
  const focusedWorkspace = s.workspaces.find((w) => w.focused);
  const activePaneId = activePaneIdForSnapshot(s);
  const activePane = activePaneId
    ? s.panes.find((pane) => pane.pane_id === activePaneId)
    : undefined;
  const mobileControls = useMobileControls(
    mobile,
    focusedWorkspace,
    s.activeConnectionId,
    s.connectionGeneration,
    activePane,
  );
  const inspector = useWorkspaceInspector({
    s,
    connectionClient,
    resourceUiKey,
    mobile,
    setMobileView,
    activePane,
    startupReady,
  });
  const { activateTerminalSurface, stateRef: inspectorStateRef } = inspector;
  const showSessionUnlessInspecting = useCallback(() => {
    if (!inspectorStateRef.current?.open) setMobileView("session");
  }, [inspectorStateRef, setMobileView]);
  const paneJump = usePaneJump(
    s,
    activePaneId,
    resourceUiKey,
    showSessionUnlessInspecting,
  );
  const openNotificationTarget = useCallback(
    (target: TaskNotificationTarget) => {
      if (!inspectorStateRef.current?.open) activateTerminalSurface();
      setSidebarHidden(false);
      void store.focusTaskNotificationTarget(target);
    },
    [activateTerminalSurface, inspectorStateRef, setSidebarHidden],
  );
  useTaskNotificationActivation(openNotificationTarget);
  useIdlePrefetch(startupReady, mobile);
  useAppShortcuts({
    mobile,
    paneJump,
    inspector,
    openWorkspaces: shell.openWorkspaces,
    toggleZenMode: shell.toggleZenMode,
    toggleSidebar: shell.toggleSidebar,
  });

  return (
    <div
      className={`app ${shell.sidebarHidden && !mobile ? "sidebar-hidden" : ""} ${
        zenMode && !mobile ? "zen" : ""
      } ${mobileControls.collapsed ? "mobile-controls-collapsed" : ""}`}
    >
      <TopBar
        resourceUiKey={resourceUiKey}
        startupReady={startupReady}
        configuration={configuration}
        zenMode={zenMode}
        onZenModeChange={applyZenMode}
        inspector={inspector}
        onOpenProjectLauncher={() => setProjectLauncherOpen(true)}
      />
      {zenMode && !mobile ? (
        <Button
          className="zen-island"
          data-tooltip={shortcutTitle(t("Exit Zen mode"), "zen.toggle")}
          aria-label={shortcutTitle(t("Exit Zen mode"), "zen.toggle")}
          onClick={() => applyZenMode(false)}
        >
          <Minimize2 size={13} aria-hidden="true" />
          <span>{t("Exit Zen")}</span>
        </Button>
      ) : null}
      <MobileViewNav
        mobileView={mobileView}
        onShowHistory={() => setMobileView("history")}
        collapsed={mobileControls.collapsed}
        activePane={activePane}
        inspector={inspector}
      />
      {projectLauncherOpen ? (
        <LazyBoundary fallback={<LazyPendingStatus />}>
          <LazyProjectLauncher
            onClose={() => setProjectLauncherOpen(false)}
            onLaunched={activateTerminalSurface}
          />
        </LazyBoundary>
      ) : null}
      <Latched open={mobile && mobileControls.tabSheetOpen}>
        <MobileTabSheet
          open={mobile && mobileControls.tabSheetOpen}
          onClose={() => mobileControls.setTabSheetOpen(false)}
          onShowSession={activateTerminalSurface}
        />
      </Latched>
      <MobileTerminalControls
        controls={mobileControls}
        mobileView={mobileView}
        tabCount={
          focusedWorkspace
            ? s.tabs.filter(
                (tab) => tab.workspace_id === focusedWorkspace.workspace_id,
              ).length
            : 0
        }
        hasWorkspace={!!focusedWorkspace}
        onShowSession={activateTerminalSurface}
        onOpenWorkspaces={shell.openWorkspaces}
        onOpenProjectLauncher={() => setProjectLauncherOpen(true)}
      />
      <NoticeHost onOpenTarget={openNotificationTarget} />
      <div
        className={`body mobile-view-${mobileView}`}
        style={{
          gridTemplateColumns: `${shell.sidebarWidth}px 6px minmax(0, 1fr)`,
        }}
      >
        <div className="sidebar">
          <div className="sidebar-content">
            <WorkspaceTree
              agentsFirst={
                (mobile
                  ? layoutPreferences.mobileSidebarOrder
                  : layoutPreferences.desktopSidebarOrder) === "agents-first"
              }
              key={`${resourceUiKey}:workspaces`}
              onSelect={(workspace) =>
                inspector.keepForWorkspace(workspace.workspace_id)
              }
              onBrowseFiles={(workspace) =>
                inspector.openFileExplorer(workspace.workspace_id)
              }
              onReviewChanges={(workspace) =>
                inspector.openDiffViewer(workspace.workspace_id)
              }
              onSelectAgent={(pane) =>
                inspector.keepForWorkspace(pane.workspace_id, pane)
              }
              onBrowseFilesForAgent={inspector.browseFilesForPane}
              onReviewChangesForAgent={inspector.reviewChangesForPane}
              onViewAgentHistory={(pane) =>
                inspector.setAgentHistoryOpen(true, pane)
              }
            />
          </div>
        </div>
        <div
          className="resizer"
          onPointerDown={shell.startSidebarResize}
          title={t("Drag to resize sidebar")}
        />
        <main className="main">
          <TabBar
            key={`${resourceUiKey}:tabs`}
            mobile={mobile}
            inspectorOpen={inspector.state?.open === true}
            onToggleInspector={inspector.toggle}
          />
          <div className="workspace-surfaces">
            <WorkspaceStage
              inspector={inspector}
              mobile={mobile}
              mobileView={mobileView}
              onMobileViewChange={setMobileView}
              resourceUiKey={resourceUiKey}
              connectionClient={connectionClient}
            >
              <TerminalPaneLayout
                terminalTheme={terminalTheme}
                uiScale={configuration.uiScale}
                fontFamily={configuration.terminalFontFamily}
                mobileShortcuts={configuration.mobileTerminalShortcuts}
                mobileSideShortcuts={configuration.mobileTerminalSideShortcuts}
                composerOpen={mobileControls.composerOpen}
                onComposerOpenChange={mobileControls.setComposerOpen}
                agentHistoryOpen={inspector.agentHistoryOpen}
                onAgentHistoryOpenChange={inspector.setAgentHistoryOpen}
                onOpenWorkspaceFile={inspector.openTerminalWorkspaceFile}
              />
            </WorkspaceStage>
          </div>
        </main>
      </div>
      {startupReady ? <StartupLayers /> : null}
      {viewportDebugEnabled ? <ViewportDebugOverlay /> : null}
      <PopupOverlay terminalTheme={terminalTheme} />
      {paneJump.open ? <PaneJumpOverlay paneJump={paneJump} /> : null}
    </div>
  );
}
