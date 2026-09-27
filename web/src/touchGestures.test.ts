import { describe, expect, test } from "bun:test";
import {
  adjacentPane,
  clampPinchScale,
  paneNavigationOrder,
  PinchTracker,
  pinchedTerminalZoom,
  SwipeTracker,
  zoomedTerminalFontSize,
} from "./touchGestures";
import type { Pane } from "./types";

const at = (identifier: number, clientX: number, clientY: number) => ({
  identifier,
  clientX,
  clientY,
});
/** `count` fingers 20px apart vertically, all shifted by (dx, dy). */
const fingers = (count: number, dx = 0, dy = 0) =>
  Array.from({ length: count }, (_, i) => at(i, 200 + dx, 100 + i * 20 + dy));

describe("pinch", () => {
  test("a spreading pair becomes a pinch with its distance ratio", () => {
    const pinch = new PinchTracker();
    pinch.begin([at(0, 100, 100), at(1, 200, 100)]);
    expect(pinch.move([at(0, 95, 100), at(1, 205, 100)])?.mode).toBe("pending");
    const move = pinch.move([at(0, 50, 100), at(1, 250, 100)]);
    expect(move?.mode).toBe("pinch");
    expect(move?.scale).toBe(2);
  });

  test("a pair moving together pans and keeps panning while it drifts", () => {
    const pinch = new PinchTracker();
    pinch.begin([at(0, 100, 100), at(1, 200, 100)]);
    const pan = pinch.move([at(0, 100, 130), at(1, 200, 130)]);
    expect(pan).toEqual({ mode: "pan", scale: 1, dx: 0, dy: 30 });
    // Distance changes after the pan locked in do not zoom.
    expect(pinch.move([at(0, 60, 160), at(1, 240, 160)])?.scale).toBe(1);
  });

  test("the scale maps to half-pixel font sizes within limits", () => {
    expect(zoomedTerminalFontSize(12.35, 1)).toBe(12.35);
    expect(zoomedTerminalFontSize(13, 1.1)).toBe(14.5);
    expect(zoomedTerminalFontSize(13, 10)).toBe(32);
    expect(zoomedTerminalFontSize(13, 0.1)).toBe(8);
    expect(pinchedTerminalZoom(13, 1, 1.5)).toBe(19.5 / 13);
    expect(pinchedTerminalZoom(13, 19.5 / 13, 1 / 1.5)).toBe(1);
    // Within half a pixel of the default resets to it.
    expect(pinchedTerminalZoom(13, 1, 1.015)).toBe(1);
    expect(pinchedTerminalZoom(12.35, 1, 1.01)).toBe(1);
    expect(clampPinchScale(13, 2, 2)).toBe(32 / 26);
    expect(clampPinchScale(13, 1, 0.5)).toBe(8 / 13);
  });
});

describe("pane swipe", () => {
  const swipe = (
    count: number,
    setting: number,
    dx: number,
    dy: number,
  ): -1 | 0 | 1 => {
    const tracker = new SwipeTracker();
    for (let down = 1; down <= count; down++)
      tracker.touch(fingers(down), setting);
    tracker.touch(fingers(count, dx / 2, dy / 2), setting);
    tracker.touch(fingers(count, dx, dy), setting);
    const step = tracker.lift(count - 1);
    for (let left = count - 2; left >= 0; left--) tracker.lift(left);
    return step;
  };

  test("left-to-right moves forward, right-to-left back", () => {
    expect(swipe(3, 3, 80, 10)).toBe(1);
    expect(swipe(3, 3, -80, 10)).toBe(-1);
    expect(swipe(4, 4, 80, 0)).toBe(1);
  });

  test("short, vertical, and wrong-count swipes do nothing", () => {
    expect(swipe(3, 3, 40, 0)).toBe(0);
    expect(swipe(3, 3, 80, 60)).toBe(0);
    expect(swipe(3, 4, 120, 0)).toBe(0);
    expect(swipe(4, 3, 120, 0)).toBe(0);
    expect(swipe(3, 0, 120, 0)).toBe(0);
  });

  test("lifting a finger early or a cancel ends the swipe", () => {
    const tracker = new SwipeTracker();
    tracker.touch(fingers(3), 3);
    tracker.touch(fingers(3, 20), 3);
    expect(tracker.lift(2)).toBe(0);
    // The remaining fingers finishing the motion do not revive it.
    tracker.touch(fingers(2, 120), 3);
    expect(tracker.lift(1)).toBe(0);
    expect(tracker.lift(0)).toBe(0);

    tracker.touch(fingers(3), 3);
    tracker.touch(fingers(3, 120), 3);
    tracker.cancel();
    expect(tracker.lift(0)).toBe(0);
    // A fresh gesture works after the reset.
    tracker.touch(fingers(3), 3);
    tracker.touch(fingers(3, 120), 3);
    expect(tracker.lift(2)).toBe(1);
  });
});

describe("pane navigation order", () => {
  const pane = (pane_id: string, workspace_id: string, tab_id: string) =>
    ({ pane_id, workspace_id, tab_id }) as Pane;
  const workspaces = [
    { workspace_id: "w2", number: 2 },
    { workspace_id: "w1", number: 1 },
  ];
  const tabs = [
    { tab_id: "t2", label: "2", number: 2, pane_count: 1 },
    { tab_id: "t1", label: "1", number: 1, pane_count: 2 },
    { tab_id: "t3", label: "1", number: 1, pane_count: 1 },
  ];
  const panes = [
    pane("p4", "w2", "t3"),
    pane("p3", "w1", "t2"),
    pane("p1", "w1", "t1"),
    pane("p2", "w1", "t1"),
  ];
  const order = paneNavigationOrder(workspaces, tabs, panes);

  test("flattens workspaces, then tabs, then panes", () => {
    expect(order.map((item) => item.pane_id)).toEqual(["p1", "p2", "p3", "p4"]);
  });

  test("steps wrap at both ends", () => {
    expect(adjacentPane(order, "p2", 1)?.pane_id).toBe("p3");
    expect(adjacentPane(order, "p4", 1)?.pane_id).toBe("p1");
    expect(adjacentPane(order, "p1", -1)?.pane_id).toBe("p4");
    expect(adjacentPane(order, "gone", -1)?.pane_id).toBe("p4");
    expect(adjacentPane(order.slice(0, 1), "p1", 1)).toBeNull();
    expect(adjacentPane([], null, 1)).toBeNull();
  });
});
