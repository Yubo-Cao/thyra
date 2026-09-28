import type { AgentKind } from "./agentKind";

/**
 * Finds a coding agent's own prompt box on the rendered terminal screen, so
 * the prompt editor can sit exactly on top of it. Pure: the caller passes the
 * visible rows as text (right-trimmed, one string per row).
 *
 * Layouts were taken from real sessions (fixtures in `promptBoxFixtures/`):
 *
 * Claude Code draws its input between two full-width rules, with footer
 * lines (mode, hints) below the lower rule. Menus and permission prompts
 * indent their `❯` cursor and have no lower rule.
 *
 *     ────────────────────────
 *     ❯ first line of the draft
 *       wrapped or next line
 *     ────────────────────────
 *       ⏸ manual mode on · ? for shortcuts
 *
 * Older Claude Code versions box the input instead (`╭─╮ │ > │ ╰─╯`).
 *
 * Codex puts `›` in column 0 of its composer with continuation lines indented
 * by two spaces, a blank padding row on either side, and up to a few footer
 * rows at the bottom of the screen. Its selection menus (folder trust,
 * command approval) reuse `›` for the selected numbered option.
 *
 *
 *     › first line of the draft
 *       next line
 *
 *       model · cwd
 *       ← for agents · ? for shortcuts
 */

/**
 * Screen rows (0-based, inclusive) the agent's input box occupies, and the
 * rows inside it that hold the agent's own input line(s).
 */
export type PromptBoxRegion = {
  top: number;
  bottom: number;
  inputTop: number;
  inputBottom: number;
};

export type PromptBoxScan =
  /** The agent's prompt box is on screen. */
  | { state: "box"; region: PromptBoxRegion }
  /** A supported agent shows something else: a menu, a dialog, history. */
  | { state: "absent" }
  /** No detector for this agent: the editor docks at the pane bottom. */
  | { state: "unsupported" };

// Footer rows below the box: Claude's mode line, hints, and its `?` help.
const MAX_CLAUDE_FOOTER_ROWS = 10;
const MAX_CODEX_FOOTER_ROWS = 4;
// Key hints that only selection menus and dialogs print.
const MENU_HINT =
  /\b(?:enter to (?:confirm|select|continue|submit)|esc to (?:cancel|go back|back|close)|press enter\b|enter continue)/i;
const NUMBERED_OPTION = /^\s*\d+\.\s/;

function isBlank(row: string | undefined): boolean {
  return !row || row.trim() === "";
}

// A rule spans the row; Claude Code may title it (`─── History 3/5 ───`).
function isFullRule(row: string, cols: number): boolean {
  const trimmed = row.trimEnd();
  if (trimmed.length < Math.max(8, Math.floor(cols * 0.8))) return false;
  if (/^─+$/.test(trimmed)) return true;
  return (
    /^─{3}.*─{3}$/.test(trimmed) &&
    trimmed.replace(/[^─]/g, "").length >= cols * 0.6
  );
}

function footerLooksLikeMenu(rows: readonly string[]): boolean {
  return rows.some((row) => MENU_HINT.test(row));
}

/** Rows below `from` hold at most `limit` non-blank rows. */
function footerFits(
  rows: readonly string[],
  from: number,
  limit: number,
): boolean {
  let count = 0;
  for (let row = from; row < rows.length; row++) {
    if (!isBlank(rows[row]) && ++count > limit) return false;
  }
  return true;
}

function detectClaudeRuledBox(
  rows: readonly string[],
  cols: number,
): PromptBoxRegion | null {
  // The lower rule is the last full-width rule with only footer below it.
  let bottom = -1;
  for (let row = rows.length - 1; row >= 0; row--) {
    if (isFullRule(rows[row], cols)) {
      bottom = row;
      break;
    }
  }
  if (bottom < 2 || !footerFits(rows, bottom + 1, MAX_CLAUDE_FOOTER_ROWS))
    return null;
  let top = -1;
  for (let row = bottom - 1; row >= 0; row--) {
    if (isFullRule(rows[row], cols)) {
      top = row;
      break;
    }
  }
  if (top < 0 || top === bottom - 1) return null;
  if (!/^[❯>!#](?:\s|$)/.test(rows[top + 1])) return null;
  for (let row = top + 2; row < bottom; row++) {
    if (!isBlank(rows[row]) && !rows[row].startsWith("  ")) return null;
  }
  if (footerLooksLikeMenu(rows.slice(bottom + 1))) return null;
  return { top, bottom, inputTop: top + 1, inputBottom: bottom - 1 };
}

function detectClaudeFramedBox(
  rows: readonly string[],
): PromptBoxRegion | null {
  let bottom = -1;
  for (let row = rows.length - 1; row >= 0; row--) {
    if (/^\s*╰─+╯\s*$/.test(rows[row])) {
      bottom = row;
      break;
    }
  }
  if (bottom < 2 || !footerFits(rows, bottom + 1, MAX_CLAUDE_FOOTER_ROWS))
    return null;
  let top = -1;
  for (let row = bottom - 1; row >= 0; row--) {
    if (/^\s*╭─+╮\s*$/.test(rows[row])) {
      top = row;
      break;
    }
    if (!/^\s*│.*│\s*$/.test(rows[row])) return null;
  }
  if (top < 0 || !/^\s*│\s[❯>!#](?:\s|$)/.test(rows[top + 1] ?? ""))
    return null;
  return { top, bottom, inputTop: top + 1, inputBottom: bottom - 1 };
}

export function detectClaudePromptBox(
  rows: readonly string[],
  cols: number,
): PromptBoxRegion | null {
  return detectClaudeRuledBox(rows, cols) ?? detectClaudeFramedBox(rows);
}

export function detectCodexPromptBox(
  rows: readonly string[],
): PromptBoxRegion | null {
  let row = rows.length - 1;
  while (row >= 0 && isBlank(rows[row])) row--;
  const end = row;
  // Walk up through the footer to the composer, or to its blank padding row.
  while (row >= 0 && !isBlank(rows[row]) && !rows[row].startsWith("›")) row--;
  if (row < 0) return null;
  let blockEnd = end;
  if (isBlank(rows[row])) {
    if (end - row > MAX_CODEX_FOOTER_ROWS) return null;
    if (footerLooksLikeMenu(rows.slice(row + 1, end + 1))) return null;
    blockEnd = row - 1;
    while (blockEnd >= 0 && isBlank(rows[blockEnd])) blockEnd--;
  }
  // Continuation rows are indented; the first row carries the `›` marker.
  let marker = blockEnd;
  while (marker >= 0 && rows[marker].startsWith("  ")) marker--;
  if (marker < 0 || !/^›(?:\s|$)/.test(rows[marker])) return null;
  if (NUMBERED_OPTION.test(rows[marker].slice(1))) return null;
  // Cover the composer's blank padding rows, not the footer.
  const top = marker > 0 && isBlank(rows[marker - 1]) ? marker - 1 : marker;
  const bottom =
    blockEnd < end && isBlank(rows[blockEnd + 1]) ? blockEnd + 1 : blockEnd;
  return { top, bottom, inputTop: marker, inputBottom: blockEnd };
}

/**
 * Whether the agent's own input holds text. `rows` must have placeholder
 * (dim) cells blanked: Claude Code and Codex draw their hint text dim. Text
 * there came from outside the editor (recalled history, typing into the
 * terminal), so the agent's box shows instead of the editor.
 */
export function agentInputHasText(
  rows: readonly string[],
  region: PromptBoxRegion,
): boolean {
  for (let row = region.inputTop; row <= region.inputBottom; row++) {
    const text = (rows[row] ?? "")
      .replace(/^\s*│?\s?[❯>!#›]?/, "")
      .replace(/│\s*$/, "");
    if (text.trim()) return true;
  }
  return false;
}

/** Scans the visible rows for the prompt box of `agent`. */
export function scanPromptBox(
  agent: AgentKind,
  rows: readonly string[],
  cols: number,
): PromptBoxScan {
  let region: PromptBoxRegion | null;
  if (agent === "claude") region = detectClaudePromptBox(rows, cols);
  else if (agent === "codex") region = detectCodexPromptBox(rows);
  else return { state: "unsupported" };
  return region ? { state: "box", region } : { state: "absent" };
}

/** The editor's box in terminal rows: it grows upward from the agent's box. */
export type PromptEditorFrame = {
  /** First covered row; may be above the agent's box when the draft grows. */
  top: number;
  rows: number;
  /** Blank rows above the text, where the agent drew its top rule or padding. */
  padTop: number;
  /** Rows below the text: the agent's bottom rule, holding the send hint. */
  padBottom: number;
};

/** The share of the pane the editor may grow to before it scrolls. */
export const PROMPT_EDITOR_MAX_SHARE = 0.4;
const DOCK_ROWS = 3;

/**
 * Rows the editor covers for a placement and `textRows` of text: the agent's
 * box at least, taller as the text grows, up to 40% of the pane.
 */
export function promptEditorFrame(
  placement: PromptEditorPlacement,
  screenRows: number,
  textRows: number,
): PromptEditorFrame | null {
  if (placement.mode === "hidden" || screenRows <= 0) return null;
  const region =
    placement.mode === "overlay"
      ? placement.region
      : {
          top: Math.max(0, screenRows - DOCK_ROWS),
          bottom: screenRows - 1,
        };
  const regionRows = region.bottom - region.top + 1;
  const padTop = regionRows >= 3 ? 1 : 0;
  const padBottom = 1;
  const maxRows = Math.max(
    regionRows,
    Math.floor(screenRows * PROMPT_EDITOR_MAX_SHARE),
  );
  const rows = Math.min(
    maxRows,
    Math.max(regionRows, Math.max(1, textRows) + padTop + padBottom),
    region.bottom + 1,
  );
  return { top: region.bottom + 1 - rows, rows, padTop, padBottom };
}

export type PromptEditorPlacement =
  | { mode: "overlay"; region: PromptBoxRegion }
  | { mode: "dock" }
  | { mode: "hidden" };

/**
 * Where the editor goes for a scan. A supported agent that has shown its box
 * and now does not is in a menu or dialog: hide, so keys reach it. One whose
 * box was never found (a new layout, a startup screen) docks instead of
 * leaving the pane without an editor. Text in the agent's own box (recalled
 * history, typing into the terminal) also hides the editor, so it can be
 * seen and finished in place.
 */
export function promptEditorPlacement(
  scan: PromptBoxScan,
  boxSeen: boolean,
  agentHasText = false,
): PromptEditorPlacement {
  if (scan.state === "box")
    return agentHasText
      ? { mode: "hidden" }
      : { mode: "overlay", region: scan.region };
  if (scan.state === "absent" && boxSeen) return { mode: "hidden" };
  return { mode: "dock" };
}
