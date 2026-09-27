import { expect, test } from "bun:test";
import { TooltipTiming } from "./tooltipTiming";

test("tooltips warm up after the first one and cool down after a pause", () => {
  const timing = new TooltipTiming(500, 400);
  expect(timing.showDelay(0)).toBe(500);
  timing.opened();
  expect(timing.showDelay(10)).toBe(0);
  timing.closed(1000);
  expect(timing.showDelay(1200)).toBe(0);
  expect(timing.showDelay(1400)).toBe(500);
  timing.closed(2000);
  expect(timing.showDelay(2600)).toBe(500);
});
