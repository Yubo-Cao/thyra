import { expect, test } from "bun:test";
import { autoEnabled, storedLocalEditorMode } from "./latencyAuto";

test("Auto median uses strict thresholds and hysteresis", () => {
  expect(autoEnabled([], true)).toBe(false);
  expect(autoEnabled([11, 10, 300], false)).toBe(false);
  expect(autoEnabled([150, 200, 300], false)).toBe(true);
  expect(autoEnabled([60], false)).toBe(false);
  expect(autoEnabled([40], true)).toBe(true);
  expect(autoEnabled([39], true)).toBe(false);
  expect(autoEnabled([30, 90], false)).toBe(false);
});

test("an unknown stored mode reads as Auto", () => {
  expect(storedLocalEditorMode(null)).toBe("auto");
  expect(storedLocalEditorMode("0")).toBe("auto");
  expect(storedLocalEditorMode("off")).toBe("off");
});
