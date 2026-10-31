import { describe, expect, test } from "bun:test";
import { clampRect, dragRect, parseRect } from "./floatingWindowGeometry";

const viewport = { w: 1000, h: 800 };
const min = { w: 300, h: 200 };
const start = { x: 100, y: 100, w: 500, h: 400 };

describe("floating window geometry", () => {
  test("moving stays inside the viewport", () => {
    expect(dragRect(start, "move", 50, -20, viewport, min)).toEqual({
      ...start,
      x: 150,
      y: 80,
    });
    expect(dragRect(start, "move", 900, 900, viewport, min)).toEqual({
      ...start,
      x: 500,
      y: 400,
    });
  });

  test("resizing keeps the opposite edge and stops at the minimum", () => {
    expect(dragRect(start, "se", 100, 50, viewport, min)).toEqual({
      x: 100,
      y: 100,
      w: 600,
      h: 450,
    });
    // Dragging the west edge right shrinks from the left, down to min width.
    expect(dragRect(start, "w", 400, 0, viewport, min)).toEqual({
      x: 300,
      y: 100,
      w: 300,
      h: 400,
    });
    // North past the top stops at the viewport edge.
    expect(dragRect(start, "n", 0, -500, viewport, min)).toEqual({
      x: 100,
      y: 0,
      w: 500,
      h: 500,
    });
    expect(dragRect(start, "e", 2000, 0, viewport, min).w).toBe(900);
  });

  test("a stored rect is fitted to a smaller viewport", () => {
    expect(
      clampRect({ x: 900, y: 700, w: 1600, h: 300 }, { w: 800, h: 600 }, min),
    ).toEqual({ x: 0, y: 300, w: 800, h: 300 });
    expect(clampRect(start, { w: 200, h: 100 }, min)).toEqual({
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    });
  });

  test("parses only complete stored rects", () => {
    expect(parseRect(JSON.stringify(start))).toEqual(start);
    expect(parseRect('{"x":1,"y":2,"w":3}')).toBeNull();
    expect(parseRect("not json")).toBeNull();
    expect(parseRect(null)).toBeNull();
  });
});
