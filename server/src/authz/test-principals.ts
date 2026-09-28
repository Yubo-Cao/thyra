import type { ShareLink } from "../accounts/share-links";
import type { WorkspaceRole } from "../accounts/store";
import {
  guestPrincipal,
  LOCAL_PRINCIPAL,
  type Principal,
  userPrincipal,
} from "../auth/principal";
import type { AuthzDeps, PaneClaim } from "./authorize";

/**
 * Principals and authorization dependencies for tests: an instance admin,
 * the owner, an editor and a viewer of workspace `w1`, an outsider who owns
 * only `w2`, a share-link guest of `w1`, and a guest whose link shows only
 * pane `w1:p1`, all on connection `c1`.
 */

export const MATRIX_ROLES = [
  "admin",
  "owner",
  "editor",
  "viewer",
  "outsider",
  "guest",
  "guest-pane",
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
      avatar: null,
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

/** A share-link guest of `w1`, optionally narrowed to one pane. */
export function guest(
  name: string,
  paneId: string | null = null,
  workspaceId = "w1",
): Principal {
  const now = Date.now();
  const link: ShareLink = {
    id: `link-${name}`,
    connectionId: "c1",
    workspaceId,
    paneId,
    role: "viewer",
    label: name,
    createdBy: "u_owner",
    createdAt: now,
    expiresAt: now + 60_000,
    maxUses: null,
    uses: 1,
    revokedAt: null,
  };
  return guestPrincipal(
    {
      idHash: `hash-${name}`,
      publicId: `g-${name}`,
      linkId: link.id,
      userAgent: null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: link.expiresAt,
    },
    link,
    "owner",
  );
}

export const PRINCIPALS: Record<MatrixRole | "local", Principal> = {
  local: LOCAL_PRINCIPAL,
  admin: member("admin", "admin"),
  owner: member("owner", "member"),
  editor: member("editor", "member"),
  viewer: member("viewer", "member"),
  outsider: member("outsider", "member"),
  guest: guest("guest"),
  "guest-pane": guest("guest-pane", "w1:p1"),
};

const GRANTS: Record<string, Record<string, WorkspaceRole>> = {
  u_owner: { w1: "owner" },
  u_editor: { w1: "editor" },
  u_viewer: { w1: "viewer" },
  u_outsider: { w2: "owner" },
};

type Located = { workspace: string; pane: string; tab: string };

/** Terminals t1 (pane w1:p1), t3 (w1:p2, same tab) and t2 (w2:p1). */
export const TERMINALS: Record<string, Located> = {
  t1: { workspace: "w1", pane: "w1:p1", tab: "w1:t1" },
  t3: { workspace: "w1", pane: "w1:p2", tab: "w1:t1" },
  t2: { workspace: "w2", pane: "w2:p1", tab: "w2:t1" },
};

const PANES: Record<string, Located> = Object.fromEntries(
  Object.values(TERMINALS).map((location) => [location.pane, location]),
);

export function testDeps(
  options: {
    claims?: Record<string, PaneClaim>;
    participants?: Record<string, string>;
  } = {},
): AuthzDeps {
  return {
    roleOn(principal, connectionId, workspaceId) {
      if (connectionId !== "c1") return null;
      if (principal.kind === "guest")
        return principal.link.workspaceId === workspaceId ? "viewer" : null;
      if (principal.kind === "local" || principal.user.role === "admin")
        return "owner";
      return GRANTS[principal.user.id]?.[workspaceId] ?? null;
    },
    async locate(connectionId, target) {
      if (connectionId !== "c1") return null;
      if (target.terminal) return TERMINALS[target.terminal] ?? null;
      if (target.pane) return PANES[target.pane] ?? null;
      return null;
    },
    claimOf: (_connectionId, paneId) => options.claims?.[paneId] ?? null,
    principalOfParticipant: (participantId) =>
      options.participants?.[participantId] ?? null,
  };
}
