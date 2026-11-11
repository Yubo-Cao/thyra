/**
 * Agent sessions: the structured view of a coding agent that runs under
 * `thyra agent <kind>` in a Herdr pane. The host process in the pane owns the
 * agent (Claude Code over stream-json, Codex over its app-server), normalizes
 * its protocol into the items below, and the bridge relays them to pages.
 *
 * A session is addressed by its pane ID. Pages read with `agent_session.list`
 * and `agent_session.subscribe`, and act with `send`, `interrupt`, `approve`,
 * `set_mode`, `set_model`, `set_effort`, `unqueue`, `compact` and `resume`.
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

/** A model `agent_session.set_model` accepts. */
export type AgentSessionModel = {
  id: string;
  label: string;
  description?: string;
  /** Reasoning efforts it takes; absent when it takes no setting. */
  efforts?: string[];
};

/**
 * What to do with a prompt sent while a turn runs: `queue` holds it in the
 * host until the session is idle, `steer` gives it to the running turn at
 * once (the agent steers or queues it itself), and `interrupt` stops the
 * turn and sends it next. In an idle session all three send at once.
 */
export type AgentPromptDelivery = "queue" | "steer" | "interrupt";
export const AGENT_PROMPT_DELIVERIES: readonly AgentPromptDelivery[] = [
  "queue",
  "steer",
  "interrupt",
];

/** A prompt the host holds until the running turn ends. */
export type AgentQueuedPrompt = {
  /** Unique within the session; `agent_session.unqueue` takes it as `prompt_id`. */
  id: string;
  text: string;
  images?: AgentPromptImage[];
  /** Milliseconds since the epoch when it was queued. */
  at: number;
};

export type AgentSessionInfo = {
  pane_id: string;
  kind: AgentSessionKind;
  status: AgentSessionStatus;
  cwd: string;
  /** Milliseconds since the epoch. */
  started_at: number;
  /** The agent's own session or thread ID, once known. */
  agent_session_id?: string;
  /** The model's ID; one of `models` when the agent listed it there. */
  model?: string;
  /** Models `agent_session.set_model` accepts; absent until the agent lists them. */
  models?: AgentSessionModel[];
  /** The reasoning effort the next turn runs with. */
  effort?: string;
  /** Efforts `agent_session.set_effort` accepts: the current model's. */
  efforts?: string[];
  mode?: string;
  /** Modes `agent_session.set_mode` accepts; empty when it cannot change. */
  modes: AgentSessionMode[];
  /** Prompts waiting for the running turn to end, in the order they go. */
  queued?: AgentQueuedPrompt[];
  usage?: AgentSessionUsage;
  /** Why the session is `exited`, when it did not end normally. */
  error?: string;
  /**
   * The host serves `agent_session.history` and `agent_session.resume`.
   * Absent on a host started by a build from before they existed.
   */
  can_resume?: boolean;
  /**
   * The host passes a prompt's `images` on to the agent. Absent on a host
   * started by a build from before prompts took images.
   */
  can_attach_images?: boolean;
  /**
   * The host serves `agent_session.set_model` and `agent_session.set_effort`.
   * Absent on a host started by a build from before they existed.
   */
  can_set_model?: boolean;
  /**
   * The host takes a prompt's `delivery` and serves `agent_session.unqueue`.
   * Absent on a host started by a build from before; such a host gives every
   * prompt to the running turn, as `steer` does.
   */
  can_queue?: boolean;
  /** The host serves `agent_session.compact`. */
  can_compact?: boolean;
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

/**
 * An image attached to a prompt: a file on the agent's host, at the path the
 * connection's `/upload-image` endpoint returned for it.
 */
export type AgentPromptImage = { path: string };

type ItemBase = {
  /** Stable within the session; later `item` events with it replace the item. */
  id: string;
  /** Milliseconds since the epoch when the item first appeared. */
  at: number;
};

export type AgentItem =
  | (ItemBase & {
      type: "user";
      text: string;
      /** Attached images; `[Image #N]` in `text` names the Nth, from 1. */
      images?: AgentPromptImage[];
    })
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

/** A conversation the agent has stored, which a session can resume. */
export type AgentStoredSession = {
  /** The agent's own session or thread ID. */
  id: string;
  /** Its title when the agent gave it one, else its first prompt; one line. */
  title: string;
  /** Milliseconds since the epoch of its last activity. */
  updated_at: number;
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
  /**
   * The session now continues a stored conversation: these items replace the
   * whole transcript, and no approval is open.
   */
  | { type: "reset"; items: AgentItem[] }
);

export const AGENT_SESSION_ITEM_LIMIT = 2000;
export const AGENT_TOOL_OUTPUT_LIMIT = 32 * 1024;
export const AGENT_PROMPT_LIMIT = 256 * 1024;
/** The most images one prompt can attach. */
export const AGENT_PROMPT_IMAGE_LIMIT = 10;
/**
 * The largest image file a prompt can attach. Pages shrink a larger image
 * before uploading it; PNG, JPEG, GIF and WebP are the accepted formats.
 */
export const AGENT_PROMPT_IMAGE_MAX_BYTES = 3.5 * 1024 * 1024;
/** The most stored conversations `agent_session.history` returns. */
export const AGENT_SESSION_HISTORY_LIMIT = 30;

/**
 * Bridge RPC, per connection.
 *
 * `agent_session.list` -> `{ sessions: AgentSessionInfo[] }` (readable panes).
 * `agent_session.subscribe { pane_id }` -> `AgentSessionSnapshot`; the page
 *   then receives `agent_session.event` (`AgentSessionEvent`) until
 *   `agent_session.unsubscribe { pane_id }`, the session ends, or it disconnects.
 * `agent_session.send { pane_id, text, images?, delivery? }` starts a turn,
 *   or does what `delivery` (`AgentPromptDelivery`, default `steer`) says
 *   when one is running. `images` (`AgentPromptImage[]`) go to the agent as
 *   image input, not as paths in the text; with images the text may be
 *   empty. A queued prompt shows in `info.queued` until it is sent, then as
 *   a `user` item like any other; one that fails to go adds an error notice.
 * `agent_session.unqueue { pane_id, prompt_id }` takes a queued prompt back before
 *   it is sent; refused once it has gone.
 * `agent_session.interrupt { pane_id }` stops the running turn.
 * `agent_session.approve { pane_id, approval_id, option_id }`.
 * `agent_session.set_mode { pane_id, mode }`.
 * `agent_session.set_model { pane_id, model }` and
 *   `agent_session.set_effort { pane_id, effort }` choose from
 *   `info.models` and `info.efforts` for the next turn; usable before the
 *   first prompt. A new model may bring other efforts and its own effort.
 * `agent_session.compact { pane_id }` compacts the conversation, as the
 *   agent's `/compact` does (which a prompt may also say); a `notice` item
 *   shows when it has. Refused while a turn is running.
 * `agent_session.history { pane_id }` -> `{ sessions: AgentStoredSession[] }`:
 *   the conversations the agent has stored for the session's working
 *   directory, newest first, without the one the session is in. They include
 *   conversations held in the agent's terminal UI.
 * `agent_session.resume { pane_id, session_id }` continues a stored
 *   conversation in this session: a `reset` event replaces the transcript
 *   with that conversation's, and `info.agent_session_id` follows. Refused
 *   while a turn is running.
 *
 * A session started with the agent's own resume arguments
 * (`thyra agent claude --resume <id>` or `--continue`,
 * `thyra agent codex resume <id>` or `resume --last`) restores the transcript
 * the same way before it takes its first prompt.
 *
 * `agent_session.changed` (`{ sessions: AgentSessionInfo[] }`) is sent to every
 * page when a session appears, ends, or changes status, filtered like `list`.
 */
export const AGENT_SESSION_EVENT = "agent_session.event";
export const AGENT_SESSIONS_CHANGED = "agent_session.changed";
