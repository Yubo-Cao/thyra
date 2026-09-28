/** Connection-scoped shell input protocol. Offsets are UTF-16 string indices. */
export type ShellName = "bash" | "zsh" | "fish";
export type ShellInputReason =
  | "no_integration"
  | "busy"
  | "dirty"
  | "submitted"
  | "alternate_screen"
  | "stale_seq"
  | "multiline"
  | "invalid_text"
  | "connection_changed";
export interface ShellInputState {
  pane_id: string;
  available: boolean;
  reason?: ShellInputReason;
  seq: number;
  shell?: ShellName;
  cwd?: string;
  exit?: number;
  bracketed_paste: boolean;
}
export interface ShellSubmitParams {
  pane_id: string;
  seq: number;
  text: string;
  execute: boolean;
}
export type ShellSubmitResult =
  | { ok: true }
  | { ok: false; reason: ShellInputReason };
export interface ShellHistoryParams {
  pane_id: string;
  prefix?: string;
  query?: string;
  cwd?: string;
  limit?: number;
  /** Chronological recent entries for the browser's local history cache. */
  latest?: boolean;
}
export interface ShellHistoryEntry {
  command: string;
  cwd: string;
  exit: number | null;
  start_ts: number;
  end_ts: number | null;
  pane: string;
  shell: string;
  host: string;
}
export interface ShellHistoryResult {
  entries: ShellHistoryEntry[];
}
export interface ShellSubscribeParams {
  pane_id: string;
  enabled?: boolean;
}
export interface ShellCompleteParams {
  pane_id: string;
  line: string;
  cursor: number;
}
export interface ShellCompletion {
  replace_start: number;
  replace_end: number;
  items: {
    text: string;
    kind: "command" | "file" | "dir" | "branch" | "history";
    detail?: string;
  }[];
}
/** shell.subscribe returns a snapshot; subsequent updates use this envelope. */
export interface ShellStateEvent {
  event: "shell.state";
  data: ShellInputState;
}
export interface ShellRpcMethods {
  "shell.submit": { params: ShellSubmitParams; result: ShellSubmitResult };
  "shell.history": { params: ShellHistoryParams; result: ShellHistoryResult };
  "shell.complete": { params: ShellCompleteParams; result: ShellCompletion };
  "shell.subscribe": { params: ShellSubscribeParams; result: ShellInputState };
}
