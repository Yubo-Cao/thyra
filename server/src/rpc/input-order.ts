import {
  AGENT_SESSION_ACTION_METHODS,
  PANE_INPUT_METHODS,
  TERMINAL_INPUT_METHODS,
} from "./methods";

/**
 * The serial queue an input request belongs to, or null for requests that
 * need no ordering. Keyed when the message arrives, before anything is
 * awaited, so requests sharing a key run in arrival order.
 *
 * - Pane-addressed input (`pane.send_*`, `pane.paste`) shares one queue per
 *   pane across every page: Herdr serves each call on its own connection, so
 *   two in flight could land in either order.
 * - Terminal-addressed input (`terminal.input`, `terminal.key`) has one queue
 *   per page and terminal: a page pipelines its keystrokes, and their
 *   authorization and pane-control checks may settle out of order.
 * - Agent session actions share one queue per pane across every page, so two
 *   prompts, or a prompt and an interrupt, reach the host as they were sent.
 */
export function inputOrderKey(
  client: string,
  connection: string | null,
  method: string | null,
  message: unknown,
): string | null {
  if (!method) return null;
  const params = (message as { params?: Record<string, unknown> } | null)
    ?.params;
  if (PANE_INPUT_METHODS.has(method)) {
    const pane = params?.pane_id;
    return typeof pane === "string" && pane
      ? `pane\0${connection ?? ""}\0${pane}`
      : null;
  }
  if (AGENT_SESSION_ACTION_METHODS.has(method)) {
    const pane = params?.pane_id;
    return typeof pane === "string" && pane
      ? `agent-session\0${connection ?? ""}\0${pane}`
      : null;
  }
  if (TERMINAL_INPUT_METHODS.has(method)) {
    // Without a terminal id the input goes to the page's current terminal.
    const terminal = params?.terminal_id;
    return `terminal\0${client}\0${connection ?? ""}\0${
      typeof terminal === "string" ? terminal : ""
    }`;
  }
  return null;
}
