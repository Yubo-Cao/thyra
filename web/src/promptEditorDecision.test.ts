import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind } from "./agentKind";
import {
  agentInputHasText,
  scanPromptBox,
  screenShowsSelection,
} from "./promptBoxDetect";
import { decidePromptEditor } from "./promptEditorDecision";
import {
  type PromptEditorKeyEvent,
  promptEditorKeyAction,
} from "./promptEditorKeys";
import { defaultShortcutBindings } from "./shortcutBindings";

// Real Claude Code 2.1 and Codex 0.158-0.160 screens; names end in the width.
// The text drops the dim attribute that marks the agents' placeholder hints,
// so only `typed` screens check the agent's own box for text.
function situation(
  agent: AgentKind,
  name: string,
  status: string,
  { boxSeen = true, typed = false } = {},
) {
  const text = readFileSync(
    join(import.meta.dir, "promptBoxFixtures", `${name}.txt`),
    "utf8",
  );
  const rows = text.replace(/\n$/, "").split("\n");
  const scan = scanPromptBox(agent, rows, Number(name.match(/-(\d+)$/)?.[1]));
  return {
    scan,
    boxSeen,
    agentHasText:
      typed && scan.state === "box" && agentInputHasText(rows, scan.region),
    status,
    menu: screenShowsSelection(rows),
  };
}

function key(name: string): PromptEditorKeyEvent {
  return {
    key: name,
    code: name,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
  };
}

const ESC = "\x1b";
type Expected = {
  mode: "overlay" | "dock" | "hidden";
  /** What an empty editor does with "1", "y", Up, Left and Esc (null: types it). */
  keys?: (string | null)[];
};
const PROMPT_KEYS = [null, null, `${ESC}[A`, null, ESC];
const CHOICE_KEYS = ["1", "y", `${ESC}[A`, `${ESC}[D`, ESC];

const cases: [string, ReturnType<typeof situation>, Expected][] = [
  [
    "Claude Code permission prompt",
    situation("claude", "claude-permission-80", "blocked"),
    { mode: "hidden" },
  ],
  [
    "Claude Code question form (AskUserQuestion)",
    situation("claude", "claude-question-119", "blocked"),
    { mode: "hidden" },
  ],
  [
    "Claude Code folder trust before the box was ever seen",
    situation("claude", "claude-trust-80", "blocked", { boxSeen: false }),
    { mode: "hidden" },
  ],
  [
    "Claude Code model picker, status still idle",
    situation("claude", "claude-model-picker-80", "idle"),
    { mode: "hidden" },
  ],
  [
    "Codex command approval",
    situation("codex", "codex-approval-80", "blocked"),
    { mode: "hidden" },
  ],
  [
    "Codex numbered question (request_user_input)",
    situation("codex", "codex-question-120", "blocked"),
    { mode: "hidden" },
  ],
  [
    "Codex question with its notes field (enter to submit answer)",
    situation("codex", "codex-answer-notes-120", "blocked"),
    { mode: "hidden" },
  ],
  [
    "Codex startup menu while Herdr still reports idle",
    situation("codex", "codex-startup-menu-120", "idle", { boxSeen: false }),
    { mode: "hidden" },
  ],
  [
    "Claude Code slash-command popup",
    situation("claude", "claude-slash-80", "idle", { typed: true }),
    { mode: "hidden" },
  ],
  [
    "Codex slash-command popup",
    situation("codex", "codex-slash-80", "idle", { typed: true }),
    { mode: "hidden" },
  ],
  [
    "Claude Code idle prompt",
    situation("claude", "claude-idle-80", "idle"),
    { mode: "overlay", keys: PROMPT_KEYS },
  ],
  [
    "Codex idle prompt",
    situation("codex", "codex-idle-80", "idle"),
    { mode: "overlay", keys: PROMPT_KEYS },
  ],
  [
    "Claude Code working",
    situation("claude", "claude-working-80", "working"),
    { mode: "overlay", keys: PROMPT_KEYS },
  ],
  [
    "Codex working",
    situation("codex", "codex-working-80", "working"),
    { mode: "overlay", keys: PROMPT_KEYS },
  ],
  [
    "an idle box under a stale blocked status types digits",
    situation("claude", "claude-idle-80", "blocked"),
    { mode: "overlay", keys: PROMPT_KEYS },
  ],
  [
    "a box on screen with a choice drawn too yields choice keys",
    { ...situation("codex", "codex-idle-80", "blocked"), menu: true },
    { mode: "overlay", keys: CHOICE_KEYS },
  ],
  [
    "the box gone after it was seen, with no choice detected",
    {
      ...situation("claude", "claude-idle-80", "idle"),
      scan: { state: "absent" } as const,
    },
    { mode: "hidden" },
  ],
  [
    "an agent without a detector docks",
    {
      ...situation("claude", "claude-idle-80", "idle"),
      scan: { state: "unsupported" } as const,
    },
    { mode: "dock", keys: PROMPT_KEYS },
  ],
  [
    "an agent without a detector hides while blocked",
    {
      ...situation("claude", "claude-idle-80", "blocked"),
      scan: { state: "unsupported" } as const,
    },
    { mode: "hidden" },
  ],
];

describe("prompt editor decision", () => {
  for (const [name, input, expected] of cases)
    test(name, () => {
      const decision = decidePromptEditor(input);
      expect(decision.placement.mode).toBe(expected.mode);
      if (!expected.keys) return;
      const options = {
        empty: true,
        applicationCursor: false,
        bindings: defaultShortcutBindings("linux"),
        enterSends: true,
        selection: decision.selection,
      };
      expect(
        ["1", "y", "ArrowUp", "ArrowLeft", "Escape"].map((name) => {
          const action = promptEditorKeyAction(key(name), options);
          return action?.type === "forward" ? action.data : null;
        }),
      ).toEqual(expected.keys);
      // A draft keeps every one of them as text or editing.
      expect(
        promptEditorKeyAction(key("1"), { ...options, empty: false }),
      ).toBeNull();
    });
});

describe("selection UI on screen", () => {
  test("idle, working and finished screens draw no choice", () => {
    for (const name of [
      "claude-idle-80",
      "claude-idle-140",
      "claude-working-80",
      "claude-multiline-80",
      "claude-plan-mode-80",
      "codex-idle-80",
      "codex-working-80",
      "codex-done-80",
      "codex-multiline-80",
    ]) {
      const rows = readFileSync(
        join(import.meta.dir, "promptBoxFixtures", `${name}.txt`),
        "utf8",
      ).split("\n");
      expect([name, screenShowsSelection(rows)]).toEqual([name, false]);
    }
  });

  test("a numbered list without a cursor is not a menu", () => {
    expect(
      screenShowsSelection(["Steps:", "1. build", "2. test", "", "› "]),
    ).toBe(false);
    expect(screenShowsSelection(["❯ 1. Yes", "  2. No"])).toBe(true);
  });
});
