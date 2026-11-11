import { expect, test } from "bun:test";
import { clampControlsOffset, parseControlsOffset } from "./mobileControlsDrag";

// The controls' box in their corner of a 390x844 screen.
const home = { left: 230, top: 646, right: 380, bottom: 786 };

test("the controls move freely while their box stays on screen", () => {
  expect(clampControlsOffset({ x: -120, y: -300 }, home)).toEqual({
    x: -120,
    y: -300,
  });
});

test("the controls stop at the screen's left and top edges", () => {
  expect(clampControlsOffset({ x: -900, y: -900 }, home)).toEqual({
    x: 6 - 230,
    y: 6 - 646,
  });
});

test("the controls stay below the top bar", () => {
  expect(
    clampControlsOffset({ x: -10, y: -900 }, home, { left: 0, top: 46 }),
  ).toEqual({ x: -10, y: 46 + 6 - 646 });
});

test("the controls never pass their corner of the layout", () => {
  expect(clampControlsOffset({ x: 40, y: 25 }, home)).toEqual({ x: 0, y: 0 });
});

test("a box wider than the screen stays in its corner", () => {
  expect(
    clampControlsOffset({ x: -50, y: -50 }, { ...home, left: -20, top: 2 }),
  ).toEqual({ x: 0, y: 0 });
});

test("without controls there is no offset", () => {
  expect(clampControlsOffset({ x: -50, y: -50 }, null)).toEqual({ x: 0, y: 0 });
});

test("a stored offset is read back, and anything else is the corner", () => {
  expect(parseControlsOffset('{"x":-120,"y":-300}')).toEqual({
    x: -120,
    y: -300,
  });
  expect(parseControlsOffset('{"x":30,"y":-10}')).toEqual({ x: 0, y: -10 });
  for (const stored of [null, "", "nope", "[1,2]", '{"x":"1","y":2}', "null"])
    expect(parseControlsOffset(stored)).toEqual({ x: 0, y: 0 });
});
