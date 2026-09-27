import { expect, test } from "bun:test";
import { nextTabIndex } from "./tabsKeyboard";

test("arrow keys wrap and skip disabled tabs", () => {
  const disabled = [false, true, false, false];
  expect(nextTabIndex("ArrowRight", 0, disabled)).toBe(2);
  expect(nextTabIndex("ArrowRight", 3, disabled)).toBe(0);
  expect(nextTabIndex("ArrowLeft", 0, disabled)).toBe(3);
  expect(nextTabIndex("ArrowLeft", 2, disabled)).toBe(0);
  expect(nextTabIndex("Home", 3, [true, false, false])).toBe(1);
  expect(nextTabIndex("End", 0, [false, false, true])).toBe(1);
});

test("orientation picks the arrow pair and other keys are ignored", () => {
  const disabled = [false, false];
  expect(nextTabIndex("ArrowDown", 0, disabled, "vertical")).toBe(1);
  expect(nextTabIndex("ArrowRight", 0, disabled, "vertical")).toBeNull();
  expect(nextTabIndex("Enter", 0, disabled)).toBeNull();
  expect(nextTabIndex("ArrowRight", 0, [true, true])).toBeNull();
});
