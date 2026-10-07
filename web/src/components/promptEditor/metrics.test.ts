import { expect, test } from "bun:test";
import type { TerminalEngine } from "../../terminalEngine";
import { measureTerminal } from "./metrics";

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
