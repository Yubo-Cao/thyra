/**
 * Agent sessions: the structured view of a coding agent that runs under
 * `thyra agent <kind>` in a Herdr pane. The host process in the pane owns the
 * agent (Claude Code over stream-json, Codex over its app-server), normalizes
 * its protocol into the items below, and the bridge relays them to pages.
 *
 * A session is addressed by its pane ID. Pages read with `agent_session.list`
 * and `agent_session.subscribe`, and act with `send`, `interrupt`, `approve`
 * and `set_mode`.
 */

export const AGENT_SESSION_KINDS = ["claude", "codex"] as const;
export type AgentSessionKind = (typeof AGENT_SESSION_KINDS)[number];

export type AgentSessionStatus =
  /** The agent process is starting and cannot take a prompt yet. */
  | "starting"
  /** Waiting for a prompt. */
  | "idle"
  /** A turn is in progress. */
  | "running"
  /** A turn is blocked on at least one open approval. */
  | "awaiting_approval"
  /** The agent process ended; the transcript stays readable. */
  | "exited";

export type AgentSessionUsage = {
  /** Tokens in the model's context after the last response. */
  context_tokens?: number;
  context_window?: number;
  output_tokens?: number;
};

/** One selectable way of running, such as a permission or approval mode. */
export type AgentSessionMode = { id: string; label: string };

export type AgentSessionInfo = {
  pane_id: string;
  kind: AgentSessionKind;
  status: AgentSessionStatus;
  cwd: string;
  /** Milliseconds since the epoch. */
  started_at: number;
  /** The agent's own session or thread ID, once known. */
  agent_session_id?: string;
  model?: string;
  mode?: string;
  /** Modes `agent_session.set_mode` accepts; empty when it cannot change. */
  modes: AgentSessionMode[];
  usage?: AgentSessionUsage;
  /** Why the session is `exited`, when it did not end normally. */
  error?: string;
};

export type AgentToolKind =
  | "command"
  | "edit"
  | "read"
  | "search"
  | "fetch"
  | "task"
  | "other";

export type AgentToolStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "denied";

export type AgentFileDiff = {
  path: string;
  /** Unified diff body (hunks), without the `diff --git` header. */
  patch: string;
};

export type AgentPlanEntry = {
  text: string;
  status: "pending" | "in_progress" | "done";
};

type ItemBase = {
  /** Stable within the session; later `item` events with it replace the item. */
  id: string;
  /** Milliseconds since the epoch when the item first appeared. */
  at: number;
};

export type AgentItem =
  | (ItemBase & { type: "user"; text: string })
  | (ItemBase & { type: "assistant"; text: string; streaming: boolean })
  | (ItemBase & { type: "thinking"; text: string; streaming: boolean })
  | (ItemBase & {
      type: "tool";
      kind: AgentToolKind;
      /** The agent's tool name, such as `Bash` or `apply_patch`. */
      name: string;
      /** One line saying what the call does: a command, a path, a query. */
      title: string;
      status: AgentToolStatus;
      /** Shell command text, for `command` tools. */
      command?: string;
      /** File changes, for `edit` tools. */
      diffs?: AgentFileDiff[];
      /** Remaining input as pretty-printed JSON, when it adds to the title. */
      input?: string;
      /** Result text, truncated to `AGENT_TOOL_OUTPUT_LIMIT`. */
      output?: string;
      output_truncated?: boolean;
    })
  | (ItemBase & { type: "plan"; entries: AgentPlanEntry[] })
  | (ItemBase & { type: "notice"; level: "info" | "error"; text: string });

export type AgentApprovalOption = {
  id: string;
  label: string;
  kind: "allow" | "allow_always" | "deny";
};

/** A question the agent is blocked on until `agent_session.approve`. */
export type AgentApproval = {
  id: string;
  /** The tool item this approval is about, when there is one. */
  item_id?: string;
  title: string;
  /** Extra explanation, such as the reason the agent gave. */
  detail?: string;
  options: AgentApprovalOption[];
};

/** Everything a page needs to draw a session from nothing. */
export type AgentSessionSnapshot = {
  info: AgentSessionInfo;
  /** Oldest first; at most `AGENT_SESSION_ITEM_LIMIT`, older items dropped. */
  items: AgentItem[];
  approvals: AgentApproval[];
  /** Sequence number of the last event already reflected here. */
  seq: number;
};

/**
 * Changes after a snapshot. `seq` rises by one per event within a session; a
 * page that sees a gap subscribes again for a fresh snapshot.
 */
export type AgentSessionEvent = { pane_id: string; seq: number } & (
  | { type: "info"; info: AgentSessionInfo }
  /** Insert the item, or replace the one with the same ID. */
  | { type: "item"; item: AgentItem }
  /** Append text to a streaming `assistant` or `thinking` item. */
  | { type: "delta"; id: string; text: string }
  | { type: "approval"; approval: AgentApproval }
  | { type: "approval_resolved"; id: string }
);

export const AGENT_SESSION_ITEM_LIMIT = 2000;
export const AGENT_TOOL_OUTPUT_LIMIT = 32 * 1024;
export const AGENT_PROMPT_LIMIT = 256 * 1024;

/**
 * Bridge RPC, per connection.
 *
 * `agent_session.list` -> `{ sessions: AgentSessionInfo[] }` (readable panes).
 * `agent_session.subscribe { pane_id }` -> `AgentSessionSnapshot`; the page
 *   then receives `agent_session.event` (`AgentSessionEvent`) until
 *   `agent_session.unsubscribe { pane_id }`, the session ends, or it disconnects.
 * `agent_session.send { pane_id, text }` starts a turn, or steers/queues the
 *   prompt when one is running.
 * `agent_session.interrupt { pane_id }` stops the running turn.
 * `agent_session.approve { pane_id, approval_id, option_id }`.
 * `agent_session.set_mode { pane_id, mode }`.
 *
 * `agent_session.changed` (`{ sessions: AgentSessionInfo[] }`) is sent to every
 * page when a session appears, ends, or changes status, filtered like `list`.
 */
export const AGENT_SESSION_EVENT = "agent_session.event";
export const AGENT_SESSIONS_CHANGED = "agent_session.changed";
