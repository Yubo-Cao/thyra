import { expect, test } from "bun:test";
import type { TerminalEngine } from "../../terminalEngine";
import { liftOffset, measureTerminal } from "./metrics";

test("prompt width is clipped to the visible pane and coordinates undo ancestor zoom", () => {
  const term = {
    screenSize: () => ({ width: 500, height: 400 }),
    screenBounds: () => ({ left: 30, top: 50, width: 1000, height: 800 }),
    rows: 20,
    cols: 100,
    options: { fontSize: 14 },
  } as unknown as TerminalEngine;
  const host = {
    offsetWidth: 300,
    offsetHeight: 500,
    clientWidth: 300,
    getBoundingClientRect: () => ({
      left: 10,
      top: 10,
      width: 600,
      height: 1000,
    }),
  } as unknown as HTMLElement;
  expect(measureTerminal(term, host)).toEqual({
    left: 10,
    top: 20,
    width: 290,
    rows: 20,
    rowHeight: 20,
    cellWidth: 5,
    fontSize: 14,
  });
});

test("the terminal lifts by whole device pixels", () => {
  expect(liftOffset(3, 17, 1)).toBe(51);
  // 22 device pixels a row at 125%.
  expect(liftOffset(4, 17.6, 1.25) * 1.25).toBe(88);
  // A follow scale's fractional rows still land on the pixel grid.
  expect(liftOffset(2, 10.3, 2) * 2).toBe(41);
  expect(liftOffset(0, 17, 1)).toBe(0);
});
