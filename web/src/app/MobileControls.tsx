import {
  FileDiff,
  FolderOpen,
  FolderTree,
  History,
  MoreHorizontal,
  PanelTop,
  SquarePen,
  SquareStack,
  SquareTerminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useHostCapable, workspaceCan } from "../capabilities";
import { paneHasAgentHistory } from "../components/agentSession";
import { IconButton } from "../components/ui/IconButton";
import { t } from "../i18n";
import { shortcutTitle } from "../shortcutPreferences";
import {
  activateTerminalComposerDraftScope,
  readTerminalComposerDraft,
  subscribeTerminalComposerDraft,
  terminalComposerDraftKey,
} from "../terminalComposer";
import type { Pane, Workspace } from "../types";
import type { MobileView } from "./useShellLayout";
import type { WorkspaceInspector } from "./useWorkspaceInspector";

export function blurActiveInput(event: React.PointerEvent<HTMLButtonElement>) {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  const button = event.currentTarget;
  window.setTimeout(() => button.blur(), 0);
}

/** Mobile-only chrome state: collapsed controls, the tab sheet, the composer. */
export function useMobileControls(
  mobile: boolean,
  focusedWorkspace: Workspace | undefined,
  activeConnectionId: string,
  connectionGeneration: number,
  activePane: Pane | undefined,
) {
  useEffect(() => {
    activateTerminalComposerDraftScope(
      activeConnectionId,
      connectionGeneration,
    );
  }, [activeConnectionId, connectionGeneration]);
  const [collapsed, setCollapsed] = useState(false);
  const [tabSheetOpen, setTabSheetOpen] = useState(false);
  const composerScopeKey = JSON.stringify([
    activeConnectionId,
    connectionGeneration,
  ]);
  const [openComposerScopeKey, setOpenComposerScopeKey] = useState<
    string | null
  >(null);
  useEffect(() => {
    // Drop mobile-only controls when their context disappears so they cannot
    // stay active invisibly or resurface when the mobile layout returns.
    if (!mobile || !focusedWorkspace) setTabSheetOpen(false);
    if (!mobile) setOpenComposerScopeKey(null);
  }, [mobile, focusedWorkspace]);
  useEffect(() => {
    setOpenComposerScopeKey(null);
  }, [composerScopeKey]);
  // Without `edit` (viewers, share-link guests) the page watches only: no
  // composer, no tab changes.
  const readOnly =
    !!focusedWorkspace && !workspaceCan(focusedWorkspace, "edit");
  const composerDraftKey =
    activePane?.terminal_id && !readOnly
      ? terminalComposerDraftKey(
          activeConnectionId,
          connectionGeneration,
          activePane.pane_id,
        )
      : null;
  const setComposerOpen = useCallback(
    (open: boolean) => {
      setOpenComposerScopeKey(open ? composerScopeKey : null);
    },
    [composerScopeKey],
  );
  return {
    readOnly,
    collapsed,
    setCollapsed,
    tabSheetOpen,
    setTabSheetOpen,
    composerDraftKey,
    composerOpen:
      mobile &&
      !tabSheetOpen &&
      openComposerScopeKey === composerScopeKey &&
      composerDraftKey !== null,
    setComposerOpen,
  };
}
export type MobileControls = ReturnType<typeof useMobileControls>;

function useComposerHasDraft(draftKey: string | null) {
  const [hasDraft, setHasDraft] = useState(false);
  useEffect(() => {
    if (!draftKey) {
      setHasDraft(false);
      return;
    }
    const update = (draft: string) => setHasDraft(draft !== "");
    update(readTerminalComposerDraft(draftKey));
    return subscribeTerminalComposerDraft(draftKey, update);
  }, [draftKey]);
  return hasDraft;
}

/** Session / Files / Changes / History switcher of the mobile layout. */
export function MobileViewNav({
  mobileView,
  onShowHistory,
  collapsed,
  activePane,
  inspector,
}: {
  mobileView: MobileView;
  onShowHistory: () => void;
  collapsed: boolean;
  activePane: Pane | undefined;
  inspector: Pick<
    WorkspaceInspector,
    | "agentHistoryOpen"
    | "historyOpen"
    | "activateTerminalSurface"
    | "openFileExplorer"
    | "openDiffViewer"
    | "setAgentHistoryOpen"
  >;
}) {
  const { historyOpen } = inspector;
  const activePaneHasAgent = paneHasAgentHistory(activePane);
  const tabIndex = collapsed ? -1 : 0;
  return (
    <nav
      className="mobile-nav"
      aria-label={t("Workspace view switcher")}
      aria-hidden={collapsed}
    >
      <IconButton
        className={
          mobileView === "session" && !inspector.agentHistoryOpen
            ? "active"
            : ""
        }
        title={t("Session")}
        label={t("Show terminal session")}
        icon={<SquareTerminal size={16} aria-hidden="true" />}
        tabIndex={tabIndex}
        onClick={inspector.activateTerminalSurface}
      />
      <IconButton
        className={mobileView === "files" ? "active" : ""}
        title={shortcutTitle(t("Files"), "files.toggle")}
        label={t("Show workspace files")}
        icon={<FolderTree size={16} aria-hidden="true" />}
        tabIndex={tabIndex}
        onClick={() => inspector.openFileExplorer()}
      />
      <IconButton
        className={mobileView === "changes" ? "active" : ""}
        title={shortcutTitle(t("Changes"), "diff.toggle")}
        label={t("Show workspace changes")}
        icon={<FileDiff size={16} aria-hidden="true" />}
        tabIndex={tabIndex}
        onClick={() => inspector.openDiffViewer()}
      />
      <IconButton
        className={mobileView === "history" ? "active" : ""}
        title={
          activePaneHasAgent || historyOpen
            ? t("History")
            : t("Select an agent pane to view History")
        }
        label={t("Show agent message history")}
        icon={<History size={16} aria-hidden="true" />}
        aria-pressed={historyOpen}
        tabIndex={tabIndex}
        disabled={!activePaneHasAgent && !historyOpen}
        onClick={() => {
          if (historyOpen && mobileView !== "history") {
            onShowHistory();
          } else {
            inspector.setAgentHistoryOpen(!historyOpen);
          }
        }}
      />
    </nav>
  );
}

/** The workspaces shortcut and the tabs/launcher/composer strip. */
export function MobileTerminalControls({
  controls,
  mobileView,
  tabCount,
  hasWorkspace,
  onShowSession,
  onOpenWorkspaces,
  onOpenProjectLauncher,
}: {
  controls: MobileControls;
  mobileView: MobileView;
  tabCount: number;
  hasWorkspace: boolean;
  onShowSession: () => void;
  onOpenWorkspaces: () => void;
  onOpenProjectLauncher: () => void;
}) {
  const { collapsed, tabSheetOpen, composerDraftKey, composerOpen } = controls;
  const composerHasDraft = useComposerHasDraft(composerDraftKey);
  const tabIndex = collapsed ? -1 : 0;
  // The project launcher starts commands on the host: instance admins only.
  const host = useHostCapable();
  return (
    <>
      <IconButton
        className={`mobile-workspace-shortcut ${
          mobileView === "workspaces" ? "is-active" : ""
        }`}
        title={shortcutTitle(t("Workspaces"), "workspaces.open")}
        label={
          mobileView === "workspaces"
            ? t("Hide workspaces")
            : t("Show workspaces")
        }
        icon={<PanelTop size={17} aria-hidden="true" />}
        aria-pressed={mobileView === "workspaces"}
        aria-hidden={collapsed}
        tabIndex={tabIndex}
        onPointerDown={blurActiveInput}
        onClick={mobileView === "workspaces" ? onShowSession : onOpenWorkspaces}
      />
      <div className="mobile-terminal-controls">
        <nav
          className="mobile-nav mobile-terminal-tools"
          aria-label={
            composerDraftKey ? t("Tabs and terminal composer") : t("Tabs")
          }
          aria-hidden={collapsed}
        >
          {host ? (
            <IconButton
              className="mobile-launcher"
              title={t("Launch agent")}
              label={t("Launch agent in a folder")}
              icon={<FolderOpen size={16} aria-hidden="true" />}
              tabIndex={tabIndex}
              onPointerDown={blurActiveInput}
              onClick={() => {
                controls.setTabSheetOpen(false);
                onOpenProjectLauncher();
              }}
            />
          ) : null}
          <IconButton
            className={tabSheetOpen ? "active" : ""}
            title={t("Tabs")}
            label={t("Show tabs")}
            icon={
              <>
                <SquareStack size={16} aria-hidden="true" />
                {tabCount > 0 ? (
                  <span className="mobile-nav-badge" aria-hidden="true">
                    {tabCount}
                  </span>
                ) : null}
              </>
            }
            aria-pressed={tabSheetOpen}
            tabIndex={tabIndex}
            disabled={!hasWorkspace}
            onPointerDown={blurActiveInput}
            onClick={() => controls.setTabSheetOpen((open) => !open)}
          />
          {composerDraftKey ? (
            <IconButton
              className={composerOpen ? "active" : ""}
              title={
                composerOpen
                  ? t("Close terminal composer")
                  : t("Open terminal composer")
              }
              label={
                composerHasDraft
                  ? composerOpen
                    ? t("Close terminal composer, unsent draft")
                    : t("Open terminal composer, unsent draft")
                  : composerOpen
                    ? t("Close terminal composer")
                    : t("Open terminal composer")
              }
              icon={
                <>
                  <SquarePen size={16} aria-hidden="true" />
                  {composerHasDraft && !composerOpen ? (
                    <span
                      className="mobile-composer-draft-dot"
                      aria-hidden="true"
                    />
                  ) : null}
                </>
              }
              aria-pressed={composerOpen}
              tabIndex={tabIndex}
              onPointerDown={blurActiveInput}
              onClick={() => {
                const open = !composerOpen;
                if (open) {
                  controls.setTabSheetOpen(false);
                  onShowSession();
                }
                controls.setComposerOpen(open);
              }}
            />
          ) : null}
        </nav>
        <IconButton
          className="mobile-controls-toggle"
          label={
            collapsed ? t("Show mobile controls") : t("Hide mobile controls")
          }
          icon={
            collapsed ? (
              <MoreHorizontal size={17} aria-hidden="true" />
            ) : (
              <X size={17} aria-hidden="true" />
            )
          }
          aria-pressed={collapsed}
          onPointerDown={blurActiveInput}
          onClick={() => controls.setCollapsed((value) => !value)}
        />
      </div>
    </>
  );
}
