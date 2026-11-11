import { describe, expect, jest, test } from "bun:test";
import {
  PANE_DRAG_LONG_PRESS_MS,
  PANE_DRAG_SLOP_PX,
  PANE_DRAG_TOUCH_SLOP_PX,
  PaneDragGesture,
} from "./paneDragGesture";

const start = { x: 100, y: 100 };

describe("PaneDragGesture with a mouse or pen", () => {
  test("drags once it moves past the slop, without waiting", () => {
    const gesture = new PaneDragGesture(start, false);
    expect(gesture.move({ x: 100 + PANE_DRAG_SLOP_PX - 1, y: 100 })).toBe(
      "pending",
    );
    expect(gesture.holding).toBe(false);
    expect(gesture.move({ x: 100 + PANE_DRAG_SLOP_PX, y: 100 })).toBe(
      "dragging",
    );
    expect(gesture.holding).toBe(true);
  });
});

describe("PaneDragGesture with a finger", () => {
  test("a long press arms it and the next move drags", () => {
    jest.useFakeTimers();
    try {
      let armed = 0;
      const gesture = new PaneDragGesture(start, true, () => armed++);
      // Moving within the slop before the long press does not drag yet.
      expect(gesture.move({ x: 105, y: 104 })).toBe("pending");
      jest.advanceTimersByTime(PANE_DRAG_LONG_PRESS_MS - 1);
      expect(armed).toBe(0);
      expect(gesture.phase).toBe("pending");
      jest.advanceTimersByTime(1);
      expect(armed).toBe(1);
      expect(gesture.phase).toBe("armed");
      expect(gesture.holding).toBe(true);
      expect(gesture.move({ x: 400, y: 300 })).toBe("dragging");
    } finally {
      jest.useRealTimers();
    }
  });

  test("moving past the slop before the long press abandons it", () => {
    jest.useFakeTimers();
    try {
      let armed = 0;
      const gesture = new PaneDragGesture(start, true, () => armed++);
      expect(
        gesture.move({ x: 100, y: 100 + PANE_DRAG_TOUCH_SLOP_PX + 1 }),
      ).toBe("abandoned");
      jest.advanceTimersByTime(PANE_DRAG_LONG_PRESS_MS * 2);
      expect(armed).toBe(0);
      expect(gesture.move({ x: 100, y: 100 })).toBe("abandoned");
      expect(gesture.holding).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a quick swipe never becomes a drag", () => {
    jest.useFakeTimers();
    try {
      const gesture = new PaneDragGesture(start, true);
      jest.advanceTimersByTime(80);
      expect(gesture.move({ x: 160, y: 100 })).toBe("abandoned");
      jest.advanceTimersByTime(PANE_DRAG_LONG_PRESS_MS);
      expect(gesture.phase).toBe("abandoned");
    } finally {
      jest.useRealTimers();
    }
  });

  test("abandoning a pending press (lift, cancel) stops the long press", () => {
    jest.useFakeTimers();
    try {
      let armed = 0;
      const gesture = new PaneDragGesture(start, true, () => armed++);
      gesture.abandon();
      jest.advanceTimersByTime(PANE_DRAG_LONG_PRESS_MS);
      expect(armed).toBe(0);
      expect(gesture.phase).toBe("abandoned");
    } finally {
      jest.useRealTimers();
    }
  });
});
