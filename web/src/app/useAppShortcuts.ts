import { workspaceCan } from "../capabilities";
import { useEffect } from "react";
import { CONFIG_MENU_ID } from "../components/ConfigMenu";
import { requestClosePane, requestCloseTab } from "../components/TabBar";
import { keyboardOverlayOpen } from "../components/ui/overlayState";
import { activePaneIdForSnapshot } from "../paneJump";
import { paneShortcutAction } from "../paneShortcuts";
import { pluginActionShortcut } from "../pluginActionShortcuts";
import { SHORTCUT_NUMBERS, type ShortcutId } from "../shortcutBindings";
import { shortcutMatches } from "../shortcutPreferences";
import { store } from "../store";
import {
  adjacentTabId,
  closeShortcutTarget,
  tabShortcutAction,
} from "../tabShortcuts";
import { isWorkspaceInspectorShortcut } from "../workspaceResource";
import type { PaneJump } from "./paneJump";
import type { WorkspaceInspector } from "./useWorkspaceInspector";

// The prompt editor stands in for the terminal's input, so workspace, tab
// and pane shortcuts work from it as they do from the terminal.
function isEditableElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm, .prompt-editor")) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  return target.isContentEditable;
}

function tabShortcutIndex(e: KeyboardEvent) {
  const number = SHORTCUT_NUMBERS.find((n) => shortcutMatches(e, `tab.${n}`));
  return number === undefined ? null : number - 1;
}

/** Window-level workspace, tab, pane, and pane-switcher shortcuts. */
export function useAppShortcuts({
  mobile,
  paneJump,
  inspector,
  openWorkspaces,
  toggleZenMode,
  toggleSidebar,
}: {
  mobile: boolean;
  paneJump: PaneJump;
  inspector: Pick<
    WorkspaceInspector,
    "stateRef" | "toggle" | "toggleView" | "setExpanded"
  >;
  openWorkspaces: () => void;
  toggleZenMode: () => void;
  toggleSidebar: () => void;
}) {
  const {
    open: paneJumpOpen,
    search: paneJumpSearch,
    options: { length: paneJumpCount },
    modifierRef,
    close: closePaneJump,
    commit: commitPaneJump,
    move: movePaneJump,
    openRecent,
    openSearch,
  } = paneJump;
  const { stateRef, toggle, toggleView, setExpanded } = inspector;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      // While a dialog, menu, or picker is open, window shortcuts stand down.
      if (keyboardOverlayOpen() || document.getElementById(CONFIG_MENU_ID))
        return;
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      // Tab, pane, and plugin shortcuts are claimed even where they stand
      // down, so the browser never acts on them.
      const claimUnlessEditing = () => {
        claim();
        return isEditableElement(e.target);
      };
      if (paneJumpOpen) {
        const navigate = () => {
          if (e.key === "Tab") movePaneJump(e.shiftKey ? -1 : 1);
          else if (e.key === "ArrowDown") movePaneJump(1);
          else if (e.key === "ArrowUp") movePaneJump(-1);
          else if (e.key === "Enter") commitPaneJump();
          else closePaneJump(paneJumpSearch !== null);
        };
        const navigationKey = [
          "Tab",
          "ArrowDown",
          "ArrowUp",
          "Enter",
          "Escape",
        ].includes(e.key);
        const searchShortcut = shortcutMatches(e, "panes.search");
        if (paneJumpSearch !== null) {
          if (searchShortcut || navigationKey) {
            claim();
            if (searchShortcut && e.repeat) return;
            if (searchShortcut) closePaneJump(true);
            else navigate();
          } else if (shortcutMatches(e, "panes.recent")) {
            claim();
            movePaneJump(e.shiftKey ? -1 : 1);
          }
          // Every other key belongs to the search field, and no workspace
          // shortcut may fire while it has focus.
          return;
        }
        // Keep the opening modifiers held: Ctrl+K on macOS, Ctrl+Alt+K
        // on Windows/Linux, and Shift when cycling backwards.
        if (
          searchShortcut ||
          e.code === "KeyK" ||
          e.key.toLowerCase() === "k"
        ) {
          claim();
          openSearch();
          return;
        }
        if (navigationKey) {
          claim();
          navigate();
          return;
        }
        if (
          !["Control", "Shift", "Alt", "Meta"].includes(e.key) &&
          !shortcutMatches(e, "panes.recent")
        ) {
          closePaneJump();
        }
      }
      if (shortcutMatches(e, "panes.recent")) {
        if (isEditableElement(e.target)) return;
        if (paneJumpCount === 0) return;
        claim();
        if (!paneJumpOpen && !e.repeat) {
          openRecent(
            e.ctrlKey
              ? "ctrlKey"
              : e.altKey
                ? "altKey"
                : e.metaKey
                  ? "metaKey"
                  : null,
          );
        } else if (paneJumpOpen) {
          movePaneJump(e.shiftKey ? -1 : 1);
        }
        return;
      }
      if (shortcutMatches(e, "panes.search")) {
        if (isEditableElement(e.target)) return;
        claim();
        openSearch();
        return;
      }
      if (e.key === "Escape") {
        const current = store.get();
        const canDismissUpdate =
          current.updateInfo?.update_available && !current.updateInstalling;
        if (current.notice || canDismissUpdate) {
          claim();
          if (current.notice) store.clearNotice();
          if (canDismissUpdate) store.dismissUpdate();
        }
        return;
      }
      const tabAction = tabShortcutAction(e);
      if (tabAction) {
        if (claimUnlessEditing()) return;
        if (e.repeat && (tabAction === "create" || tabAction === "close")) {
          return;
        }
        const current = store.get();
        const focusedWorkspace = current.workspaces.find(
          (workspace) => workspace.focused,
        );
        if (!focusedWorkspace) return;
        // Write shortcuts do nothing where the caller may not edit.
        if (
          (tabAction === "create" || tabAction === "close") &&
          !workspaceCan(focusedWorkspace, "edit")
        )
          return;
        if (tabAction === "create") {
          void store.createTab(focusedWorkspace.workspace_id, {
            numberedLabel: true,
          });
          return;
        }

        const tabs = current.tabs
          .filter((tab) => tab.workspace_id === focusedWorkspace.workspace_id)
          .sort((a, b) => a.number - b.number);
        const tabIds = new Set(tabs.map((tab) => tab.tab_id));
        const activeTabId = [
          focusedWorkspace.active_tab_id,
          current.layout?.tab_id,
          tabs.find((tab) => tab.focused)?.tab_id,
        ].find((tabId): tabId is string => !!tabId && tabIds.has(tabId));
        if (tabAction === "close") {
          const target = closeShortcutTarget(
            activeTabId,
            current.panes,
            activePaneIdForSnapshot(current),
          );
          if (target?.type === "pane") requestClosePane(target.id);
          else if (target?.type === "tab") requestCloseTab(target.id);
          return;
        }

        const targetTabId = adjacentTabId(tabs, activeTabId, tabAction);
        if (!targetTabId || targetTabId === activeTabId) return;
        store.focusTab(targetTabId);
        return;
      }
      const pluginAction = pluginActionShortcut(e);
      if (pluginAction) {
        // Typing into the popup's own terminal never reaches here, since
        // isEditableElement stops at the xterm textarea.
        // Plugin actions run code on the host: instance admins only.
        if (claimUnlessEditing() || e.repeat || store.get().host === false)
          return;
        const current = store.get();
        const layoutActivePaneId = activePaneIdForSnapshot(current);
        const activePane = current.panes.find(
          (pane) => pane.pane_id === layoutActivePaneId,
        );
        // Hide-or-open is resolved against Herdr, not this client's popup
        // state, which a Space switch can leave stale. See togglePluginPopup.
        void store.togglePluginPopup(
          pluginAction.pluginId,
          pluginAction.actionId,
          {
            workspace_id: activePane?.workspace_id,
            focused_pane_cwd: activePane?.foreground_cwd ?? activePane?.cwd,
          },
        );
        return;
      }
      const paneAction = paneShortcutAction(e);
      if (paneAction) {
        if (claimUnlessEditing()) return;
        if (e.repeat && paneAction.type !== "focus") return;

        const current = store.get();
        const focusedWorkspace = current.workspaces.find((w) => w.focused);
        const activeTab =
          current.tabs.find(
            (tab) => tab.tab_id === focusedWorkspace?.active_tab_id,
          ) ?? current.tabs.find((tab) => tab.focused);
        // Resolve the selection only while it belongs to the visible layout,
        // then fall back to tab-local panes like the command menu does.
        const layoutActivePaneId = activePaneIdForSnapshot(current);
        const activePane =
          current.panes.find((pane) => pane.pane_id === layoutActivePaneId) ??
          current.panes.find(
            (pane) => pane.tab_id === activeTab?.tab_id && pane.focused,
          ) ??
          current.panes.find((pane) => pane.tab_id === activeTab?.tab_id);
        if (!activePane) return;
        if (
          paneAction.type !== "focus" &&
          !workspaceCan(focusedWorkspace, "edit")
        )
          return;
        if (paneAction.type === "split") {
          void store.splitPane(activePane.pane_id, paneAction.direction);
        } else if (paneAction.type === "zoom") {
          void store.zoomPane(activePane.pane_id);
        } else {
          void store.focusPaneDirection(
            activePane.pane_id,
            paneAction.direction,
          );
        }
        return;
      }
      const tabIndex = tabShortcutIndex(e);
      if (tabIndex !== null) {
        if (isEditableElement(e.target)) return;
        const current = store.get();
        const focusedWorkspace = current.workspaces.find((w) => w.focused);
        const tabs = current.tabs
          .filter((tab) => tab.workspace_id === focusedWorkspace?.workspace_id)
          .sort((a, b) => a.number - b.number);
        const targetTab = tabs[tabIndex];
        if (!targetTab) return;
        claim();
        store.focusTab(targetTab.tab_id);
        return;
      }
      if (isWorkspaceInspectorShortcut(e)) {
        if (isEditableElement(e.target)) return;
        claim();
        toggle();
        return;
      }
      if (shortcutMatches(e, "inspector.expand")) {
        if (mobile || isEditableElement(e.target)) return;
        claim();
        if (e.repeat) return;
        const current = stateRef.current;
        if (!current?.open) toggle();
        setExpanded(!current?.open || !current.expanded);
        return;
      }
      const actions: [ShortcutId, () => void][] = [
        ["files.toggle", () => toggleView("files")],
        ["workspaces.open", openWorkspaces],
        ["diff.toggle", () => toggleView("changes")],
        ["zen.toggle", toggleZenMode],
      ];
      for (const [id, action] of actions) {
        if (!shortcutMatches(e, id)) continue;
        if (isEditableElement(e.target)) return;
        claim();
        action();
        return;
      }
      if (!shortcutMatches(e, "sidebar.toggle") || isEditableElement(e.target))
        return;
      e.preventDefault();
      toggleSidebar();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const modifier = modifierRef.current;
      if (paneJumpOpen && modifier && !e[modifier]) {
        e.preventDefault();
        e.stopPropagation();
        commitPaneJump();
      }
    };
    const onBlur = () => {
      if (paneJumpOpen) closePaneJump();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onBlur);
    };
  }, [
    closePaneJump,
    commitPaneJump,
    mobile,
    modifierRef,
    movePaneJump,
    openRecent,
    openSearch,
    openWorkspaces,
    paneJumpCount,
    paneJumpOpen,
    paneJumpSearch,
    setExpanded,
    stateRef,
    toggle,
    toggleSidebar,
    toggleView,
    toggleZenMode,
  ]);
}
