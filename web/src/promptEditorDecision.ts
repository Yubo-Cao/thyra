import type { PromptBoxScan, PromptEditorPlacement } from "./promptBoxDetect";

/** What the prompt editor knows about its pane at one scan. */
export type PromptEditorSituation = {
  /** The agent's prompt box on the visible screen. */
  scan: PromptBoxScan;
  /** The box has been found since the editor opened. */
  boxSeen: boolean;
  /** The agent's own box holds text (recalled history, a slash command). */
  agentHasText: boolean;
  /** Herdr's agent status for the pane (`blocked` for approvals and questions). */
  status: string | undefined;
  /** The screen draws a menu, form or numbered choice (screenShowsSelection). */
  menu: boolean;
};

export type PromptEditorDecision = {
  placement: PromptEditorPlacement;
  /**
   * The pane is asking for a choice: an empty editor passes digits, y/n,
   * arrows, Enter, Esc and Tab to it instead of typing them.
   */
  selection: boolean;
};

/**
 * Where the editor goes, and whether it yields choice keys, for one scan.
 * The editor stands in for the agent's own input box only while that box is
 * on screen and empty. Anything else the agent draws there (a permission
 * prompt, a question form, a picker, recalled text, a slash command) gets
 * the keyboard: the editor hides and focus returns to the terminal. A
 * supported agent whose box has not been seen yet (a startup screen, a
 * layout the detector does not know) docks at the pane bottom unless it is
 * asking for a choice; agents without a detector always dock that way.
 */
export function decidePromptEditor({
  scan,
  boxSeen,
  agentHasText,
  status,
  menu,
}: PromptEditorSituation): PromptEditorDecision {
  const blocked = status === "blocked";
  if (scan.state === "box") {
    if (agentHasText) return { placement: { mode: "hidden" }, selection: true };
    // A stale status alone must not swallow the first digit of a prompt, so
    // a box still on screen yields keys only when a choice is drawn too.
    return {
      placement: { mode: "overlay", region: scan.region },
      selection: blocked && menu,
    };
  }
  if (blocked || menu || (scan.state === "absent" && boxSeen))
    return { placement: { mode: "hidden" }, selection: true };
  return { placement: { mode: "dock" }, selection: false };
}
