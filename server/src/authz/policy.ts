import type { WorkspaceRole } from "../accounts/store";

/**
 * Deny-by-default authorization table for WebSocket RPC methods.
 *
 * Every method a browser may call must be listed in `RPC_POLICY`, whether the
 * bridge implements it or forwards it to Herdr. Anything else, including
 * Herdr methods the web client never uses, is rejected before dispatch.
 *
 * Each entry has a class (the authority it exercises) and a scope (what it
 * acts on). `authorize()` in `./authorize.ts` combines them with the caller:
 *
 * - `admin` and `dangerous` classes, and the `host` scope, need an instance
 *   admin (or direct local use).
 * - `session` methods act only on the caller's own socket, presence or
 *   profile; any logged-in principal may call them. Share-link guests may
 *   call only those marked `guest`.
 * - Guests otherwise hold the viewer role on their link's workspace; a link
 *   narrowed to one pane admits only requests naming that pane (or its tab),
 *   never workspace-wide ones such as files or Git.
 * - `workspace` methods name their target through `resolve(params)`; every
 *   named workspace, tab, pane or terminal must resolve to a workspace where
 *   the caller holds at least `minimum` (default: viewer for reads, editor
 *   for writes).
 * - `list` methods read across workspaces; results and events are filtered
 *   to the caller's workspaces.
 * - `writer` marks single-writer pane control: only the pane's claim holder
 *   may send input (`input`, which also claims an unclaimed pane) or change
 *   the pane's size and focus (`control`).
 */

export type RpcClass = "read" | "write" | "admin" | "dangerous";
export type RpcScope = "session" | "workspace" | "list" | "host";

/** Identifiers a request names; every present one is authorized. */
export type RpcTarget = {
  workspace?: string;
  tab?: string;
  pane?: string;
  terminal?: string;
  /** The request reaches outside any workspace (host filesystem, repo). */
  host?: boolean;
};

export type RpcPolicyEntry = {
  class: RpcClass;
  scope: RpcScope;
  /** The bridge forwards the call to Herdr unchanged (after enrichment). */
  herdr?: true;
  resolve?: (params: Record<string, unknown>) => RpcTarget;
  /** Least workspace role; defaults by class. */
  minimum?: WorkspaceRole;
  writer?: "input" | "control";
  /** A `session` method share-link guests may call (default: denied). */
  guest?: true;
  /**
   * Answer for callers the method is not allowed for, instead of an error,
   * when the browser calls it routinely (host theme, popup state). Nothing
   * is dispatched.
   */
  deniedResult?: unknown;
};

function id(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export const targetResolvers = {
  workspace: (p: Record<string, unknown>): RpcTarget => ({
    workspace: id(p.workspace_id),
  }),
  tab: (p: Record<string, unknown>): RpcTarget => ({
    tab: id(p.tab_id),
    workspace: id(p.workspace_id),
  }),
  pane: (p: Record<string, unknown>): RpcTarget => ({
    pane: id(p.pane_id) ?? id(p.target_pane_id),
    tab: id(p.tab_id),
    workspace: id(p.workspace_id),
  }),
  terminal: (p: Record<string, unknown>): RpcTarget => ({
    terminal: id(p.terminal_id),
  }),
  /** Workspace files; `scope: "filesystem"` browses the whole host. */
  files: (p: Record<string, unknown>): RpcTarget =>
    p.scope === "filesystem"
      ? { host: true }
      : { workspace: id(p.workspace_id) },
  /** A workspace-scoped listing, or the host when no workspace is named. */
  workspaceOrHost: (p: Record<string, unknown>): RpcTarget =>
    id(p.workspace_id) ? { workspace: id(p.workspace_id) } : { host: true },
  /** Creation inside a workspace, optionally from a browser source pane. */
  creation: (p: Record<string, unknown>): RpcTarget => {
    const source =
      p.browser_source && typeof p.browser_source === "object"
        ? (p.browser_source as Record<string, unknown>)
        : {};
    return {
      workspace: id(p.workspace_id) ?? id(source.workspace_id),
      pane: id(source.pane_id),
      tab: id(source.tab_id),
    };
  },
};

const r = targetResolvers;

const session = (cls: "read" | "write" = "read"): RpcPolicyEntry => ({
  class: cls,
  scope: "session",
});
const guest = (entry: RpcPolicyEntry): RpcPolicyEntry => ({
  ...entry,
  guest: true,
});
const admin: RpcPolicyEntry = { class: "admin", scope: "host" };
const dangerous: RpcPolicyEntry = { class: "dangerous", scope: "host" };
const hostWrite: RpcPolicyEntry = { class: "write", scope: "host" };
const list: RpcPolicyEntry = { class: "read", scope: "list" };
const herdrList: RpcPolicyEntry = { ...list, herdr: true };
const read = (resolve: RpcPolicyEntry["resolve"]): RpcPolicyEntry => ({
  class: "read",
  scope: "workspace",
  resolve,
});
const write = (
  resolve: RpcPolicyEntry["resolve"],
  extra: Partial<RpcPolicyEntry> = {},
): RpcPolicyEntry => ({
  class: "write",
  scope: "workspace",
  resolve,
  ...extra,
});
const herdr = (entry: RpcPolicyEntry): RpcPolicyEntry => ({
  ...entry,
  herdr: true,
});

export const RPC_POLICY: Readonly<Record<string, RpcPolicyEntry>> = {
  // Bridge-global.
  "bridge.ping": guest(session()),
  // Filtered: counts, the caller's connections, no host details.
  "bridge.status": guest(session()),
  "bridge.identity": guest(session()),
  "bridge.identity_profile": session("write"),
  "bridge.pause_others": admin,
  // Filtered for members: their connections, without profile details.
  "connections.list": guest(session()),
  "connections.set_default": admin,
  "connections.connect": admin,
  "connections.disconnect": admin,
  // Profiles choose SSH destinations and socket paths.
  "connections.create": dangerous,
  "connections.update": dangerous,
  "connections.remove": dangerous,
  "connections.test": dangerous,

  // Agents.
  "agent.list": list,

  // Workspace files and Git.
  "file.list": read(r.files),
  "file.resolve": read(r.files),
  "file.read": read(r.files),
  "file.write": write(r.files),
  "file.mkdir": write(r.files),
  "git.diff_summary": read(r.workspace),
  "git.diff_file": read(r.workspace),
  "git.pull": write(r.workspace),
  "git.file_action": write(r.workspace),
  "git.repo_action": write(r.workspace),

  // Terminal streaming. Methods without terminal_id act on the socket's
  // current terminal, which the bridge fills in before authorizing.
  "terminal.attach": read(r.terminal),
  "terminal.detach": guest(session()),
  "terminal.frame_ack": guest(session()),
  // Thins only this browser's own frame stream.
  "terminal.stream": guest(session()),
  // A pane's last lines as text, read through Herdr's passive snapshot path.
  "terminal.preview_text": read(r.pane),
  // Herdr's popup belongs to the host TUI; members see none.
  "terminal.watch_popup": {
    class: "read",
    scope: "host",
    deniedResult: { popup: null },
  },
  // Herdr keeps one history position per pane, shared by everyone watching
  // it, so viewers never move it: they read history with terminal.history
  // and browse it locally. Editors that do not hold the pane scroll Herdr's
  // history only (never input to the app).
  "terminal.scroll": write(r.terminal),
  // A pane's scrollback as ANSI text, read through Herdr's passive snapshot.
  "terminal.history": read(r.pane),
  "terminal.link.resolve": read(r.terminal),
  // The terminal bridge also ignores focus, resize, and relay resize from
  // devices other than a pane's display owner (see terminal.display).
  "terminal.focus": write(r.terminal, { writer: "control" }),
  "terminal.input": write(r.terminal, { writer: "input" }),
  "terminal.key": write(r.terminal, { writer: "input" }),
  "terminal.resize": write(r.terminal, { writer: "control" }),
  "terminal.relay_resize": write(
    (p) => (id(p.pane_id) ? { pane: id(p.pane_id) } : { host: true }),
    { writer: "control" },
  ),
  // Pin a pane's size to this device, take it here, or release it.
  "terminal.display": write(r.pane, { writer: "control" }),
  // Recolors every terminal on the host; members' reports are ignored.
  "terminal.host_theme": {
    ...hostWrite,
    deniedResult: { ok: true, ignored: true },
  },

  // Presence and pane control. The bridge assigns participant ids.
  "collaboration.list": guest(session()),
  "collaboration.update": guest(session()),
  "collaboration.leave": guest(session()),
  "collaboration.claim": write(r.pane),
  "collaboration.release": session("write"),

  // Settings.
  "settings.get": admin,
  "settings.terminal_transport.get": admin,
  "settings.terminal_transport.update": admin,
  "settings.worktree_hooks.get": admin,
  // Repository settings hold executable worktree hooks.
  "settings.update_repo": dangerous,

  // The project launcher browses the filesystem and starts commands.
  "launcher.get": dangerous,
  "launcher.browse": dangerous,
  "launcher.commands.get": dangerous,
  "launcher.commands.set": dangerous,
  "launcher.pins.set": dangerous,
  "launcher.launch": dangerous,

  // Worktrees: creation runs repository hooks and makes new workspaces.
  "worktree.list": herdr(read(r.workspaceOrHost)),
  "worktree.create": hostWrite,
  "worktree.open": hostWrite,
  "worktree.remove": hostWrite,

  // Herdr navigation and layout, forwarded to Herdr.
  "session.appearance": herdr(guest(session())),
  "workspace.list": herdrList,
  // A new workspace has no grants; only instance admins create them.
  "workspace.create": herdr(hostWrite),
  "workspace.focus": herdr(write(r.tab)),
  "workspace.rename": herdr(write(r.workspace, { minimum: "owner" })),
  // Reorders every user's workspace list.
  "workspace.move": herdr(hostWrite),
  "workspace.close": herdr(write(r.workspace, { minimum: "owner" })),
  "tab.list": herdrList,
  "tab.create": herdr(write(r.creation)),
  "tab.focus": herdr(write(r.tab)),
  "tab.rename": herdr(write(r.tab)),
  "tab.close": herdr(write(r.tab)),
  "pane.list": herdrList,
  "pane.get": herdr(read(r.pane)),
  "pane.layout": herdr(read(r.pane)),
  "pane.split": herdr(write(r.pane)),
  "pane.close": herdr(write(r.pane)),
  "pane.resize": herdr(write(r.pane)),
  "pane.zoom": herdr(write(r.pane)),
  "pane.focus_direction": herdr(write(r.pane)),
  "pane.send_input": herdr(write(r.pane, { writer: "input" })),
  "shell.submit": write(r.pane, { writer: "input" }),
  "shell.history": write(r.pane, { writer: "input" }),
  "shell.complete": write(r.pane, { writer: "input" }),
  "shell.subscribe": write(r.pane, { writer: "input" }),
  "pane.send_text": herdr(write(r.pane, { writer: "input" })),
  "pane.send_key": herdr(write(r.pane, { writer: "input" })),
  "pane.send_keys": herdr(write(r.pane, { writer: "input" })),
  "pane.paste": herdr(write(r.pane, { writer: "input" })),
  "popup.close": herdr(hostWrite),
  "integration.list": herdr(admin),
  // Plugin actions run plugin-defined code on the host.
  "plugin.action.invoke": herdr(dangerous),
};

/**
 * Herdr methods that stay unavailable to browsers, with the reason shown to
 * the caller. Any other unlisted method is denied with a generic message.
 */
export const DENIED_RPC_METHODS: Readonly<Record<string, string>> = {
  "server.stop": "stopping Herdr is only available on the host",
  "server.live_handoff": "Herdr live handoff is only available on the host",
  "plugin.enable": "plugin management is only available on the host",
  "plugin.disable": "plugin management is only available on the host",
  "integration.install":
    "agent integrations install executable hooks; run `herdr integration install` on the host",
  "integration.uninstall":
    "agent integrations change executable hooks; run `herdr integration uninstall` on the host",
  "agent.prompt": "prompting agents through the bridge is not allowed",
};

export type RpcLookup =
  | { allowed: true; entry: RpcPolicyEntry }
  | { allowed: false; message: string };

/** The policy entry for a method, or why the method is never allowed. */
export function lookupRpc(method: string): RpcLookup {
  const denied = Object.hasOwn(DENIED_RPC_METHODS, method)
    ? DENIED_RPC_METHODS[method]
    : undefined;
  if (denied) {
    return { allowed: false, message: `${method} is not allowed: ${denied}` };
  }
  const entry = Object.hasOwn(RPC_POLICY, method)
    ? RPC_POLICY[method]
    : undefined;
  if (!entry) {
    return {
      allowed: false,
      message: `${method} is not allowed: the bridge does not expose this method`,
    };
  }
  return { allowed: true, entry };
}

/** Whether the entry needs an instance admin regardless of grants. */
export function requiresInstanceAdmin(entry: RpcPolicyEntry): boolean {
  return (
    entry.class === "admin" ||
    entry.class === "dangerous" ||
    entry.scope === "host"
  );
}

export function minimumRole(entry: RpcPolicyEntry): WorkspaceRole {
  return entry.minimum ?? (entry.class === "read" ? "viewer" : "editor");
}
