import { expect, test } from "bun:test";
import {
  newerWindow,
  olderWindow,
  TAIL_WINDOW,
  type TranscriptWindow,
  WINDOW_LIMIT,
  WINDOW_SIZE,
  WINDOW_STEP,
  windowRange,
} from "./transcriptWindow";

const ids = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => `i${from + index}`);

test("a short transcript mounts whole and the tail follows new items", () => {
  expect(windowRange(TAIL_WINDOW, ids(5))).toEqual({ start: 0, end: 5 });
  expect(windowRange(TAIL_WINDOW, ids(500))).toEqual({
    start: 500 - WINDOW_SIZE,
    end: 500,
  });
  expect(olderWindow(TAIL_WINDOW, ids(5))).toBe(TAIL_WINDOW);
  expect(newerWindow(TAIL_WINDOW, ids(500))).toBe(TAIL_WINDOW);
});

test("scrolling up grows the tail, then slides an anchored window", () => {
  const order = ids(2000);
  let window = TAIL_WINDOW;
  let range = windowRange(window, order);
  for (let step = 0; step < 100; step++) {
    window = olderWindow(window, order);
    const next = windowRange(window, order);
    expect(next.end - next.start).toBeLessThanOrEqual(WINDOW_LIMIT);
    // Consecutive windows overlap, so the reader's place stays mounted.
    expect(next.end).toBeGreaterThan(range.start);
    range = next;
  }
  expect(range).toEqual({ start: 0, end: WINDOW_LIMIT });
  expect(window.anchor).toBe("i0");
  expect(olderWindow(window, order)).toBe(window);
});

test("an anchored window ignores new items and survives dropped ones", () => {
  const order = ids(2000);
  let window = TAIL_WINDOW;
  for (let step = 0; step < 6; step++) window = olderWindow(window, order);
  const range = windowRange(window, order);
  expect(window.anchor).toBe(order[range.start]);
  const grown = [...order, ...ids(50, 2000)];
  expect(windowRange(window, grown)).toEqual(range);
  // The host dropped the 10 oldest: the same items stay mounted.
  expect(windowRange(window, grown.slice(10))).toEqual({
    start: range.start - 10,
    end: range.end - 10,
  });
  expect(windowRange({ anchor: "gone", size: 50 }, order).start).toBe(0);
});

test("scrolling back down slides to the newest and follows it again", () => {
  const order = ids(1000);
  let window: TranscriptWindow = { anchor: "i100", size: WINDOW_LIMIT };
  let range = windowRange(window, order);
  for (let step = 0; step < 100 && window.anchor !== null; step++) {
    window = newerWindow(window, order);
    const next = windowRange(window, order);
    expect(next.end - next.start).toBeLessThanOrEqual(WINDOW_LIMIT);
    expect(next.start).toBeLessThan(range.end);
    expect(next.end).toBeGreaterThanOrEqual(range.end);
    range = next;
  }
  expect(window.anchor).toBeNull();
  expect(range.end).toBe(1000);
  expect(windowRange(window, [...order, "new"]).end).toBe(1001);
  expect(WINDOW_STEP).toBeLessThan(WINDOW_SIZE);
});
