import { describe, expect, test } from "bun:test";
import { hunkTargets } from "./ChangeDiff";

describe("hunkTargets", () => {
  test("finds the first changed line of every hunk", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+deux",
      "@@ -10,2 +10,3 @@",
      " ten",
      "+eleven",
      "--- not a header",
      "",
    ].join("\n");
    expect(hunkTargets(patch)).toEqual([
      { patch: 0, line: 2, side: "deletion", ratio: 2 / 12 },
      { patch: 0, line: 11, side: "addition", ratio: 11 / 12 },
    ]);
  });
});
