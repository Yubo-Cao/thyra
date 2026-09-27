import { t } from "../i18n";
import { agentStatusText } from "../agentOrder";
import { shortcutTitle, useShortcutPreferences } from "../shortcutPreferences";
import { store, useStoreSelector, useEndpointCreationReason } from "../store";
import { useEffect, useRef, useState } from "react";
import { useLongPress } from "./useLongPress";
import { createPortal } from "react-dom";
import { PanelRight, Plus, X } from "lucide-react";
import type { Tab } from "../types";
import { AgentStatusIcon } from "./AgentStatusIcon";
import { ConfirmDialog, TextInputDialog } from "./ModalDialogs";
import { PanePresence } from "./PanePresence";
import {
  clearTerminalComposerDrafts,
  terminalComposerCloseWarning,
  terminalComposerDraftPaneIds,
} from "../terminalComposer";
import { summarizeTabAgents } from "./agentSession";
import { Button } from "./ui/Button";
import { ContextMenu } from "./ui/ContextMenu";
import { IconButton } from "./ui/IconButton";
import "./TabBar.css";
import { useShallow } from "zustand/react/shallow";

const REQUEST_CLOSE_TAB_EVENT = "thyra:request-close-tab";
const REQUEST_CLOSE_PANE_EVENT = "thyra:request-close-pane";

interface TabMenuState {
  tab: Tab;
  x: number;
  y: number;
}

export function tabName(tab?: Tab) {
  if (!tab) return "";
  return tab.label && tab.label !== String(tab.number)
    ? tab.label
    : t("Tab {number}", { number: tab.number });
}

/**
 * Routes non-TabBar close controls through the same confirmation dialog used
 * by the tab strip, so keyboard shortcuts cannot bypass destructive-action UX.
 */
export function requestCloseTab(tabId: string) {
  window.dispatchEvent(
    new CustomEvent(REQUEST_CLOSE_TAB_EVENT, { detail: { tabId } }),
  );
}

/** Routes pane shortcuts through confirmation even when terminals are hidden. */
export function requestClosePane(paneId: string) {
  window.dispatchEvent(
    new CustomEvent(REQUEST_CLOSE_PANE_EVENT, { detail: { paneId } }),
  );
}

/**
 * Tab strip for the focused workspace, with create (+) and close (×) controls.
 * Desktop keeps the strip visible even with one tab, while mobile hides it when
 * there is no real tab choice to save vertical terminal space.
 */
export function TabBar({
  mobile = false,
  inspectorOpen = false,
  onToggleInspector,
}: {
  mobile?: boolean;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
}) {
  useShortcutPreferences();
  const s = useStoreSelector(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      connectionGeneration: state.connectionGeneration,
      panes: state.panes,
      tabs: state.tabs,
      workspaces: state.workspaces,
    })),
  );
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(
    null,
  );
  const [pendingClosePaneId, setPendingClosePaneId] = useState<string | null>(
    null,
  );
  const [pendingRenameTab, setPendingRenameTab] = useState<Tab | null>(null);
  const [menu, setMenu] = useState<TabMenuState | null>(null);
  const focusedWs = s.workspaces.find((w) => w.focused);
  const createReason = useEndpointCreationReason(
    "tab.create",
    focusedWs?.workspace_id,
  );
  const tabs = s.tabs
    .filter((tab) => tab.workspace_id === focusedWs?.workspace_id)
    .sort((a, b) => a.number - b.number);
  const pendingCloseTab = s.tabs.find(
    (tab) => tab.tab_id === pendingCloseTabId,
  );
  const pendingCloseTabName = tabName(pendingCloseTab);
  const pendingCloseTabPaneIds = s.panes
    .filter((pane) => pane.tab_id === pendingCloseTabId)
    .map((pane) => pane.pane_id);
  const pendingCloseDraftWarning = terminalComposerCloseWarning(
    terminalComposerDraftPaneIds(
      s.activeConnectionId,
      s.connectionGeneration,
      pendingCloseTabPaneIds,
    ).length,
  );
  const pendingClosePane = s.panes.find(
    (pane) => pane.pane_id === pendingClosePaneId,
  );
  const pendingClosePaneDraftWarning = terminalComposerCloseWarning(
    terminalComposerDraftPaneIds(
      s.activeConnectionId,
      s.connectionGeneration,
      pendingClosePane ? [pendingClosePane.pane_id] : [],
    ).length,
  );
  const showTabStrip = !!focusedWs && (!mobile || tabs.length > 1);
  const gitStatus = focusedWs?.worktree?.git_status;
  const changedCount = gitStatus
    ? gitStatus.staged +
      gitStatus.unstaged +
      gitStatus.untracked +
      gitStatus.conflicted
    : 0;

  useEffect(() => {
    const onRequestClose = (event: Event) => {
      const tabId = (event as CustomEvent<{ tabId?: unknown }>).detail?.tabId;
      if (typeof tabId === "string" && tabId) setPendingCloseTabId(tabId);
    };
    const onRequestClosePane = (event: Event) => {
      const paneId = (event as CustomEvent<{ paneId?: unknown }>).detail
        ?.paneId;
      if (typeof paneId === "string" && paneId) setPendingClosePaneId(paneId);
    };
    window.addEventListener(REQUEST_CLOSE_TAB_EVENT, onRequestClose);
    window.addEventListener(REQUEST_CLOSE_PANE_EVENT, onRequestClosePane);
    return () => {
      window.removeEventListener(REQUEST_CLOSE_TAB_EVENT, onRequestClose);
      window.removeEventListener(REQUEST_CLOSE_PANE_EVENT, onRequestClosePane);
    };
  }, []);

  // The menu keeps its last tab while it animates closed.
  const shownMenu = useRef(menu);
  if (menu) shownMenu.current = menu;
  const menuTab = shownMenu.current?.tab;

  if (!focusedWs) return null;

  const overlays = (
    <>
      <ContextMenu
        position={menu}
        onClose={() => setMenu(null)}
        aria-label={menuTab ? tabName(menuTab) : t("Tabs")}
        items={
          menuTab
            ? [
                {
                  id: "focus",
                  label: t("Focus tab"),
                  onAction: () => store.focusTab(menuTab.tab_id),
                },
                {
                  id: "rename",
                  label: t("Rename tab..."),
                  onAction: () => setPendingRenameTab(menuTab),
                },
                {
                  id: "create",
                  label: t("Create tab"),
                  description: createReason ?? undefined,
                  disabled: !!createReason,
                  onAction: () => store.createTab(focusedWs.workspace_id),
                },
                {
                  id: "close",
                  label: t("Close tab"),
                  danger: true,
                  onAction: () => setPendingCloseTabId(menuTab.tab_id),
                },
              ]
            : []
        }
      />
      <ConfirmDialog
        open={!!pendingCloseTabId}
        title={t("Close Tab")}
        message={`${
          pendingCloseTabName
            ? t("Close {name}?", { name: `"${pendingCloseTabName}"` })
            : t("Close this tab?")
        }${pendingCloseDraftWarning}`}
        confirmLabel={t("Close")}
        danger
        onClose={() => setPendingCloseTabId(null)}
        onConfirm={() => {
          if (pendingCloseTabId) {
            clearTerminalComposerDrafts(
              s.activeConnectionId,
              s.connectionGeneration,
              pendingCloseTabPaneIds,
            );
            store.closeTab(pendingCloseTabId);
          }
        }}
      />
      <ConfirmDialog
        open={!!pendingClosePane}
        title={t("Close Pane")}
        message={`${t("Close this terminal pane?")}${pendingClosePaneDraftWarning}`}
        confirmLabel={t("Close")}
        danger
        onClose={() => setPendingClosePaneId(null)}
        onConfirm={() => {
          if (!pendingClosePane) return;
          clearTerminalComposerDrafts(
            s.activeConnectionId,
            s.connectionGeneration,
            [pendingClosePane.pane_id],
          );
          store.closePane(pendingClosePane.pane_id);
        }}
      />
      <TextInputDialog
        open={!!pendingRenameTab}
        title={t("Rename Tab")}
        label={t("Name")}
        initialValue={tabName(pendingRenameTab ?? undefined)}
        submitLabel={t("Rename")}
        onClose={() => setPendingRenameTab(null)}
        onSubmit={(label) => {
          const value = label.trim();
          if (pendingRenameTab && value) {
            store.renameTab(pendingRenameTab.tab_id, value);
          }
          setPendingRenameTab(null);
        }}
      />
    </>
  );

  return (
    <>
      {showTabStrip ? (
        <div className="tabbar">
          {tabs.map((tab) => {
            const name = tabName(tab);
            const agentSummary = summarizeTabAgents(s.panes, tab.tab_id);
            return (
              <div
                key={tab.tab_id}
                className={`tabbar-tab ${tab.focused ? "is-active" : ""}`}
                onClick={() => {
                  store.focusTab(tab.tab_id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ tab, x: e.clientX, y: e.clientY });
                }}
                title={tab.tab_id}
              >
                {agentSummary ? (
                  <span
                    className="tabbar-agent-marker"
                    title={`${agentSummary.primaryAgent} · ${agentStatusText(agentSummary.status)}${
                      agentSummary.additionalAgents > 0
                        ? ` · ${
                            agentSummary.additionalAgents === 1
                              ? t("{count} more agent", {
                                  count: agentSummary.additionalAgents,
                                })
                              : t("{count} more agents", {
                                  count: agentSummary.additionalAgents,
                                })
                          }`
                        : ""
                    }`}
                    aria-label={t("{agent}, status {status}", {
                      agent: agentSummary.primaryAgent,
                      status: agentSummary.status,
                    })}
                  >
                    <AgentStatusIcon
                      agent={agentSummary.primaryAgent}
                      status={agentSummary.status}
                    />
                    {agentSummary.additionalAgents > 0 ? (
                      <span className="tabbar-agent-more">
                        +{agentSummary.additionalAgents}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                <TabLongPressTarget
                  tab={tab}
                  onOpenMenu={(x, y) => setMenu({ tab, x, y })}
                >
                  <span className="tabbar-name">{name}</span>
                </TabLongPressTarget>
                <PanePresence
                  paneIds={s.panes
                    .filter((pane) => pane.tab_id === tab.tab_id)
                    .map((pane) => pane.pane_id)}
                />
                <IconButton
                  className="tabbar-close"
                  tone="danger"
                  label={t("Close tab")}
                  icon={<X size={13} strokeWidth={2.2} aria-hidden="true" />}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingCloseTabId(tab.tab_id);
                  }}
                />
              </div>
            );
          })}
          <IconButton
            className="tabbar-add"
            label={t("New tab")}
            tooltip={createReason ?? shortcutTitle(t("New tab"), "tab.create")}
            icon={<Plus size={16} aria-hidden="true" />}
            onClick={() => {
              store.createTab(focusedWs.workspace_id);
            }}
            disabled={!!createReason}
          />
          <span className="tabbar-spacer" />
          <div className="tabbar-utilities">
            <Button
              aria-expanded={inspectorOpen}
              title={shortcutTitle(
                inspectorOpen
                  ? t("Close Workspace Inspector")
                  : t("Open Workspace Inspector"),
                "inspector.toggle",
              )}
              onClick={onToggleInspector}
            >
              <PanelRight size={14} />
              <span>{t("Inspector")}</span>
              {changedCount > 0 ? (
                <span className="tabbar-change-count">{changedCount}</span>
              ) : null}
            </Button>
          </div>
        </div>
      ) : null}
      {createPortal(overlays, document.body)}
    </>
  );
}

function TabLongPressTarget({
  tab,
  children,
  onOpenMenu,
}: {
  tab: Tab;
  children: React.ReactNode;
  onOpenMenu: (x: number, y: number) => void;
}) {
  const longPress = useLongPress(onOpenMenu);
  return (
    <span
      className="tabbar-name-hit"
      onClick={longPress.consumeClick}
      {...longPress.handlers}
      title={tab.tab_id}
    >
      {children}
    </span>
  );
}
