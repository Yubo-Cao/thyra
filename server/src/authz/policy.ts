/**
 * Deny-by-default authorization for WebSocket RPC methods.
 *
 * Every method a browser may call must be listed in `RPC_POLICY`, whether the
 * bridge implements it or forwards it to Herdr. Anything else, including
 * Herdr methods the web client never uses, is rejected before dispatch.
 * Classes describe the authority a method exercises; roles map to the
 * classes they may use. Today the only role is the authenticated owner.
 */

export type RpcClass = "read" | "write" | "admin" | "dangerous";

export type RpcPolicyEntry = {
  class: RpcClass;
  /** The bridge forwards the call to Herdr unchanged (after enrichment). */
  herdr?: true;
};

const read = { class: "read" } as const;
const write = { class: "write" } as const;
const admin = { class: "admin" } as const;
const dangerous = { class: "dangerous" } as const;
const herdrRead = { class: "read", herdr: true } as const;
const herdrWrite = { class: "write", herdr: true } as const;

export const RPC_POLICY: Readonly<Record<string, RpcPolicyEntry>> = {
  // Bridge-global.
  "bridge.ping": read,
  "bridge.status": read,
  "bridge.identity": read,
  "bridge.identity_profile": write,
  "bridge.pause_others": admin,
  "connections.list": admin,
  "connections.set_default": admin,
  "connections.connect": admin,
  "connections.disconnect": admin,
  // Profiles choose SSH destinations and socket paths.
  "connections.create": dangerous,
  "connections.update": dangerous,
  "connections.remove": dangerous,
  "connections.test": dangerous,

  // Agent sessions and history.
  "agent.list": read,
  "agent_history.get": read,
  "agent_history.entry": read,
  "agent_session.get": read,

  // Workspace files and Git.
  "file.list": read,
  "file.resolve": read,
  "file.read": read,
  "file.write": write,
  "file.mkdir": write,
  "git.diff_summary": read,
  "git.diff_file": read,
  "git.pull": write,
  "git.file_action": write,
  "git.repo_action": write,

  // Terminal streaming.
  "terminal.attach": read,
  "terminal.detach": read,
  "terminal.watch_popup": read,
  "terminal.frame_ack": read,
  "terminal.scroll": read,
  "terminal.link.resolve": read,
  "terminal.focus": write,
  "terminal.input": write,
  "terminal.resize": write,
  "terminal.relay_resize": write,
  "terminal.host_theme": write,

  // Presence and pane control. The bridge assigns participant ids.
  "collaboration.list": read,
  "collaboration.update": read,
  "collaboration.leave": read,
  "collaboration.claim": write,
  "collaboration.release": write,

  // Settings.
  "settings.get": admin,
  "settings.terminal_transport.get": admin,
  "settings.terminal_transport.update": admin,
  "settings.worktree_hooks.get": admin,
  "settings.workspace_auto_sync.get": admin,
  "settings.workspace_auto_sync.list": admin,
  "settings.workspace_auto_sync.update": admin,
  "settings.workspace_auto_sync.update_key": admin,
  // Repository settings hold executable worktree hooks.
  "settings.update_repo": dangerous,

  // The project launcher browses the filesystem and starts commands.
  "launcher.get": dangerous,
  "launcher.browse": dangerous,
  "launcher.commands.get": dangerous,
  "launcher.commands.set": dangerous,
  "launcher.pins.set": dangerous,
  "launcher.launch": dangerous,

  // Worktrees (the bridge runs the configured repository hooks).
  "worktree.list": herdrRead,
  "worktree.create": write,
  "worktree.open": write,
  "worktree.remove": write,

  // Herdr navigation and layout, forwarded to Herdr.
  "session.appearance": herdrRead,
  "workspace.list": herdrRead,
  "workspace.create": herdrWrite,
  "workspace.focus": herdrWrite,
  "workspace.rename": herdrWrite,
  "workspace.move": herdrWrite,
  "workspace.close": herdrWrite,
  "tab.list": herdrRead,
  "tab.create": herdrWrite,
  "tab.focus": herdrWrite,
  "tab.rename": herdrWrite,
  "tab.close": herdrWrite,
  "pane.list": herdrRead,
  "pane.get": herdrRead,
  "pane.layout": herdrRead,
  "pane.split": herdrWrite,
  "pane.close": herdrWrite,
  "pane.resize": herdrWrite,
  "pane.zoom": herdrWrite,
  "pane.focus_direction": herdrWrite,
  "pane.send_input": herdrWrite,
  "pane.send_text": herdrWrite,
  "pane.send_key": herdrWrite,
  "pane.send_keys": herdrWrite,
  "pane.paste": herdrWrite,
  "popup.close": herdrWrite,
  "integration.list": { class: "admin", herdr: true },
  // Plugin actions run plugin-defined code on the host.
  "plugin.action.invoke": { class: "dangerous", herdr: true },
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

export type RpcRole = "owner";

const ROLE_CLASSES: Readonly<Record<RpcRole, ReadonlySet<RpcClass>>> = {
  owner: new Set<RpcClass>(["read", "write", "admin", "dangerous"]),
};

export type RpcDecision =
  | { allowed: true; entry: RpcPolicyEntry }
  | { allowed: false; message: string };

export function authorizeRpc(
  method: string,
  role: RpcRole = "owner",
): RpcDecision {
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
  if (!ROLE_CLASSES[role].has(entry.class)) {
    return {
      allowed: false,
      message: `${method} is not allowed for this session`,
    };
  }
  return { allowed: true, entry };
}
