import { type WorkspaceRole, workspaceRoleAtLeast } from "../accounts/store";
import { isInstanceAdmin, type Principal } from "../auth/principal";
import {
  lookupRpc,
  minimumRole,
  requiresInstanceAdmin,
  type RpcPolicyEntry,
  type RpcTarget,
} from "./policy";

/**
 * `authorize(principal, method, params)`: the single decision point for
 * WebSocket RPCs (and, through `authorizeTarget`, HTTP routes). It applies
 * the policy table, workspace grants and single-writer pane control.
 */

export const TAKEOVER_PROTECTION_MS = 15_000;

export type PaneClaim = {
  participantId: string;
  protectedUntil?: number;
};

export type AuthzDeps = {
  /** The caller's role on a workspace (null: no access). Admins are owners. */
  roleOn(
    principal: Principal,
    connectionId: string,
    workspaceId: string,
  ): WorkspaceRole | null;
  /** Workspace (and pane, for terminals) of an id not scoped by its prefix. */
  locate(
    connectionId: string,
    target: { tab?: string; pane?: string; terminal?: string },
  ): Promise<{ workspace: string; pane?: string } | null>;
  /** The live claim on a pane. */
  claimOf(connectionId: string, paneId: string): PaneClaim | null;
  /** The principal key that owns a presence participant. */
  principalOfParticipant(participantId: string): string | null;
  now?: () => number;
};

export type RpcRequestContext = {
  principal: Principal;
  method: string;
  params: Record<string, unknown>;
  /** Routed connection; null for bridge-global methods. */
  connectionId: string | null;
  /** The caller's presence participant id. */
  participantId: string | null;
};

export type RpcAuthorization =
  | { allowed: false; message: string }
  | {
      allowed: true;
      entry: RpcPolicyEntry;
      /** Parameters to dispatch (the caller's, possibly narrowed). */
      params: Record<string, unknown>;
      /** The pane the request controls, for single-writer methods. */
      paneId?: string;
      /** Claim the unclaimed pane for the caller before sending input. */
      autoClaim?: boolean;
      /** Workspace owners and admins may take control during protection. */
      takeoverAnytime?: boolean;
      /** Reply with this instead of dispatching (see `deniedResult`). */
      stub?: { result: unknown };
    };

const deny = (message: string): RpcAuthorization => ({
  allowed: false,
  message,
});

/** `w1` from Herdr's workspace-scoped pane and tab ids (`w1:p3`, `w1:t2`). */
export function workspaceOfScopedId(value: string): string | null {
  const match = /^([^:\s]+):[pt][^:\s]*$/.exec(value);
  return match?.[1] ?? null;
}

type Resolved = {
  roles: (WorkspaceRole | null)[];
  workspaces: string[];
  pane?: string;
};

/**
 * Resolve every id in a target to a workspace and the caller's role there.
 * Returns an error message when an id cannot be resolved (fail closed).
 */
export async function resolveTarget(
  principal: Principal,
  connectionId: string,
  target: RpcTarget,
  deps: AuthzDeps,
): Promise<Resolved | string> {
  const workspaces = new Set<string>();
  let pane = target.pane;
  if (target.workspace) workspaces.add(target.workspace);
  for (const [kind, value] of [
    ["tab", target.tab],
    ["pane", target.pane],
  ] as const) {
    if (!value) continue;
    const scoped = workspaceOfScopedId(value);
    if (scoped) {
      workspaces.add(scoped);
      continue;
    }
    const located = await deps.locate(connectionId, { [kind]: value });
    if (!located) return `unknown ${kind} ${value}`;
    workspaces.add(located.workspace);
  }
  if (target.terminal) {
    const located = await deps.locate(connectionId, {
      terminal: target.terminal,
    });
    if (!located) return `unknown terminal ${target.terminal}`;
    workspaces.add(located.workspace);
    pane ??= located.pane;
  }
  const list = [...workspaces];
  return {
    workspaces: list,
    roles: list.map((workspace) =>
      deps.roleOn(principal, connectionId, workspace),
    ),
    ...(pane ? { pane } : {}),
  };
}

/**
 * Authorize a target (shared by RPC and HTTP): instance-admin scopes, then
 * the least role over every named workspace.
 */
export async function authorizeTarget(args: {
  principal: Principal;
  connectionId: string | null;
  target: RpcTarget;
  minimum: WorkspaceRole;
  deps: AuthzDeps;
}): Promise<{ ok: true; resolved: Resolved } | { ok: false; message: string }> {
  const admin = isInstanceAdmin(args.principal);
  if (args.target.host && !admin)
    return { ok: false, message: "this needs an instance admin" };
  if (!args.connectionId) {
    return admin
      ? { ok: true, resolved: { roles: [], workspaces: [] } }
      : { ok: false, message: "no connection for this request" };
  }
  const named =
    args.target.workspace ||
    args.target.tab ||
    args.target.pane ||
    args.target.terminal;
  if (!named) {
    return admin
      ? { ok: true, resolved: { roles: [], workspaces: [] } }
      : { ok: false, message: "this request must name a workspace" };
  }
  const resolved = await resolveTarget(
    args.principal,
    args.connectionId,
    args.target,
    args.deps,
  );
  if (typeof resolved === "string") {
    // Admins keep full access to ids the bridge cannot place.
    return admin
      ? { ok: true, resolved: { roles: [], workspaces: [] } }
      : { ok: false, message: resolved };
  }
  if (!resolved.roles.every((role) => workspaceRoleAtLeast(role, args.minimum)))
    return {
      ok: false,
      message:
        args.minimum === "viewer"
          ? "you do not have access to this workspace"
          : `this needs the ${args.minimum} role on the workspace`,
    };
  return { ok: true, resolved };
}

export async function authorize(
  request: RpcRequestContext,
  deps: AuthzDeps,
): Promise<RpcAuthorization> {
  const { principal, method, connectionId } = request;
  const lookup = lookupRpc(method);
  if (!lookup.allowed) return deny(lookup.message);
  const entry = lookup.entry;
  const admin = isInstanceAdmin(principal);
  let params = request.params;
  if (requiresInstanceAdmin(entry) && !admin)
    return entry.deniedResult === undefined
      ? deny(`${method} needs an instance admin`)
      : { allowed: true, entry, params, stub: { result: entry.deniedResult } };

  if (entry.scope === "session" || entry.scope === "host")
    return { allowed: true, entry, params };

  if (entry.scope === "list") {
    const workspace = params.workspace_id;
    if (typeof workspace === "string" && workspace && !admin) {
      const decision = await authorizeTarget({
        principal,
        connectionId,
        target: { workspace },
        minimum: "viewer",
        deps,
      });
      if (!decision.ok) return deny(`${method}: ${decision.message}`);
    }
    return { allowed: true, entry, params };
  }

  const target = entry.resolve?.(params) ?? {};
  const minimum = minimumRole(entry);
  const decision = await authorizeTarget({
    principal,
    connectionId,
    target,
    minimum,
    deps,
  });
  if (!decision.ok) return deny(`${method}: ${decision.message}`);
  const { resolved } = decision;
  const paneId = resolved.pane;
  const roleFloor = (): WorkspaceRole | null => {
    if (admin) return "owner";
    let least: WorkspaceRole | null = null;
    for (const role of resolved.roles) {
      if (!role) return null;
      if (!least || workspaceRoleAtLeast(least, role)) least = role;
    }
    return least;
  };

  // Another participant (not this principal's other page) holds the pane.
  const heldByOther = (): PaneClaim | null => {
    if (!connectionId || !paneId) return null;
    const claim = deps.claimOf(connectionId, paneId);
    if (!claim || claim.participantId === request.participantId) return null;
    return deps.principalOfParticipant(claim.participantId) === principal.key
      ? null
      : claim;
  };

  if (method === "terminal.scroll") {
    // Only a writer may scroll into the application (page keys, wheel
    // reporting); everyone else scrolls Herdr's history.
    const writer =
      workspaceRoleAtLeast(roleFloor(), "editor") && !heldByOther();
    if (!writer) params = { ...params, source: "history" };
    return { allowed: true, entry, params, ...(paneId ? { paneId } : {}) };
  }

  if (method === "collaboration.claim") {
    const requested =
      typeof params.protect_ms === "number" &&
      Number.isFinite(params.protect_ms)
        ? Math.max(0, Math.min(TAKEOVER_PROTECTION_MS, params.protect_ms))
        : undefined;
    return {
      allowed: true,
      entry,
      params:
        requested === undefined ? params : { ...params, protect_ms: requested },
      ...(paneId ? { paneId } : {}),
      takeoverAnytime: roleFloor() === "owner",
    };
  }

  if (entry.writer) {
    const other = heldByOther();
    if (other)
      return deny(
        `${method}: another collaborator controls this pane; take control first`,
      );
    return {
      allowed: true,
      entry,
      params,
      ...(paneId ? { paneId } : {}),
      autoClaim:
        entry.writer === "input" &&
        !!paneId &&
        !!connectionId &&
        !deps.claimOf(connectionId, paneId),
    };
  }
  return { allowed: true, entry, params, ...(paneId ? { paneId } : {}) };
}
