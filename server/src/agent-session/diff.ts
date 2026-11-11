/**
 * Unified diff bodies (hunks without a file header) for the `diffs` of edit
 * tools: built from an edit's old and new text, or from hunks an agent
 * reports, and cut to a size bound without breaking the format.
 */

type Edit = { op: " " | "-" | "+"; line: string };

const CONTEXT_LINES = 3;
/** Past this many differing lines the two sides are shown as one replacement. */
const MAX_EDIT_DISTANCE = 1000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Myers' shortest edit script between two line lists (null: too far apart). */
function shortestEdits(a: string[], b: string[]): Edit[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        const edits: Edit[] = [];
        let cx = n;
        let cy = m;
        for (let step = d; step > 0; step--) {
          const previous = trace[step]!;
          const ck = cx - cy;
          const down =
            ck === -step ||
            (ck !== step &&
              previous[offset + ck - 1]! < previous[offset + ck + 1]!);
          const pk = down ? ck + 1 : ck - 1;
          const px = previous[offset + pk]!;
          const py = px - pk;
          while (cx > px && cy > py) {
            edits.push({ op: " ", line: a[cx - 1]! });
            cx--;
            cy--;
          }
          if (down) edits.push({ op: "+", line: b[cy - 1]! });
          else edits.push({ op: "-", line: a[cx - 1]! });
          cx = px;
          cy = py;
        }
        while (cx > 0 && cy > 0) {
          edits.push({ op: " ", line: a[cx - 1]! });
          cx--;
          cy--;
        }
        return edits.reverse();
      }
    }
  }
  return null;
}

function editScript(oldLines: string[], newLines: string[]): Edit[] {
  let head = 0;
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  )
    head++;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] ===
      newLines[newLines.length - 1 - tail]
  )
    tail++;
  const a = oldLines.slice(head, oldLines.length - tail);
  const b = newLines.slice(head, newLines.length - tail);
  const middle = shortestEdits(a, b) ?? [
    ...a.map((line): Edit => ({ op: "-", line })),
    ...b.map((line): Edit => ({ op: "+", line })),
  ];
  return [
    ...oldLines.slice(0, head).map((line): Edit => ({ op: " ", line })),
    ...middle,
    ...oldLines
      .slice(oldLines.length - tail)
      .map((line): Edit => ({ op: " ", line })),
  ];
}

function hunkHeader(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
): string {
  // A side without lines names the line before it, as `diff -u` does.
  const from = oldCount === 0 ? oldStart - 1 : oldStart;
  const to = newCount === 0 ? newStart - 1 : newStart;
  return `@@ -${from},${oldCount} +${to},${newCount} @@`;
}

/**
 * The change from `oldText` to `newText` as unified hunks with three lines of
 * context. Line numbers count from `firstLine` (the text's place in its file,
 * 1 when unknown). Identical texts give an empty string.
 */
export function patchFromTexts(
  oldText: string,
  newText: string,
  firstLine = 1,
): string {
  const edits = editScript(splitLines(oldText), splitLines(newText));
  const out: string[] = [];
  let index = 0;
  let oldLine = firstLine;
  let newLine = firstLine;
  while (index < edits.length) {
    if (edits[index]!.op === " ") {
      index++;
      oldLine++;
      newLine++;
      continue;
    }
    // A hunk starts three lines before the change and runs until more than
    // six unchanged lines separate it from the next one.
    const start = Math.max(0, index - CONTEXT_LINES);
    let end = index;
    let quiet = 0;
    for (let cursor = index; cursor < edits.length; cursor++) {
      if (edits[cursor]!.op === " ") {
        quiet++;
        if (quiet > 2 * CONTEXT_LINES) break;
      } else {
        quiet = 0;
        end = cursor;
      }
    }
    const stop = Math.min(edits.length, end + 1 + CONTEXT_LINES);
    const body = edits.slice(start, stop);
    const lead = index - start;
    const oldCount = body.filter((edit) => edit.op !== "+").length;
    const newCount = body.filter((edit) => edit.op !== "-").length;
    out.push(
      hunkHeader(oldLine - lead, oldCount, newLine - lead, newCount),
      ...body.map((edit) => edit.op + edit.line),
    );
    for (let cursor = index; cursor < stop; cursor++) {
      const op = edits[cursor]!.op;
      if (op !== "+") oldLine++;
      if (op !== "-") newLine++;
    }
    index = stop;
  }
  return out.join("\n");
}

/** A whole file added (`+`) or deleted (`-`) as one hunk. */
export function patchForWholeFile(content: string, op: "+" | "-"): string {
  const lines = splitLines(content);
  if (lines.length === 0) return "";
  return [
    op === "+"
      ? hunkHeader(1, 0, 1, lines.length)
      : hunkHeader(1, lines.length, 1, 0),
    ...lines.map((line) => op + line),
  ].join("\n");
}

export type StructuredHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

/** Hunks an agent reports as objects (Claude Code's `structuredPatch`). */
export function patchFromHunks(hunks: unknown): string | null {
  if (!Array.isArray(hunks) || hunks.length === 0) return null;
  const out: string[] = [];
  for (const value of hunks) {
    const hunk = value as Partial<StructuredHunk> | null;
    if (
      !hunk ||
      typeof hunk.oldStart !== "number" ||
      typeof hunk.oldLines !== "number" ||
      typeof hunk.newStart !== "number" ||
      typeof hunk.newLines !== "number" ||
      !Array.isArray(hunk.lines) ||
      !hunk.lines.every((line) => typeof line === "string")
    )
      return null;
    out.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines,
    );
  }
  return out.join("\n");
}

/**
 * Only the hunks of a unified diff: drops `diff --git`, `index`, `---` and
 * `+++` lines before the first hunk. Text without a hunk header is returned
 * unchanged.
 */
export function hunksOf(diff: string): string {
  const lines = diff.split("\n");
  const first = lines.findIndex((line) => line.startsWith("@@"));
  if (first <= 0) return diff.replace(/\n$/, "");
  return lines.slice(first).join("\n").replace(/\n$/, "");
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * A patch cut to at most `limit` characters at a line boundary. The header of
 * the hunk that was cut is rewritten to count the lines kept, so the result
 * still parses as a unified diff.
 */
export function truncatePatch(
  patch: string,
  limit: number,
): { patch: string; truncated: boolean } {
  if (patch.length <= limit) return { patch, truncated: false };
  const kept: string[] = [];
  let size = 0;
  let header = -1;
  for (const line of patch.split("\n")) {
    if (size + line.length + 1 > limit) break;
    if (HUNK_HEADER.test(line)) header = kept.length;
    kept.push(line);
    size += line.length + 1;
  }
  if (header >= 0) {
    const body = kept.slice(header + 1);
    if (body.length === 0) kept.length = header;
    else {
      const match = HUNK_HEADER.exec(kept[header]!)!;
      const oldCount = body.filter(
        (line) => line.startsWith(" ") || line.startsWith("-") || line === "",
      ).length;
      const newCount = body.filter(
        (line) => line.startsWith(" ") || line.startsWith("+") || line === "",
      ).length;
      kept[header] =
        `@@ -${match[1]},${oldCount} +${match[3]},${newCount} @@${match[5]}`;
    }
  }
  return { patch: kept.join("\n"), truncated: true };
}
