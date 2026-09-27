// Workspace, tab and pane mutations: create, rename, close, move, split,
// zoom and resize. New targets are adopted by browser-local navigation.
import { projectBrowserLayout } from "../browserNavigation";
import { t } from "../i18n";
import { rememberTabLayout } from "../tabLayout";
import { action, noticeFor } from "./actions";
import { errorNotice, failWith, setForConnection, state } from "./core";
import {
  adoptBrowserTarget,
  browserCreationSource,
  browserSelectionIsCurrent,
  endpointCreationReason,
} from "./navigation";

interface NumberedTabRename {
  tabId: string;
  label: string;
}

/** Builds a stable GUI label from Herdr's authoritative created-tab number. */
export function numberedCreatedTabRename(
  result: unknown,
): NumberedTabRename | null {
  if (!result || typeof result !== "object") return null;
  const response = result as { type?: unknown; tab?: unknown };
  if (response.type !== "tab_created" || !response.tab) return null;
  if (typeof response.tab !== "object") return null;

  const { tab_id: tabId, number } = response.tab as {
    tab_id?: unknown;
    number?: unknown;
  };
  if (
    typeof tabId !== "string" ||
    !tabId ||
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number < 1
  ) {
    return null;
  }
  return { tabId, label: t("Tab {number}", { number }) };
}

/** Creation focuses Herdr in shared mode; browser-local names its source. */
function creationTarget(workspaceId: string | null) {
  return state.navigationMode === "browser-local"
    ? { focus: false, browser_source: browserCreationSource(workspaceId) }
    : { focus: true };
}

export const workspaceActions = {
  createWorkspace(label?: string, cwd?: string) {
    const navigation = state.browserNavigation;
    return action(
      async (lease) => {
        const reason = endpointCreationReason(state, "workspace.create");
        if (reason) throw new Error(reason);
        const result = await lease.client.call("workspace.create", {
          label,
          cwd,
          ...creationTarget(state.browserNavigation.workspaceId),
        });
        if (browserSelectionIsCurrent(navigation))
          adoptBrowserTarget(lease, result);
        return result;
      },
      { failureNotice: failWith(t("Workspace creation failed")) },
    );
  },

  renameWorkspace(workspaceId: string, label: string) {
    return action((lease) =>
      lease.client.call("workspace.rename", {
        workspace_id: workspaceId,
        label,
      }),
    );
  },

  closeWorkspace(workspaceId: string) {
    return action(
      (lease) =>
        lease.client.call("workspace.close", { workspace_id: workspaceId }),
      {
        failureNotice: (error) => ({
          kind: "error",
          message: error.message.startsWith("workspace_group_close_required:")
            ? t("Workspace belongs to a group")
            : t("Workspace close failed"),
          detail: error.message.startsWith("workspace_group_close_required:")
            ? t(
                "Nothing was closed. To close this workspace and its linked workspaces, explicitly close the group in the Herdr CLI with --group.",
              )
            : error.message,
        }),
      },
    );
  },

  moveWorkspace(workspaceId: string, insertIndex: number) {
    return action(
      (lease) =>
        lease.client.call("workspace.move", {
          workspace_id: workspaceId,
          insert_index: insertIndex,
        }),
      { refresh: "immediate" },
    );
  },

  createTab(workspaceId: string, options: { numberedLabel?: boolean } = {}) {
    const navigation = state.browserNavigation;
    return action(
      async (lease) => {
        const reason = endpointCreationReason(state, "tab.create", workspaceId);
        if (reason) throw new Error(reason);
        const result: unknown = await lease.client.call("tab.create", {
          workspace_id: workspaceId,
          ...creationTarget(workspaceId),
        });
        if (browserSelectionIsCurrent(navigation))
          adoptBrowserTarget(lease, result);
        if (!options.numberedLabel) return result;

        const rename = numberedCreatedTabRename(result);
        if (!rename) return result;
        try {
          await lease.client.call("tab.rename", {
            tab_id: rename.tabId,
            label: rename.label,
          });
        } catch (error) {
          // The tab already exists, so keep the successful create visible while
          // surfacing the non-fatal naming failure to the user.
          noticeFor(
            lease,
            errorNotice(t("Tab created, but naming failed"), error),
          );
        }
        return result;
      },
      { failureNotice: failWith(t("Tab creation failed")) },
    );
  },

  closeTab(tabId: string) {
    return action((lease) => lease.client.call("tab.close", { tab_id: tabId }));
  },

  renameTab(tabId: string, label: string) {
    return action((lease) =>
      lease.client.call("tab.rename", { tab_id: tabId, label }),
    );
  },

  splitPane(paneId: string, direction: "right" | "down") {
    const navigation = state.browserNavigation;
    return action(async (lease) => {
      const result = await lease.client.call("pane.split", {
        target_pane_id: paneId,
        direction,
        focus: state.navigationMode !== "browser-local",
      });
      const selectionIsCurrent = browserSelectionIsCurrent(navigation);
      if (selectionIsCurrent) adoptBrowserTarget(lease, result);
      const nextPaneId =
        typeof result?.pane?.pane_id === "string" ? result.pane.pane_id : null;
      if (nextPaneId && selectionIsCurrent)
        setForConnection(lease, { selectedPaneId: nextPaneId });
      return result;
    });
  },

  zoomPane(paneId: string) {
    return action((lease) =>
      lease.client.call("pane.zoom", { pane_id: paneId }),
    );
  },

  resizePane(
    paneId: string,
    direction: "left" | "right" | "up" | "down",
    amount: number,
  ) {
    return action(async (lease) => {
      const result = await lease.client.call("pane.resize", {
        pane_id: paneId,
        direction,
        amount,
      });
      const layout = result?.resize?.layout;
      rememberTabLayout(lease.connectionId, lease.generation, layout ?? null);
      if (layout && state.layout?.tab_id === layout.tab_id)
        setForConnection(lease, {
          layout:
            state.navigationMode === "browser-local"
              ? projectBrowserLayout(layout, state.selectedPaneId)
              : layout,
        });
      return result;
    });
  },

  closePane(paneId: string) {
    return action((lease) =>
      lease.client.call("pane.close", { pane_id: paneId }),
    );
  },
};
