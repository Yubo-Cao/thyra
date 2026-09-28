import { expect, test } from "bun:test";
import type { ShellHistoryEntry } from "../../../../shared/shell";
import {
  applyCompletion,
  autoEnabled,
  commonPrefix,
  ghostText,
  historyMatches,
  incomplete,
  navigateHistory,
  searchHistory,
  shellKey,
} from "./model";

test("completeness preserves quoted, escaped and nested substitutions", () => {
  for (const text of [
    "echo 'open",
    'echo "open',
    "echo \\",
    "echo $(pwd",
    "echo `pwd",
    'echo "$(echo "nested")',
  ])
    expect(incomplete(text)).toBe(true);
  for (const text of [
    "echo ok",
    "echo 'done'",
    'echo "done"',
    "echo $(pwd)",
    'echo "$(echo "nested")"',
    "echo `pwd`",
    "echo \\$",
    "echo '$(literal)'",
  ])
    expect(incomplete(text)).toBe(false);
});
const entry = (
  command: string,
  cwd: string,
  start_ts: number,
): ShellHistoryEntry => ({
  command,
  cwd,
  start_ts,
  end_ts: null,
  exit: null,
  pane: "p",
  shell: "bash",
  host: "host",
});
const entries = [
  entry("git status", "/here", 1),
  entry("git switch main", "/else", 3),
  entry("git show", "/here", 2),
  entry("ls", "/here", 4),
];
test("history navigation filters prefix and restores the original draft", () => {
  const matches = historyMatches(entries, "git s", "/here");
  expect(matches).toEqual(["git show", "git status", "git switch main"]);
  expect(navigateHistory(matches, -1, 1, "git s")).toEqual({
    index: 0,
    text: "git show",
  });
  expect(navigateHistory(matches, 0, -1, "git s")).toEqual({
    index: -1,
    text: "git s",
  });
  expect(navigateHistory(matches, 2, 1, "git s").index).toBe(2);
  expect(navigateHistory([], -1, 1, "draft").text).toBe("draft");
});
test("ghost prefers recent same-cwd matches and search supports subsequences", () => {
  expect(ghostText(entries, "git s", "/here")).toBe("how");
  expect(ghostText(entries, "", "/here")).toBe("");
  expect(searchHistory(entries, "gstm")).toEqual(["git switch main"]);
});
test("completion preserves server quoting and suffix beyond the replace range", () => {
  const result = {
    replace_start: 4,
    replace_end: 6,
    items: [{ text: "'my file'", kind: "file" as const }],
  };
  expect(
    applyCompletion("cat my --flag", result, result.items[0].text),
  ).toEqual({ text: "cat 'my file' --flag", caret: 13 });
  expect(
    applyCompletion(
      "cd sr",
      { ...result, replace_start: 3, replace_end: 5 },
      "src/",
    ).text,
  ).toBe("cd src/");
  expect(
    commonPrefix([
      { text: "src/", kind: "dir" },
      { text: "scripts/", kind: "dir" },
    ]),
  ).toBe("s");
});
test("Auto median uses strict thresholds and hysteresis", () => {
  expect(autoEnabled([], true)).toBe(false);
  expect(autoEnabled([11, 10, 300], false)).toBe(false);
  expect(autoEnabled([150, 200, 300], false)).toBe(true);
  expect(autoEnabled([60], false)).toBe(false);
  expect(autoEnabled([40], true)).toBe(true);
  expect(autoEnabled([39], true)).toBe(false);
  expect(autoEnabled([30, 90], false)).toBe(false);
});
test("shell keys distinguish execution, newline, IME and empty passthrough", () => {
  const key = (key: string, options = {}, empty = false) =>
    shellKey(
      {
        key,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        isComposing: false,
        ...options,
      },
      empty,
    );
  expect(key("Enter")).toBe("submit");
  expect(key("Enter", { shiftKey: true })).toBe("newline");
  expect(key("Enter", { altKey: true })).toBe("newline");
  expect(key("Enter", { isComposing: true })).toBeNull();
  expect(key("c", { ctrlKey: true })).toBe("clear");
  expect(key("c", { ctrlKey: true }, true)).toBe("\x03");
  expect(key("d", { ctrlKey: true }, true)).toBe("\x04");
  expect(key("d", { ctrlKey: true })).toBeNull();
  expect(key("]", { ctrlKey: true })).toBe("escape-hatch");
  expect(key("Tab", {}, true)).toBe("complete");
  expect(key("Escape", {}, true)).toBe("\x1b");
});
