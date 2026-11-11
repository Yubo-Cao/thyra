import { StringDecoder } from "node:string_decoder";
import {
  AGENT_PROMPT_DELIVERIES,
  type AgentPromptDelivery,
  type AgentPromptImage,
  type AgentSessionEvent,
  type AgentSessionSnapshot,
} from "../../../shared/agentSession";

/**
 * The link between an agent host (`thyra agent`, in a pane) and the bridge:
 * newline-delimited JSON over the host's Unix socket. The host greets every
 * connection with a snapshot, then sends each later event; the bridge sends
 * actions, each answered by one result.
 */

/**
 * Stays 1 while old and new builds can talk: hosts keep running their binary
 * across deploys, and the bridge drops a host that reports another number.
 * A host from before an action existed never answers it, and one from
 * before prompts took images would drop them, so the bridge only sends
 * `history` and `resume` to hosts whose info says `can_resume`, images
 * to hosts whose info says `can_attach_images`, `set_model` and
 * `set_effort` to `can_set_model`, `unqueue` and a `delivery` other than
 * `steer` to `can_queue`, and `compact` to `can_compact`.
 */
export const AGENT_LINK_PROTOCOL = 1;
/** A snapshot stays far below this; a longer line is not from a host. */
export const AGENT_LINK_MAX_LINE_BYTES = 16 * 1024 * 1024;

export type AgentAction =
  /** `images` are paths on the host; the host reads the files itself. */
  | {
      action: "send";
      text: string;
      images?: AgentPromptImage[];
      /** Absent: `steer`, what hosts from before deliveries do. */
      delivery?: AgentPromptDelivery;
    }
  | { action: "unqueue"; prompt_id: string }
  | { action: "interrupt" }
  | { action: "approve"; approval_id: string; option_id: string }
  | { action: "set_mode"; mode: string }
  | { action: "set_model"; model: string }
  | { action: "set_effort"; effort: string }
  | { action: "compact" }
  /** The stored conversations of the session's directory; answers a `value`. */
  | { action: "history" }
  | { action: "resume"; session_id: string };

/**
 * An agent's session or thread ID as this code accepts one from outside. It
 * ends up in a command line and a file name, so it is a plain token: no path
 * separator, no leading dash, bounded.
 */
export function isAgentSessionId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  );
}

export type HostMessage =
  | {
      type: "hello";
      protocol: number;
      pane_id: string;
      /** The Herdr control socket of the pane's server. */
      herdr_socket: string;
      pid: number;
      snapshot: AgentSessionSnapshot;
    }
  | { type: "event"; event: AgentSessionEvent }
  /**
   * The outcome of the action with this `id`: `error` when it failed, `value`
   * when the action answers with data.
   */
  | { type: "result"; id: number; error?: string; value?: unknown };

export type BridgeMessage = { type: "action"; id: number } & AgentAction;

export function encodeLine(message: HostMessage | BridgeMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Split a byte stream into lines, keeping a character that arrives across
 * two chunks whole. `onOverflow` fires once for a line past the limit; the
 * stream is unusable after it.
 */
export function createLineReader(
  onLine: (line: string) => void,
  onOverflow: () => void,
  maxLineBytes = AGENT_LINK_MAX_LINE_BYTES,
) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let pendingBytes = 0;
  let overflowed = false;
  return (chunk: Uint8Array) => {
    if (overflowed) return;
    const text = decoder.write(chunk as Buffer);
    let start = 0;
    for (;;) {
      const end = text.indexOf("\n", start);
      if (end === -1) break;
      const line = pending + text.slice(start, end);
      pending = "";
      pendingBytes = 0;
      start = end + 1;
      if (line.trim()) onLine(line);
    }
    if (start < text.length) {
      pending += text.slice(start);
      // Bytes are an upper bound of what is pending; exact enough for a cap.
      pendingBytes += chunk.byteLength;
      if (pendingBytes > maxLineBytes) {
        overflowed = true;
        pending = "";
        onOverflow();
      }
    }
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A line from the bridge as an action, or null when it is not one. */
export function parseBridgeMessage(line: string): BridgeMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const message = record(value);
  if (
    !message ||
    message.type !== "action" ||
    typeof message.id !== "number" ||
    !Number.isSafeInteger(message.id)
  )
    return null;
  const { id } = message;
  switch (message.action) {
    case "send": {
      const { images, delivery } = message;
      if (
        typeof message.text !== "string" ||
        (images !== undefined && !Array.isArray(images)) ||
        (delivery !== undefined &&
          !AGENT_PROMPT_DELIVERIES.includes(delivery as AgentPromptDelivery))
      )
        return null;
      return {
        type: "action",
        id,
        action: "send",
        text: message.text,
        // An entry that names no path fails the host's check of its file,
        // so the bridge gets a refusal rather than no answer.
        ...(images && images.length > 0
          ? {
              images: images.map((image) => {
                const path = record(image)?.path;
                return { path: typeof path === "string" ? path : "" };
              }),
            }
          : {}),
        ...(delivery ? { delivery: delivery as AgentPromptDelivery } : {}),
      };
    }
    case "unqueue":
      return typeof message.prompt_id === "string"
        ? {
            type: "action",
            id,
            action: "unqueue",
            prompt_id: message.prompt_id,
          }
        : null;
    case "interrupt":
      return { type: "action", id, action: "interrupt" };
    case "approve":
      return typeof message.approval_id === "string" &&
        typeof message.option_id === "string"
        ? {
            type: "action",
            id,
            action: "approve",
            approval_id: message.approval_id,
            option_id: message.option_id,
          }
        : null;
    case "set_mode":
      return typeof message.mode === "string"
        ? { type: "action", id, action: "set_mode", mode: message.mode }
        : null;
    case "set_model":
      return typeof message.model === "string"
        ? { type: "action", id, action: "set_model", model: message.model }
        : null;
    case "set_effort":
      return typeof message.effort === "string"
        ? { type: "action", id, action: "set_effort", effort: message.effort }
        : null;
    case "compact":
      return { type: "action", id, action: "compact" };
    case "history":
      return { type: "action", id, action: "history" };
    case "resume":
      return typeof message.session_id === "string"
        ? {
            type: "action",
            id,
            action: "resume",
            session_id: message.session_id,
          }
        : null;
    default:
      return null;
  }
}

/** A line from a host, checked only as far as the bridge relies on it. */
export function parseHostMessage(line: string): HostMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const message = record(value);
  if (!message) return null;
  if (message.type === "hello") {
    const snapshot = record(message.snapshot);
    const info = record(snapshot?.info);
    if (
      typeof message.protocol !== "number" ||
      typeof message.pane_id !== "string" ||
      typeof message.herdr_socket !== "string" ||
      !snapshot ||
      !info ||
      info.pane_id !== message.pane_id ||
      !Array.isArray(snapshot.items) ||
      !Array.isArray(snapshot.approvals) ||
      typeof snapshot.seq !== "number"
    )
      return null;
    return message as unknown as HostMessage;
  }
  if (message.type === "event") {
    const event = record(message.event);
    if (
      !event ||
      typeof event.pane_id !== "string" ||
      typeof event.seq !== "number" ||
      typeof event.type !== "string"
    )
      return null;
    return message as unknown as HostMessage;
  }
  if (message.type === "result") {
    if (typeof message.id !== "number") return null;
    return {
      type: "result",
      id: message.id,
      ...(typeof message.error === "string" ? { error: message.error } : {}),
      ...(message.value !== undefined ? { value: message.value } : {}),
    };
  }
  return null;
}
