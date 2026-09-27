import type { BridgePrincipal } from "./api";
import { useStoreSelector } from "./store/core";
import type { Workspace, WorkspaceCapability } from "./types";

// What the interface offers is what the bridge reports the caller may do:
// per workspace (`edit`, `manage`) on each listed workspace, and host-wide
// (`host`) on the principal (see principal.ts). The bridge refuses the rest
// anyway; hiding it keeps viewers and guests from actions that would fail.

/** Whether this workspace offers `capability` to the caller. */
export function workspaceCan(
  workspace: Pick<Workspace, "capabilities"> | null | undefined,
  capability: WorkspaceCapability,
): boolean {
  return workspace?.capabilities?.includes(capability) === true;
}

/** `workspaceCan` for a workspace id, following the store. */
export function useWorkspaceCan(
  workspaceId: string | null | undefined,
  capability: WorkspaceCapability,
): boolean {
  return useStoreSelector((state) =>
    workspaceCan(
      state.workspaces.find((w) => w.workspace_id === workspaceId),
      capability,
    ),
  );
}

/**
 * Whether a principal is offered host-wide actions (instance admins and
 * direct local use): creating and reordering workspaces, worktrees, the
 * project launcher, connections and settings. Before the hello the page
 * acts as the only user it knows, the owner.
 */
export function hostCapable(principal: BridgePrincipal | null | undefined) {
  return !principal || principal.capabilities?.includes("host") === true;
}

/** `hostCapable` for this page's principal, following the store. */
export function useHostCapable(): boolean {
  return useStoreSelector((state) => state.host !== false);
}
