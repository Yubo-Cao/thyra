import { describe, expect, test } from "bun:test";
import { promptEditorOpen } from "./promptEditorPreferences";

describe("prompt editor visibility", () => {
  const auto = { mode: "auto" as const, panes: {} };

  test("Auto follows the link and keeps a pane with a draft", () => {
    expect(promptEditorOpen(auto, "p1", true, false)).toBe(false);
    expect(promptEditorOpen(auto, "p1", true, true)).toBe(true);
    expect(promptEditorOpen(auto, "p1", true, false, true)).toBe(true);
  });

  test("On and Off ignore the link", () => {
    const on = { mode: "on" as const, panes: {} };
    const off = { mode: "off" as const, panes: {} };
    expect(promptEditorOpen(on, "p1", true, false)).toBe(true);
    expect(promptEditorOpen(off, "p1", true, true, true)).toBe(false);
  });

  test("a pane's own toggle wins over the mode", () => {
    expect(
      promptEditorOpen({ ...auto, panes: { p1: false } }, "p1", true, true),
    ).toBe(false);
    expect(
      promptEditorOpen({ mode: "off", panes: { p1: true } }, "p1", true, false),
    ).toBe(true);
  });

  test("shell panes never show it, whatever was toggled", () => {
    expect(promptEditorOpen(auto, "p1", false, true, true)).toBe(false);
    expect(
      promptEditorOpen({ mode: "on", panes: { p1: true } }, "p1", false, true),
    ).toBe(false);
  });
});
