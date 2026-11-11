import type { AgentFileDiff } from "../../../shared/agentSession";

export type DiffLine = {
  kind: "hunk" | "add" | "remove" | "context" | "note";
  text: string;
  /** Line number in the new file; removed lines have none. */
  line?: number;
};

export type ParsedDiff = { lines: DiffLine[]; added: number; removed: number };

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Lines of a unified diff body with their numbers. File headers are skipped
 * (the path is shown beside the diff); a body without hunk headers still
 * colours by its `+` and `-` prefixes.
 */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const result: ParsedDiff = { lines: [], added: 0, removed: 0 };
  let newLine = 0;
  let inHunk = false;
  const rows = patch.split("\n");
  if (rows[rows.length - 1] === "") rows.pop();
  for (const row of rows) {
    const hunk = HUNK.exec(row);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      result.lines.push({ kind: "hunk", text: row });
    } else if (
      !inHunk &&
      /^(?:diff |index |--- |\+\+\+ |(?:new|deleted) file |similarity |rename )/.test(
        row,
      )
    ) {
      // Header of the file the caller already names.
    } else if (row.startsWith("+")) {
      result.added++;
      result.lines.push({
        kind: "add",
        text: row.slice(1),
        line: inHunk ? newLine++ : undefined,
      });
    } else if (row.startsWith("-")) {
      result.removed++;
      result.lines.push({ kind: "remove", text: row.slice(1) });
    } else if (row.startsWith("\\")) {
      result.lines.push({ kind: "note", text: row.slice(1).trim() });
    } else {
      result.lines.push({
        kind: "context",
        text: row.startsWith(" ") ? row.slice(1) : row,
        line: inHunk ? newLine++ : undefined,
      });
    }
  }
  return result;
}

/** Lines added and removed across a tool call's file changes. */
export function diffTotals(diffs: readonly AgentFileDiff[]) {
  let added = 0;
  let removed = 0;
  for (const diff of diffs) {
    const parsed = parseUnifiedDiff(diff.patch);
    added += parsed.added;
    removed += parsed.removed;
  }
  return { added, removed };
}
