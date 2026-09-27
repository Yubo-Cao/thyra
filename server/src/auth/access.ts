import {
  type AccountStore,
  grantKey,
  type WorkspaceRole,
  workspaceRoleAtLeast,
} from "../accounts/store";
import { isInstanceAdmin, type Principal } from "./principal";

/**
 * Workspace grants in memory for per-request checks and per-socket event
 * filtering. The cache is dropped when the account database changes, in this
 * process (`invalidate`) or another one (`refresh`, which the server calls
 * periodically and compares `PRAGMA data_version`).
 */
export type AccessControl = ReturnType<typeof createAccessControl>;

export function createAccessControl(store: AccountStore) {
  let stamp = store.changeStamp();
  let cache = new Map<string, Map<string, WorkspaceRole>>();

  function grantsOf(userId: string): Map<string, WorkspaceRole> {
    let grants = cache.get(userId);
    if (!grants) {
      grants = store.grantsOf(userId);
      cache.set(userId, grants);
    }
    return grants;
  }

  function roleOn(
    principal: Principal,
    connectionId: string,
    workspaceId: string,
  ): WorkspaceRole | null {
    if (isInstanceAdmin(principal)) return "owner";
    // A share link's guest views its one workspace (narrowed further to a
    // pane by `authorizeTarget` and the filters).
    if (principal.kind === "guest")
      return principal.link.connectionId === connectionId &&
        principal.link.workspaceId === workspaceId
        ? principal.link.role
        : null;
    if (principal.kind !== "user") return null;
    return (
      grantsOf(principal.user.id).get(grantKey(connectionId, workspaceId)) ??
      null
    );
  }

  function connectionsOf(principal: Principal): Set<string> {
    const connections = new Set<string>();
    if (principal.kind === "guest") {
      connections.add(principal.link.connectionId);
      return connections;
    }
    if (principal.kind !== "user") return connections;
    for (const key of grantsOf(principal.user.id).keys())
      connections.add(key.split("\u0000")[0]!);
    return connections;
  }

  return {
    roleOn,
    /** A role lookup bound to one principal and connection, for filters. */
    roleOf(principal: Principal, connectionId: string) {
      return (workspaceId: string) =>
        roleOn(principal, connectionId, workspaceId);
    },
    /** Whether a principal edits a workspace on a connection (null: any). */
    editsConnection(
      principal: Principal,
      connectionId: string | null,
    ): boolean {
      if (isInstanceAdmin(principal)) return true;
      if (principal.kind !== "user") return false;
      for (const [key, role] of grantsOf(principal.user.id)) {
        if (
          (connectionId === null || key.startsWith(`${connectionId}\u0000`)) &&
          workspaceRoleAtLeast(role, "editor")
        )
          return true;
      }
      return false;
    },
    /** Connections where a non-admin holds any grant. */
    connectionsOf,
    /** Whether the owner of a Web Push subscription may see a workspace. */
    subscriberSees(
      owner: string | undefined,
      connectionId: string,
      workspaceId: string,
    ): boolean {
      if (!owner || owner === "local") return true;
      // Guests never subscribe; fail closed for any other owner kind.
      if (!owner.startsWith("user:")) return false;
      const userId = owner.startsWith("user:") ? owner.slice(5) : null;
      const user = userId ? store.getUser(userId) : null;
      if (!user || user.disabled) return false;
      if (user.role === "admin") return true;
      return grantsOf(user.id).has(grantKey(connectionId, workspaceId));
    },
    /** Drop cached grants after an in-process change (`refresh` still reports it). */
    invalidate() {
      cache = new Map();
    },
    /** Drop the cache when the database changed; returns whether it did. */
    refresh(): boolean {
      const next = store.changeStamp();
      if (next === stamp) return false;
      stamp = next;
      cache = new Map();
      return true;
    },
  };
}
