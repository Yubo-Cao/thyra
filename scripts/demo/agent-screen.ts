/**
 * Print a fake agent's screen for the pane width. The `claude` and `codex`
 * stand-ins written by `capture-screenshots.ts` call this on start and on
 * every resize: `bun agent-screen.ts <agent>-<project> <columns>`.
 */
import { renderAgentScreen } from "./fixture";

const [key = "", columns = "80"] = process.argv.slice(2);
// Hide the cursor, clear the screen and scrollback, then draw from the top.
process.stdout.write(
  `\u001b[?25l\u001b[H\u001b[2J\u001b[3J${renderAgentScreen(key, Number(columns) || 80)}`,
);
