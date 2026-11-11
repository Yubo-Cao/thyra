/** Methods whose completion is always logged, however fast. */
export const IMPORTANT_RPC_METHODS = new Set([
  "bridge.pause_others",
  "file.read",
  "file.write",
  "git.diff_file",
  "git.pull",
  "launcher.launch",
  "worktree.create",
  "worktree.open",
  "worktree.remove",
]);
// Pane-addressed input also makes this browser the OSC 52 clipboard owner.
export const PANE_INPUT_METHODS = new Set([
  "pane.send_input",
  "pane.send_text",
  "pane.send_key",
  "pane.send_keys",
  "pane.paste",
]);
/** Terminal-addressed input, written in the order one page sent it. */
export const TERMINAL_INPUT_METHODS = new Set([
  "terminal.input",
  "terminal.key",
]);
/** Actions on a pane's agent session, applied in the order they arrive. */
export const AGENT_SESSION_ACTION_METHODS = new Set([
  "agent_session.send",
  "agent_session.interrupt",
  "agent_session.approve",
  "agent_session.set_mode",
]);
/**
 * Methods a page may send without an `id`: handled like the request, but
 * nothing is sent back, neither a result nor an error.
 */
export const ONE_WAY_RPC_METHODS = new Set(["terminal.frame_ack"]);
/**
 * Terminal protocol features announced in the hello's `capabilities`; a page
 * uses each only when the bridge names it.
 */
export const TERMINAL_RPC_CAPABILITIES = {
  /** Input may be sent before the previous input's reply; order is kept. */
  terminal_input_pipeline: true,
  /** `terminal.frame_ack` is accepted without an `id` and gets no reply. */
  terminal_frame_ack_notify: true,
} as const;
/** Bridge features announced in the hello's `capabilities`. */
export const BRIDGE_RPC_CAPABILITIES = {
  /** `agent_session.*` is served (see `shared/agentSession.ts`). */
  agent_sessions: true,
} as const;
