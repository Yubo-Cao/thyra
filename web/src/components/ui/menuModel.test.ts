import { describe, expect, test } from "bun:test";
import {
  disabledMenuKeys,
  findMenuItem,
  menuHasChecks,
  normalizeMenu,
} from "./menuModel";

describe("menu model", () => {
  test("groups loose items between sections into untitled sections", () => {
    const sections = normalizeMenu([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { title: "Group", items: [{ id: "c", label: "C" }] },
      { id: "d", label: "D" },
    ]);
    expect(sections.map((section) => section.title)).toEqual([
      undefined,
      "Group",
      undefined,
    ]);
    expect(
      sections.map((section) => section.items.map((item) => item.id)),
    ).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(new Set(sections.map((section) => section.id)).size).toBe(3);
  });

  test("drops empty sections and repeated ids", () => {
    const sections = normalizeMenu([
      { title: "Empty", items: [] },
      { id: "keep", title: "Kept", items: [{ id: "x", label: "X" }] },
      { title: "Repeat", items: [{ id: "x", label: "Again" }] },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe("keep");
    expect(sections[0].items[0].label).toBe("X");
  });

  test("danger sections mark their items", () => {
    const [section] = normalizeMenu([
      {
        danger: true,
        items: [
          { id: "close", label: "Close" },
          { id: "remove", label: "Remove", danger: true },
        ],
      },
    ]);
    expect(section.items.every((item) => item.danger)).toBe(true);
  });

  test("finds items, disabled keys, and check columns", () => {
    const action = () => {};
    const sections = normalizeMenu([
      { id: "a", label: "A", onAction: action },
      { items: [{ id: "b", label: "B", disabled: true, checked: false }] },
    ]);
    expect(findMenuItem(sections, "a")?.onAction).toBe(action);
    expect(findMenuItem(sections, "missing")).toBeUndefined();
    expect(disabledMenuKeys(sections)).toEqual(["b"]);
    expect(menuHasChecks(sections)).toBe(true);
    expect(menuHasChecks(normalizeMenu([{ id: "a", label: "A" }]))).toBe(false);
  });
});
