import { describe, expect, test } from "bun:test";
import {
  clampPinchScale,
  PinchTracker,
  pinchedTerminalZoom,
  zoomedTerminalFontSize,
} from "./touchGestures";

const at = (identifier: number, clientX: number, clientY: number) => ({
  identifier,
  clientX,
  clientY,
});

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
