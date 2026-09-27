// Plugin popups: the session-modal floating pane a plugin such as Herdr Float
// opens, tracked per connection from bridge pushes.
import type { PopupStatePush } from "../api";
import { action } from "./actions";
import {
  connectionEventIsActive,
  leaseIsCurrent,
  type PopupInfo,
  set,
  setForConnection,
  state,
} from "./core";

export function handlePopupPush(push: PopupStatePush) {
  if (
    !state.connectionPaused &&
    connectionEventIsActive(
      state,
      push.connection_id,
      push.connection_generation,
    )
  ) {
    set({ popup: push.popup });
  }
}

/**
 * Ask the bridge which popup Herdr currently has open. Pushes only fire on
 * change, so a browser that just connected, or just switched connection, has
 * to ask once.
 */
export function watchPopup() {
  return action(async (lease) => {
    const result = (await lease.client.call("terminal.watch_popup", {})) as
      | { popup: PopupInfo | null }
      | undefined;
    setForConnection(lease, { popup: result?.popup ?? null });
  });
}

export const popupActions = {
  /** Close the open popup, if any (Herdr's generic popup.close method). */
  closePopup() {
    return action((lease) => lease.client.call("popup.close", {}));
  },

  /**
   * Hide the popup if one is open, otherwise invoke the plugin action that
   * opens it.
   *
   * Asks Herdr rather than trusting this client's popup state, which can lag
   * behind: opening on a stale "none" is refused with "a popup pane is already
   * open", and that refusal only ever reaches the plugin's command log, so the
   * key would look dead. "popup_not_open" is the definitive answer that
   * nothing was open and the action should run.
   */
  togglePluginPopup(
    pluginId: string,
    actionId: string,
    context: Record<string, unknown> = {},
  ) {
    return action(async (lease) => {
      try {
        await lease.client.call("popup.close", {});
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("popup_not_open")) throw error;
      }
      if (!leaseIsCurrent(lease)) return;
      // Herdr opens a popup in whichever Space it has focused, and a plugin
      // handed a different one declines: herdr-float reports "Space changed"
      // and exits successfully, so the key looks dead. Match Herdr's focus to
      // the Space the action is invoked for.
      const workspaceId = context.workspace_id;
      if (typeof workspaceId === "string" && workspaceId) {
        const focused = state.workspaces.find((w) => w.focused);
        if (focused?.workspace_id !== workspaceId) {
          await lease.client.call("workspace.focus", {
            workspace_id: workspaceId,
          });
          if (!leaseIsCurrent(lease)) return;
        }
      }
      await lease.client.call("plugin.action.invoke", {
        plugin_id: pluginId,
        action_id: actionId,
        context,
      });
    });
  },
};
