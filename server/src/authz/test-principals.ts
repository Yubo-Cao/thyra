import type { WorkspaceRole } from "../accounts/store";
import {
  LOCAL_PRINCIPAL,
  type Principal,
  userPrincipal,
} from "../auth/principal";
import type { AuthzDeps, PaneClaim } from "./authorize";

/**
 * Principals and authorization dependencies for tests: an instance admin,
 * the owner, an editor and a viewer of workspace `w1`, and an outsider who
 * owns only `w2`, all on connection `c1`.
 */

export const MATRIX_ROLES = [
  "admin",
  "owner",
  "editor",
  "viewer",
  "outsider",
] as const;
export type MatrixRole = (typeof MATRIX_ROLES)[number];

function member(name: string, role: "admin" | "member"): Principal {
  const now = Date.now();
  return userPrincipal(
    {
      id: `u_${name}`,
      name,
      displayName: name,
      role,
      disabled: false,
      privilegeEpoch: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      idHash: `hash-${name}`,
      publicId: `s-${name}`,
      userId: `u_${name}`,
      authMethod: "passkey",
      privilegeEpoch: 0,
      userAgent: null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 60_000,
    },
  );
}

export const PRINCIPALS: Record<MatrixRole | "local", Principal> = {
  local: LOCAL_PRINCIPAL,
  admin: member("admin", "admin"),
  owner: member("owner", "member"),
  editor: member("editor", "member"),
  viewer: member("viewer", "member"),
  outsider: member("outsider", "member"),
};

const GRANTS: Record<string, Record<string, WorkspaceRole>> = {
  u_owner: { w1: "owner" },
  u_editor: { w1: "editor" },
  u_viewer: { w1: "viewer" },
  u_outsider: { w2: "owner" },
};

export const TERMINALS: Record<string, { workspace: string; pane: string }> = {
  t1: { workspace: "w1", pane: "w1:p1" },
  t2: { workspace: "w2", pane: "w2:p1" },
};

export function testDeps(
  options: {
    claims?: Record<string, PaneClaim>;
    participants?: Record<string, string>;
  } = {},
): AuthzDeps {
  return {
    roleOn(principal, connectionId, workspaceId) {
      if (connectionId !== "c1") return null;
      if (principal.kind === "local" || principal.user.role === "admin")
        return "owner";
      return GRANTS[principal.user.id]?.[workspaceId] ?? null;
    },
    async locate(connectionId, target) {
      if (connectionId !== "c1") return null;
      if (target.terminal) return TERMINALS[target.terminal] ?? null;
      return null;
    },
    claimOf: (_connectionId, paneId) => options.claims?.[paneId] ?? null,
    principalOfParticipant: (participantId) =>
      options.participants?.[participantId] ?? null,
  };
}
