import { expect, test } from "bun:test";
import {
  hunksOf,
  patchForWholeFile,
  patchFromHunks,
  patchFromTexts,
  truncatePatch,
} from "./diff";

test("a one-line change keeps its neighbours as context", () => {
  expect(patchFromTexts("alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n")).toBe(
    ["@@ -1,3 +1,3 @@", " alpha", "-beta", "+BETA", " gamma"].join("\n"),
  );
});

test("line numbers start where the text sits in its file", () => {
  expect(patchFromTexts("old", "new", 40)).toBe(
    ["@@ -40,1 +40,1 @@", "-old", "+new"].join("\n"),
  );
});

test("distant changes become separate hunks with three lines of context", () => {
  const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  const after = [...before];
  after[1] = "changed 2";
  after[24] = "changed 25";
  after.splice(27, 0, "added");
  expect(patchFromTexts(before.join("\n"), after.join("\n"))).toBe(
    [
      "@@ -1,5 +1,5 @@",
      " line 1",
      "-line 2",
      "+changed 2",
      " line 3",
      " line 4",
      " line 5",
      "@@ -22,9 +22,10 @@",
      " line 22",
      " line 23",
      " line 24",
      "-line 25",
      "+changed 25",
      " line 26",
      " line 27",
      "+added",
      " line 28",
      " line 29",
      " line 30",
    ].join("\n"),
  );
});

test("pure insertions and deletions name the line before an empty side", () => {
  expect(patchFromTexts("", "one\ntwo\n")).toBe("@@ -0,0 +1,2 @@\n+one\n+two");
  expect(patchFromTexts("one\ntwo\n", "")).toBe("@@ -1,2 +0,0 @@\n-one\n-two");
  expect(patchFromTexts("same\n", "same\n")).toBe("");
});

test("an edit script applies cleanly for arbitrary texts", () => {
  // Replaying the hunks over the old text must give the new text.
  const apply = (oldText: string, patch: string) => {
    const lines = oldText.split("\n");
    const out: string[] = [];
    let cursor = 0;
    for (const hunk of patch.split(/^(?=@@)/m).filter(Boolean)) {
      const [header, ...body] = hunk.replace(/\n$/, "").split("\n");
      const start = Number(/^@@ -(\d+),(\d+)/.exec(header!)![1]);
      const count = Number(/^@@ -(\d+),(\d+)/.exec(header!)![2]);
      const from = count === 0 ? start : start - 1;
      out.push(...lines.slice(cursor, from));
      cursor = from;
      for (const line of body) {
        if (line.startsWith("+")) out.push(line.slice(1));
        else {
          expect(lines[cursor]).toBe(line.slice(1));
          if (line.startsWith(" ")) out.push(line.slice(1));
          cursor++;
        }
      }
    }
    out.push(...lines.slice(cursor));
    return out.join("\n");
  };
  let seed = 7;
  const random = (limit: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % limit;
  };
  for (let round = 0; round < 60; round++) {
    const before = Array.from({ length: random(40) }, () => `w${random(6)}`);
    const after = before.flatMap((line) =>
      random(4) === 0 ? [] : random(4) === 0 ? [line, `n${random(6)}`] : [line],
    );
    const oldText = before.join("\n");
    const newText = after.join("\n");
    expect(apply(oldText, patchFromTexts(oldText, newText))).toBe(newText);
  }
});

test("texts too far apart fall back to one replacement", () => {
  const before = Array.from({ length: 1500 }, (_, index) => `a${index}`);
  const after = Array.from({ length: 1500 }, (_, index) => `b${index}`);
  const patch = patchFromTexts(before.join("\n"), after.join("\n"));
  expect(patch.startsWith("@@ -1,1500 +1,1500 @@\n-a0\n")).toBe(true);
  expect(patch.endsWith("+b1499")).toBe(true);
});

test("a whole file is one hunk of additions or deletions", () => {
  expect(patchForWholeFile("hi\n", "+")).toBe("@@ -0,0 +1,1 @@\n+hi");
  expect(patchForWholeFile("a\nb", "-")).toBe("@@ -1,2 +0,0 @@\n-a\n-b");
  expect(patchForWholeFile("", "+")).toBe("");
});

test("reported hunks are rendered, malformed ones refused", () => {
  expect(
    patchFromHunks([
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [" alpha", "-beta", "+gamma"],
      },
    ]),
  ).toBe("@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma");
  expect(patchFromHunks([])).toBeNull();
  expect(patchFromHunks([{ oldStart: 1, lines: ["+x"] }])).toBeNull();
  expect(patchFromHunks("nope")).toBeNull();
});

test("file headers before the first hunk are dropped", () => {
  expect(
    hunksOf(
      "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    ),
  ).toBe("@@ -1 +1 @@\n-a\n+b");
  expect(hunksOf("@@ -1 +1 @@\n-a\n+b")).toBe("@@ -1 +1 @@\n-a\n+b");
  expect(hunksOf("no hunks here")).toBe("no hunks here");
});

test("a patch is cut at a line and its last header recounted", () => {
  const patch = [
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "@@ -10,3 +10,3 @@",
    " ten",
    "-eleven",
    "+ELEVEN",
    " twelve",
  ].join("\n");
  expect(truncatePatch(patch, 1000)).toEqual({ patch, truncated: false });
  const cut = truncatePatch(patch, patch.indexOf("+ELEVEN"));
  expect(cut.truncated).toBe(true);
  expect(cut.patch).toBe(
    [
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "@@ -10,2 +10,1 @@",
      " ten",
      "-eleven",
    ].join("\n"),
  );
  // A header left without a body goes too.
  expect(truncatePatch(patch, patch.indexOf(" ten")).patch).toBe(
    ["@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n"),
  );
});
