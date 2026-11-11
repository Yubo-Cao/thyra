import { expect, test } from "bun:test";
import { diffTotals, parseUnifiedDiff } from "./diff";

const patch = [
  "--- a/src/limiter.ts",
  "+++ b/src/limiter.ts",
  "@@ -10,4 +10,5 @@ export class Limiter {",
  "   private tokens = 0;",
  "-  take() {",
  "+  take(count = 1) {",
  "+    if (count <= 0) return true;",
  "     return this.tokens > 0;",
  "\\ No newline at end of file",
  "",
].join("\n");

test("a unified diff parses into numbered, classified lines", () => {
  const parsed = parseUnifiedDiff(patch);
  expect(parsed.added).toBe(2);
  expect(parsed.removed).toBe(1);
  expect(parsed.lines).toEqual([
    { kind: "hunk", text: "@@ -10,4 +10,5 @@ export class Limiter {" },
    { kind: "context", text: "  private tokens = 0;", line: 10 },
    { kind: "remove", text: "  take() {" },
    { kind: "add", text: "  take(count = 1) {", line: 11 },
    { kind: "add", text: "    if (count <= 0) return true;", line: 12 },
    { kind: "context", text: "    return this.tokens > 0;", line: 13 },
    { kind: "note", text: "No newline at end of file" },
  ]);
});

test("a body without hunk headers still classifies its lines", () => {
  expect(parseUnifiedDiff("+added\n-removed\n same").lines).toEqual([
    { kind: "add", text: "added", line: undefined },
    { kind: "remove", text: "removed" },
    { kind: "context", text: "same", line: undefined },
  ]);
  expect(parseUnifiedDiff("").lines).toEqual([]);
});

test("removed lines that look like headers inside a hunk are content", () => {
  const parsed = parseUnifiedDiff("@@ -1,2 +1,1 @@\n--- old rule\n keep");
  expect(parsed.lines[1]).toEqual({ kind: "remove", text: "-- old rule" });
});

test("totals count changes across files", () => {
  expect(
    diffTotals([
      { path: "a.ts", patch },
      { path: "b.ts", patch: "@@ -1 +1,2 @@\n one\n+two\n" },
    ]),
  ).toEqual({ added: 3, removed: 1 });
});
