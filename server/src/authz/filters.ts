import type { WorkspaceRole } from "../accounts/store";
import { workspaceCapabilities } from "./capabilities";
import { workspaceOfScopedId } from "./authorize";

/**
 * Per-principal views of cross-workspace data: list results, presence
 * snapshots, forwarded Herdr events and bridge status. `roleOf` returns the
 * viewer's role on a workspace of the connection, or null for none.
 * Instance admins bypass these filters. A share link narrowed to one pane
 * adds a `PaneScope`: only that pane, the tab holding it and the workspace
 * itself stay visible, and layouts shrink to the one pane.
 */

export type RoleOf = (workspaceId: string) => WorkspaceRole | null;

/** A guest link's pane and the tab holding it (null: not known yet). */
export type PaneScope = { pane: string; tab: string | null };

/** Whether a workspace-owned item is the scoped pane, its tab or neither. */
function inPaneScope(value: Record<string, unknown>, scope: PaneScope) {
  if (typeof value.pane_id === "string") return value.pane_id === scope.pane;
  if (typeof value.tab_id === "string") return value.tab_id === scope.tab;
  return true;
}

/**
 * A tab layout reduced to the scoped pane, filling the tab area; null when
 * the pane is not in it.
 */
export function narrowLayout(layout: unknown, scope: PaneScope): unknown {
  const value = record(layout);
  if (!value || !Array.isArray(value.panes)) return layout;
  const pane = value.panes
    .map(record)
    .find((item) => item?.pane_id === scope.pane);
  if (!pane) return null;
  return {
    ...value,
    zoomed: false,
    focused_pane_id: scope.pane,
    panes: [{ ...pane, focused: true, rect: value.area ?? pane.rect }],
    splits: [],
  };
}

/** A `pane.layout` result narrowed to the scoped pane. */
export function narrowLayoutResult(result: unknown, scope: PaneScope) {
  const value = record(result);
  if (!value || !record(value.layout)) return result;
  return { ...value, layout: narrowLayout(value.layout, scope) };
}

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
 * Workspace items gain `access` (the viewer's role) and `capabilities`
 * (what the UI may offer there) for the UI; under a pane scope their active
 * tab is the scoped pane's.
 */
export function filterListResult(
  result: unknown,
  roleOf: RoleOf,
  scope?: PaneScope | null,
): unknown {
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
      const value = record(item);
      if (!scope || !value) {
        return key === "workspaces"
          ? [
              {
                ...value,
                access: role,
                capabilities: workspaceCapabilities(role),
              },
            ]
          : [item];
      }
      if (!inPaneScope(value, scope)) return [];
      if (key === "workspaces")
        return [
          {
            ...value,
            access: role,
            capabilities: workspaceCapabilities(role),
            ...(scope.tab ? { active_tab_id: scope.tab } : {}),
          },
        ];
      if (!Array.isArray(value.panes)) return [item];
      const layout = narrowLayout(value, scope);
      return layout ? [layout] : [];
    });
  }
  return next;
}

/** Workspace items of an admin's list gain `access: "owner"` and every capability. */
export function annotateOwnerAccess(result: unknown): unknown {
  const value = record(result);
  if (!value || !Array.isArray(value.workspaces)) return result;
  const capabilities = workspaceCapabilities("owner", true);
  return {
    ...value,
    workspaces: value.workspaces.map((item) =>
      record(item) ? { ...record(item), access: "owner", capabilities } : item,
    ),
  };
}

/**
 * Presence visible to a viewer: participants located in readable
 * workspaces (and, under a pane scope, not elsewhere in it), claims and
 * display owners on visible panes, and the people and devices those
 * participants reference.
 */
export function filterPresenceSnapshot<T>(
  snapshot: T,
  roleOf: RoleOf,
  scope?: PaneScope | null,
): T {
  const value = record(snapshot);
  if (!value || !Array.isArray(value.participants)) return snapshot;
  const participants = value.participants.filter((participant) => {
    const item = record(participant);
    const workspace = item?.workspace_id;
    return (
      typeof workspace === "string" &&
      roleOf(workspace) !== null &&
      (!scope || inPaneScope(item!, scope))
    );
  });
  const claims = Array.isArray(value.pane_claims)
    ? readableItems(value.pane_claims, roleOf, scope)
    : value.pane_claims;
  const next: Record<string, unknown> = {
    ...value,
    participants,
    pane_claims: claims,
  };
  if (Array.isArray(value.display_owners))
    next.display_owners = readableItems(value.display_owners, roleOf, scope);
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

function readableItems(
  items: unknown[],
  roleOf: RoleOf,
  scope?: PaneScope | null,
): unknown[] {
  return items.filter((item) => {
    const workspace = workspaceOfItem(item);
    return (
      workspace !== null &&
      roleOf(workspace) !== null &&
      (!scope || inPaneScope(record(item)!, scope))
    );
  });
}

/** A result or event payload with `display_owners` narrowed to readable panes. */
export function filterDisplayOwners<T>(
  value: T,
  roleOf: RoleOf,
  scope?: PaneScope | null,
): T {
  const data = record(value);
  if (!data || !Array.isArray(data.display_owners)) return value;
  return {
    ...data,
    display_owners: readableItems(data.display_owners, roleOf, scope),
  } as T;
}

/** A collaboration RPC result with its snapshot filtered. */
export function filterPresenceResult(
  result: unknown,
  roleOf: RoleOf,
  scope?: PaneScope | null,
): unknown {
  const value = record(result);
  if (!value || !record(value.snapshot)) return result;
  return {
    ...value,
    snapshot: filterPresenceSnapshot(value.snapshot, roleOf, scope),
  };
}

/** Events that carry no workspace data and reach every browser. */
const GLOBAL_EVENTS = new Set([
  "session.resync_required",
  "settings.terminal_transport.updated",
]);

export type EventView = { event: unknown } | { resync: true } | null;

const NESTED_EVENT_KEYS = ["workspace", "tab", "pane", "layout", "focus"];

function eventWorkspaces(data: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === "string" && id) found.add(id);
  };
  add(data.workspace_id);
  add(data.previous_workspace_id);
  for (const key of NESTED_EVENT_KEYS) {
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
 * An event of a readable workspace as a pane-scoped guest sees it: unchanged
 * when it concerns only the scoped pane (or its tab, or just the workspace),
 * a resync when it also reshapes what the guest sees (a layout, a move),
 * nothing when it concerns only other panes or tabs.
 */
function scopedEvent(
  event: unknown,
  data: Record<string, unknown>,
  scope: PaneScope,
): EventView {
  const panes = new Set<string>();
  const tabs = new Set<string>();
  let layout = false;
  const collect = (value: Record<string, unknown>) => {
    for (const key of ["pane_id", "previous_pane_id"])
      if (typeof value[key] === "string") panes.add(value[key] as string);
    if (typeof value.tab_id === "string") tabs.add(value.tab_id);
    if (Array.isArray(value.panes)) layout = true;
  };
  collect(data);
  for (const key of NESTED_EVENT_KEYS) {
    const nested = record(data[key]);
    if (nested) collect(nested);
  }
  const named = [...panes];
  if (named.length > 0) {
    const inside = named.filter((pane) => pane === scope.pane).length;
    if (inside === 0) return null;
    // The pane moving to another tab reshapes the guest's view too.
    return inside === named.length &&
      !layout &&
      [...tabs].every((tab) => tab === scope.tab)
      ? { event }
      : { resync: true };
  }
  const tabList = [...tabs];
  if (tabList.length === 0) return { event };
  const inside = tabList.filter((tab) => tab === scope.tab).length;
  if (inside === 0) return null;
  return inside === tabList.length && !layout ? { event } : { resync: true };
}

/**
 * The version of a forwarded event a viewer may see: unchanged, filtered
 * (presence, workspace lists), a bare resync request (a pane moved between
 * a readable and an unreadable workspace), or nothing.
 */
export function filterEvent(
  event: unknown,
  roleOf: RoleOf,
  scope?: PaneScope | null,
): EventView {
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
        data: {
          ...data,
          snapshot: filterPresenceSnapshot(snapshot, roleOf, scope),
        },
      },
    };
  }
  if (name === "collaboration.display") {
    return {
      event: { ...value, data: filterDisplayOwners(data, roleOf, scope) },
    };
  }
  if (Array.isArray(data.workspaces) || Array.isArray(data.workspace_ids)) {
    // workspace.moved / workspace.reordered carry the whole list.
    const filtered = filterListResult(data, roleOf, scope) as Record<
      string,
      unknown
    >;
    const workspace = data.workspace_id;
    if (typeof workspace === "string" && roleOf(workspace) === null)
      delete filtered.workspace_id;
    return { event: { ...value, data: filtered } };
  }
  const workspaces = eventWorkspaces(data);
  if (workspaces.length === 0) return null;
  const readable = workspaces.filter((workspace) => roleOf(workspace) !== null);
  if (readable.length !== workspaces.length)
    return readable.length > 0 ? { resync: true } : null;
  return scope ? scopedEvent(event, data, scope) : { event };
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
