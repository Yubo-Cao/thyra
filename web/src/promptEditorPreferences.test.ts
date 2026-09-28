import { describe, expect, test } from "bun:test";
import { promptEditorOpen } from "./promptEditorPreferences";

describe("prompt editor visibility", () => {
  const defaults = { byDefault: true, panes: {} };

  test("agent panes follow the default until toggled", () => {
    expect(promptEditorOpen(defaults, "p1", true)).toBe(true);
    expect(
      promptEditorOpen({ ...defaults, byDefault: false }, "p1", true),
    ).toBe(false);
    expect(
      promptEditorOpen({ byDefault: true, panes: { p1: false } }, "p1", true),
    ).toBe(false);
    expect(
      promptEditorOpen({ byDefault: false, panes: { p1: true } }, "p1", true),
    ).toBe(true);
  });

  test("shell panes never show it, whatever was toggled", () => {
    expect(promptEditorOpen(defaults, "p1", false)).toBe(false);
    expect(
      promptEditorOpen({ byDefault: true, panes: { p1: true } }, "p1", false),
    ).toBe(false);
  });
});
