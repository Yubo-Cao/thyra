import { describe, expect, test, jest } from "bun:test";
import type { TerminalEngine } from "./terminalEngine";
import {
  TerminalTouchSelection,
  TERMINAL_LONG_PRESS_MS,
} from "./terminalTouchSelection";

describe("TerminalTouchSelection deadlines", () => {
  test("slop, cancel and reset invalidate even a parser-deferred long press", () => {
    jest.useFakeTimers();
    const term = { clearSelection() {} } as unknown as TerminalEngine;
    let begins = 0,
      releases = 0;
    let activate: (() => void) | null = null;
    const selection = new TerminalTouchSelection(term, {
      begin: (callback) => {
        begins++;
        activate = callback;
      },
      changed() {},
      release() {
        releases++;
      },
    });
    try {
      selection.start({ x: 10, y: 10 });
      selection.move({ x: 19, y: 10 });
      jest.advanceTimersByTime(TERMINAL_LONG_PRESS_MS);
      expect(begins).toBe(0);
      selection.start({ x: 10, y: 10 });
      selection.cancelPending();
      jest.advanceTimersByTime(TERMINAL_LONG_PRESS_MS);
      expect(begins).toBe(0);
      selection.start({ x: 10, y: 10 });
      jest.advanceTimersByTime(TERMINAL_LONG_PRESS_MS);
      expect(begins).toBe(1);
      selection.reset();
      (activate as unknown as () => void)();
      expect(selection.active).toBe(false);
      expect(releases).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
