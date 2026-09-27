import type { WorkspaceRole } from "../accounts/store";
import { workspaceOfScopedId } from "./authorize";

/**
 * Per-principal views of cross-workspace data: list results, presence
 * snapshots, forwarded Herdr events and bridge status. `roleOf` returns the
 * viewer's role on a workspace of the connection, or null for none.
 * Instance admins bypass these filters.
 */

export type RoleOf = (workspaceId: string) => WorkspaceRole | null;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function workspaceOfItem(item: unknown): string | null {
  const value = record(item);
  if (!value) return null;
  if (typeof value.workspace_id === "string") return value.workspace_id;
  for (const key of ["pane_id", "tab_id"]) {
    const id = value[key];
    if (typeof id === "string") return workspaceOfScopedId(id);
  }
  return null;
}

/**
 * Filter every top-level array of workspace-owned items (`workspaces`,
 * `tabs`, `panes`, `agents`, `layouts`, ...) to readable workspaces.
 * Workspace items gain `access` (the viewer's role) for the UI.
 */
export function filterListResult(result: unknown, roleOf: RoleOf): unknown {
  const value = record(result);
  if (!value) return result;
  const next: Record<string, unknown> = { ...value };
  for (const [key, items] of Object.entries(value)) {
    if (!Array.isArray(items)) continue;
    if (key === "workspace_ids") {
      next[key] = items.filter(
        (id) => typeof id === "string" && roleOf(id) !== null,
      );
      continue;
    }
    if (!items.some((item) => record(item))) continue;
    next[key] = items.flatMap((item) => {
      const workspace = workspaceOfItem(item);
      const role = workspace ? roleOf(workspace) : null;
      if (!role) return [];
      return key === "workspaces"
        ? [{ ...record(item), access: role }]
        : [item];
    });
  }
  return next;
}

/** Workspace items of an admin's list gain `access: "owner"`. */
export function annotateOwnerAccess(result: unknown): unknown {
  const value = record(result);
  if (!value || !Array.isArray(value.workspaces)) return result;
  return {
    ...value,
    workspaces: value.workspaces.map((item) =>
      record(item) ? { ...record(item), access: "owner" } : item,
    ),
  };
}

/**
 * Presence visible to a viewer: participants located in readable
 * workspaces, claims on their panes, and the people and devices those
 * participants reference.
 */
export function filterPresenceSnapshot<T>(snapshot: T, roleOf: RoleOf): T {
  const value = record(snapshot);
  if (!value || !Array.isArray(value.participants)) return snapshot;
  const participants = value.participants.filter((participant) => {
    const workspace = record(participant)?.workspace_id;
    return typeof workspace === "string" && roleOf(workspace) !== null;
  });
  const claims = Array.isArray(value.pane_claims)
    ? value.pane_claims.filter((claim) => {
        const workspace = workspaceOfItem(claim);
        return workspace !== null && roleOf(workspace) !== null;
      })
    : value.pane_claims;
  const next: Record<string, unknown> = {
    ...value,
    participants,
    pane_claims: claims,
  };
  if (Array.isArray(value.display_owners))
    next.display_owners = readableItems(value.display_owners, roleOf);
  for (const [table, key] of [
    ["people", "person_id"],
    ["devices", "device_id"],
  ] as const) {
    const entries = record(value[table]);
    if (!entries) continue;
    const kept = new Set(
      participants.flatMap((participant) => {
        const id = record(participant)?.[key];
        return typeof id === "string" ? [id] : [];
      }),
    );
    next[table] = Object.fromEntries(
      Object.entries(entries).filter(([id]) => kept.has(id)),
    );
  }
  return next as T;
}

function readableItems(items: unknown[], roleOf: RoleOf): unknown[] {
  return items.filter((item) => {
    const workspace = workspaceOfItem(item);
    return workspace !== null && roleOf(workspace) !== null;
  });
}

/** A result or event payload with `display_owners` narrowed to readable panes. */
export function filterDisplayOwners<T>(value: T, roleOf: RoleOf): T {
  const data = record(value);
  if (!data || !Array.isArray(data.display_owners)) return value;
  return {
    ...data,
    display_owners: readableItems(data.display_owners, roleOf),
  } as T;
}

/** A collaboration RPC result with its snapshot filtered. */
export function filterPresenceResult(result: unknown, roleOf: RoleOf): unknown {
  const value = record(result);
  if (!value || !record(value.snapshot)) return result;
  return { ...value, snapshot: filterPresenceSnapshot(value.snapshot, roleOf) };
}

/** Events that carry no workspace data and reach every browser. */
const GLOBAL_EVENTS = new Set([
  "session.resync_required",
  "settings.terminal_transport.updated",
]);

export type EventView = { event: unknown } | { resync: true } | null;

function eventWorkspaces(data: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === "string" && id) found.add(id);
  };
  add(data.workspace_id);
  add(data.previous_workspace_id);
  for (const key of ["workspace", "tab", "pane", "layout", "focus"]) {
    const nested = record(data[key]);
    if (nested) add(nested.workspace_id ?? workspaceOfItem(nested));
  }
  for (const key of ["pane_id", "tab_id", "previous_pane_id"]) {
    const id = data[key];
    if (typeof id === "string") add(workspaceOfScopedId(id));
  }
  return [...found];
}

/**
 * The version of a forwarded event a viewer may see: unchanged, filtered
 * (presence, workspace lists), a bare resync request (a pane moved between
 * a readable and an unreadable workspace), or nothing.
 */
export function filterEvent(event: unknown, roleOf: RoleOf): EventView {
  const value = record(event);
  const name = value?.event;
  if (!value || typeof name !== "string") return null;
  if (GLOBAL_EVENTS.has(name)) return { event };
  const data = record(value.data) ?? {};
  if (name === "collaboration.updated" || name === "collaboration_updated") {
    const snapshot = record(data.snapshot);
    if (!snapshot) return null;
    return {
      event: {
        ...value,
        data: { ...data, snapshot: filterPresenceSnapshot(snapshot, roleOf) },
      },
    };
  }
  if (name === "collaboration.display") {
    return { event: { ...value, data: filterDisplayOwners(data, roleOf) } };
  }
  if (Array.isArray(data.workspaces) || Array.isArray(data.workspace_ids)) {
    // workspace.moved / workspace.reordered carry the whole list.
    const filtered = filterListResult(data, roleOf) as Record<string, unknown>;
    const workspace = data.workspace_id;
    if (typeof workspace === "string" && roleOf(workspace) === null)
      delete filtered.workspace_id;
    return { event: { ...value, data: filtered } };
  }
  const workspaces = eventWorkspaces(data);
  if (workspaces.length === 0) return null;
  const readable = workspaces.filter((workspace) => roleOf(workspace) !== null);
  if (readable.length === workspaces.length) return { event };
  return readable.length > 0 ? { resync: true } : null;
}

/**
 * Connection summaries for a non-admin: the connections it may use, without
 * profile details (SSH destinations, socket paths, errors).
 */
export function filterConnections(
  connections: unknown,
  connectionVisible: (connectionId: string) => boolean,
): unknown[] {
  if (!Array.isArray(connections)) return [];
  return connections.flatMap((item) => {
    const connection = record(item);
    const id = connection?.id;
    if (typeof id !== "string" || !connectionVisible(id)) return [];
    return [
      {
        id,
        label: connection?.label,
        source: connection?.source,
        is_default: connection?.is_default,
        state: connection?.state,
        generation: connection?.generation,
      },
    ];
  });
}

/** `bridge.status` for a non-admin: counts and its connections, no host details. */
export function filterBridgeStatus(
  status: Record<string, unknown>,
  connectionVisible: (connectionId: string) => boolean,
): Record<string, unknown> {
  return {
    clients: status.clients,
    devices: status.devices,
    terminals: [],
    default_connection_id: status.default_connection_id,
    connections: filterConnections(status.connections, connectionVisible),
  };
}
