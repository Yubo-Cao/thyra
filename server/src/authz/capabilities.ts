import { type WorkspaceRole, workspaceRoleAtLeast } from "../accounts/store";
import { minimumRole, RPC_POLICY, requiresInstanceAdmin } from "./policy";

/**
 * What the interface may offer a principal, derived from the authorization
 * table so the browser hides exactly what the bridge would refuse (which it
 * still does). Each capability names the policy entry that decides it.
 *
 * - `edit` (per workspace): change layout, type, edit files, run Git.
 * - `manage` (per workspace): rename, close and share it.
 * - `host` (principal): instance-admin actions such as creating or
 *   reordering workspaces, worktrees, the project launcher and settings.
 */
const WORKSPACE_CAPABILITIES = {
  edit: "pane.split",
  manage: "workspace.close",
} as const;
const HOST_CAPABILITY = "workspace.create";

export type WorkspaceCapability = keyof typeof WORKSPACE_CAPABILITIES;

/** The capabilities a workspace role (or an instance admin) holds there. */
export function workspaceCapabilities(
  role: WorkspaceRole | null,
  admin = false,
): WorkspaceCapability[] {
  return (
    Object.entries(WORKSPACE_CAPABILITIES) as [WorkspaceCapability, string][]
  )
    .filter(([, method]) => {
      const entry = RPC_POLICY[method]!;
      if (admin) return true;
      return (
        !requiresInstanceAdmin(entry) &&
        role !== null &&
        workspaceRoleAtLeast(role, minimumRole(entry))
      );
    })
    .map(([capability]) => capability);
}

/** Host-wide capabilities: only instance admins (and local use) hold them. */
export function principalCapabilities(admin: boolean): "host"[] {
  return admin || !requiresInstanceAdmin(RPC_POLICY[HOST_CAPABILITY]!)
    ? ["host"]
    : [];
}
