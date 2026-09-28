import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentInputHasText,
  detectClaudePromptBox,
  detectCodexPromptBox,
  promptEditorFrame,
  promptEditorPlacement,
  scanPromptBox,
} from "./promptBoxDetect";

// Screens captured from real Claude Code 2.1 and Codex 0.158 sessions (the
// legacy framed Claude box is synthetic). File names end in the width.
function screen(name: string) {
  const text = readFileSync(
    join(import.meta.dir, "promptBoxFixtures", `${name}.txt`),
    "utf8",
  );
  const rows = text.replace(/\n$/, "").split("\n");
  const cols = Number(name.match(/-(\d+)$/)?.[1]);
  return { rows, cols };
}

describe("Claude Code prompt box", () => {
  test.each([
    ["claude-idle-80", 26, 28],
    ["claude-idle-50", 19, 22],
    ["claude-idle-140", 36, 38],
    ["claude-multiline-80", 24, 28],
    ["claude-after-deny-80", 26, 28],
    ["claude-working-80", 26, 28],
    ["claude-scrolled-80", 26, 28],
    ["claude-slash-80", 26, 28],
    ["claude-plan-mode-80", 26, 28],
    ["claude-framed-legacy-60", 18, 21],
  ])("%s: rows %i-%i", (name, top, bottom) => {
    const { rows, cols } = screen(name);
    // The input sits between the rules (or box edges).
    expect(detectClaudePromptBox(rows, cols)).toEqual({
      top,
      bottom,
      inputTop: top + 1,
      inputBottom: bottom - 1,
    });
  });

  test.each([
    "claude-permission-80",
    "claude-trust-80",
    "claude-model-picker-80",
  ])("%s shows no prompt box", (name) => {
    const { rows, cols } = screen(name);
    expect(detectClaudePromptBox(rows, cols)).toBeNull();
    expect(scanPromptBox("claude", rows, cols)).toEqual({ state: "absent" });
  });

  test("a titled rule (history browsing) still bounds the box", () => {
    const rule = "─".repeat(40);
    const rows = [
      "⏺ reply",
      `─── History 5/5 ${"─".repeat(24)}`,
      "❯ recalled prompt",
      rule,
      "  ⏸ manual mode on",
    ];
    expect(detectClaudePromptBox(rows, 40)).toEqual({
      top: 1,
      bottom: 3,
      inputTop: 2,
      inputBottom: 2,
    });
  });

  test("a transcript `❯` line without rules is not the box", () => {
    const rows = ["❯ an earlier message", "", "⏺ reply", "", "", ""];
    expect(detectClaudePromptBox(rows, 40)).toBeNull();
  });

  test("a ruled box followed by a long footer is not the box", () => {
    const rule = "─".repeat(40);
    const rows = [rule, "❯ ", rule, ...Array.from({ length: 11 }, () => "x")];
    expect(detectClaudePromptBox(rows, 40)).toBeNull();
  });
});

describe("Codex prompt box", () => {
  test.each([
    ["codex-idle-80", 25, 27, 26, 26],
    ["codex-idle-50", 19, 21, 20, 20],
    ["codex-idle-140", 35, 37, 36, 36],
    ["codex-multiline-80", 23, 27, 24, 26],
    ["codex-working-80", 25, 27, 26, 26],
    ["codex-done-80", 25, 27, 26, 26],
    ["codex-slash-80", 25, 27, 26, 26],
  ])(
    "%s: rows %i-%i, input %i-%i",
    (name, top, bottom, inputTop, inputBottom) => {
      const { rows } = screen(name);
      expect(detectCodexPromptBox(rows)).toEqual({
        top,
        bottom,
        inputTop,
        inputBottom,
      });
    },
  );

  test.each(["codex-approval-80", "codex-trust-80"])(
    "%s is a menu, not the composer",
    (name) => {
      const { rows, cols } = screen(name);
      expect(detectCodexPromptBox(rows)).toBeNull();
      expect(scanPromptBox("codex", rows, cols)).toEqual({ state: "absent" });
    },
  );

  test("a composer that ends the screen needs no footer", () => {
    const rows = ["• reply", "", "› draft", "  more"];
    expect(detectCodexPromptBox(rows)).toEqual({
      top: 1,
      bottom: 3,
      inputTop: 2,
      inputBottom: 3,
    });
  });

  test("a screen without the marker has no composer", () => {
    expect(detectCodexPromptBox(["", "  just output", "", "  footer"])).toBe(
      null,
    );
  });
});

describe("agent input text", () => {
  // Rows as the editor reads them: dim placeholder cells already blanked.
  const region = (name: string) => {
    const { rows, cols } = screen(name);
    const scan = scanPromptBox(
      name.startsWith("codex") ? "codex" : "claude",
      rows,
      cols,
    );
    if (scan.state !== "box") throw new Error(`${name}: no box`);
    return { rows, region: scan.region };
  };

  test("typed or recalled text counts", () => {
    for (const name of [
      "claude-multiline-80",
      "codex-multiline-80",
      "claude-framed-legacy-60",
    ]) {
      const { rows, region: box } = region(name);
      expect(agentInputHasText(rows, box)).toBe(true);
    }
  });

  test("an empty box, or one showing only the dim hint, does not", () => {
    const { rows, region: box } = region("claude-after-deny-80");
    expect(agentInputHasText(rows, box)).toBe(false);
    const codex = region("codex-idle-80");
    const blanked = [...codex.rows];
    blanked[codex.region.inputTop] = "›";
    expect(agentInputHasText(blanked, codex.region)).toBe(false);
    // The framed box keeps its edges and marker out of the text.
    expect(
      agentInputHasText(["│ >  │"], {
        top: 0,
        bottom: 0,
        inputTop: 0,
        inputBottom: 0,
      }),
    ).toBe(false);
  });
});

describe("editor frame", () => {
  const claudeBox = {
    mode: "overlay" as const,
    region: { top: 26, bottom: 28, inputTop: 27, inputBottom: 27 },
  };

  test("a short draft covers exactly the agent's box", () => {
    expect(promptEditorFrame(claudeBox, 30, 1)).toEqual({
      top: 26,
      rows: 3,
      padTop: 1,
      padBottom: 1,
    });
  });

  test("a longer draft grows upward from the box", () => {
    expect(promptEditorFrame(claudeBox, 30, 5)).toEqual({
      top: 22,
      rows: 7,
      padTop: 1,
      padBottom: 1,
    });
  });

  test("growth stops at 40% of the pane", () => {
    expect(promptEditorFrame(claudeBox, 30, 50)?.rows).toBe(12);
    expect(promptEditorFrame(claudeBox, 30, 50)?.top).toBe(17);
  });

  test("a box without padding rows still gets a hint row", () => {
    expect(
      promptEditorFrame(
        {
          mode: "overlay",
          region: { top: 9, bottom: 9, inputTop: 9, inputBottom: 9 },
        },
        10,
        1,
      ),
    ).toEqual({ top: 8, rows: 2, padTop: 0, padBottom: 1 });
  });

  test("docking uses the bottom rows; hidden has no frame", () => {
    expect(promptEditorFrame({ mode: "dock" }, 24, 1)).toEqual({
      top: 21,
      rows: 3,
      padTop: 1,
      padBottom: 1,
    });
    expect(promptEditorFrame({ mode: "hidden" }, 24, 1)).toBeNull();
  });
});

describe("placement", () => {
  test("agents without a detector dock at the bottom", () => {
    const { rows, cols } = screen("claude-idle-80");
    const scan = scanPromptBox("gemini", rows, cols);
    expect(scan).toEqual({ state: "unsupported" });
    expect(promptEditorPlacement(scan, false)).toEqual({ mode: "dock" });
  });

  test("a found box places the overlay on it", () => {
    const { rows, cols } = screen("codex-idle-80");
    expect(
      promptEditorPlacement(scanPromptBox("codex", rows, cols), false),
    ).toEqual({
      mode: "overlay",
      region: { top: 25, bottom: 27, inputTop: 26, inputBottom: 26 },
    });
  });

  test("text in the agent's own box hides the editor", () => {
    const { rows, cols } = screen("claude-multiline-80");
    const scan = scanPromptBox("claude", rows, cols);
    expect(promptEditorPlacement(scan, true, true)).toEqual({ mode: "hidden" });
  });

  test("a menu hides the editor once the box has been seen", () => {
    const { rows, cols } = screen("claude-permission-80");
    const scan = scanPromptBox("claude", rows, cols);
    expect(promptEditorPlacement(scan, true)).toEqual({ mode: "hidden" });
    // Never seen: an unknown startup screen or layout docks instead.
    expect(promptEditorPlacement(scan, false)).toEqual({ mode: "dock" });
  });
});
