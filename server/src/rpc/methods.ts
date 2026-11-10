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
