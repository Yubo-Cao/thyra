import type {
  AgentItem,
  AgentSessionEvent,
} from "../../../shared/agentSession";

const MEMORY_LIMIT = 8192;
/** Everything below space except tab and newline, and DEL. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g;

/**
 * The pane's own view of a session: a running plain-text log of prompts,
 * answers, tool calls and approvals, written as the session's events arrive.
 * No cursor control, so it reads the same in scrollback and in a pipe.
 */
export function createTerminalLog(write: (text: string) => void) {
  /** Tool calls already printed, with the status shown for them. */
  const tools = new Map<string, string>();
  const seen = new Set<string>();
  /** The assistant item whose streamed text is on the current line. */
  let streaming: string | null = null;
  let atLineStart = true;
  let exited = false;
  /** Items of a resumed conversation, until the session's new ID is known. */
  let resumed: number | null = null;

  /** Remember an ID; the oldest go so a long session stays bounded. */
  const remember = (ids: Set<string> | Map<string, string>) => {
    if (ids.size > MEMORY_LIMIT) ids.delete(ids.keys().next().value as string);
  };
  const out = (text: string) => {
    // Prompts, answers and tool titles are data: they never drive the
    // terminal (escape sequences, carriage returns, bells).
    const value = text.replace(CONTROL_CHARACTERS, "");
    if (!value) return;
    write(value);
    atLineStart = value.endsWith("\n");
  };
  const line = (value: string) => {
    if (!atLineStart) out("\n");
    streaming = null;
    out(`${value}\n`);
  };
  const indent = (value: string, prefix: string) =>
    value
      .split("\n")
      .map((part, index) => (index === 0 ? prefix : "  ") + part)
      .join("\n");

  function item(value: AgentItem) {
    const first = !seen.has(value.id);
    seen.add(value.id);
    remember(seen);
    switch (value.type) {
      case "user": {
        if (!first) return;
        // Attached images are named by their number, never drawn.
        const count = value.images?.length ?? 0;
        const attached =
          count > 0 ? `[${count} ${count === 1 ? "image" : "images"}]` : "";
        line(
          `\n${indent([value.text, attached].filter(Boolean).join(" "), "> ")}`,
        );
        return;
      }
      case "assistant":
        if (first && value.streaming) {
          if (!atLineStart) out("\n");
          out(`\n${value.text}`);
          streaming = value.id;
        } else if (first) {
          line(`\n${value.text}`);
        } else if (!value.streaming && streaming === value.id) {
          if (!atLineStart) out("\n");
          streaming = null;
        }
        return;
      case "tool": {
        if (value.status === "pending") return;
        const shown = tools.get(value.id);
        if (shown === undefined) {
          const outcome =
            value.status === "failed" || value.status === "denied"
              ? ` (${value.status})`
              : "";
          line(
            `* ${value.name === value.title ? value.name : `${value.name}: ${value.title}`}${outcome}`,
          );
        } else if (
          shown !== value.status &&
          (value.status === "failed" || value.status === "denied")
        ) {
          line(`  ${value.status}: ${value.title}`);
        }
        tools.set(value.id, value.status);
        remember(tools);
        return;
      }
      case "plan": {
        const done = value.entries.filter(
          (entry) => entry.status === "done",
        ).length;
        const current = value.entries.find(
          (entry) => entry.status === "in_progress",
        );
        line(
          `* plan ${done}/${value.entries.length}${current ? `: ${current.text}` : ""}`,
        );
        return;
      }
      case "notice":
        line(`${value.level === "error" ? "! " : "- "}${value.text}`);
        return;
      case "thinking":
        return;
    }
  }

  /** One line for a resumed conversation; its transcript is not printed. */
  const announceResume = (id?: string) => {
    if (resumed === null) return;
    const count = resumed;
    resumed = null;
    line(
      `- resumed ${id ? `${id} ` : ""}(${count} ${count === 1 ? "item" : "items"})`,
    );
  };

  return {
    line,
    event(event: AgentSessionEvent) {
      // The `info` after a `reset` names the conversation that was resumed.
      announceResume(
        event.type === "info" ? event.info.agent_session_id : undefined,
      );
      switch (event.type) {
        case "reset":
          tools.clear();
          seen.clear();
          streaming = null;
          resumed = event.items.length;
          return;
        case "item":
          return item(event.item);
        case "delta":
          if (streaming === event.id) out(event.text);
          return;
        case "approval":
          return line(
            `? approval needed: ${event.approval.title} (answer in Thyra)`,
          );
        case "info":
          if (event.info.status !== "exited" || exited) return;
          exited = true;
          return line(
            event.info.error
              ? `! agent exited: ${event.info.error}`
              : "- agent exited",
          );
      }
    },
  };
}
