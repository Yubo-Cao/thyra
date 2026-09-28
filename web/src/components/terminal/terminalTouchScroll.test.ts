import { describe, expect, test } from "bun:test";
import { SwipeTracker } from "./paneSwipeMotion";
import {
  type Frames,
  TOUCH_SCROLL_LINE_PX,
  touchPoint,
  TouchScroll,
  TwoFingerTouch,
} from "./terminalTouchScroll";

const LINE = TOUCH_SCROLL_LINE_PX;

const at = (identifier: number, clientX: number, clientY: number) => ({
  identifier,
  clientX,
  clientY,
});
/** Two fingers 100px apart around (x, y), `spread` further apart. */
const pair = (x: number, y: number, spread = 0) => [
  at(0, x - 50 - spread / 2, y),
  at(1, x + 50 + spread / 2, y),
];

/** Animation frames that run only when the test steps them. */
function manualFrames() {
  let next = 1;
  const queued = new Map<number, (time: number) => void>();
  const frames: Frames = {
    request(callback) {
      queued.set(next, callback);
      return next++;
    },
    cancel(id) {
      queued.delete(id);
    },
  };
  return {
    frames,
    get pending() {
      return queued.size;
    },
    /** Runs frames every 16 ms from `from` until none is requested. */
    runFrom(from: number, limit = 10_000) {
      let time = from;
      for (let count = 0; queued.size && count < limit; count++) {
        time += 16;
        const callbacks = [...queued.values()];
        queued.clear();
        for (const callback of callbacks) callback(time);
      }
      return time;
    },
  };
}

function recorder() {
  const calls: { lines: number; at: { x: number; y: number } }[] = [];
  const clock = manualFrames();
  const scroll = new TouchScroll(
    (lines, point) => calls.push({ lines, at: point }),
    clock.frames,
  );
  const total = () => calls.reduce((sum, call) => sum + call.lines, 0);
  return { calls, clock, scroll, total };
}

/** Drags one finger from y0 to y1 in `steps` moves 16 ms apart. */
function dragOne(scroll: TouchScroll, y0: number, y1: number, steps = 10) {
  scroll.begin(y0, { x: 100, y: y0 }, 0);
  let time = 0;
  for (let step = 1; step <= steps; step++) {
    time = step * 16;
    const y = y0 + ((y1 - y0) * step) / steps;
    scroll.move(y, { x: 100, y }, time);
  }
  return time;
}

/** The same drag with two fingers through the pinch tracker. */
function dragTwo(two: TwoFingerTouch, y0: number, y1: number, steps = 10) {
  two.begin(pair(200, y0), 0);
  let time = 0;
  for (let step = 1; step <= steps; step++) {
    time = step * 16;
    two.move(pair(200, y0 + ((y1 - y0) * step) / steps), time);
  }
  return time;
}

describe("touch scroll driver", () => {
  test("one finger scrolls a line per 24px, down as it moves up", () => {
    const { scroll, calls, total } = recorder();
    dragOne(scroll, 400, 400 - LINE * 5);
    expect(total()).toBe(5);
    expect(calls.every((call) => call.lines > 0)).toBe(true);
    // Partial lines carry over instead of being lost.
    const down = recorder();
    dragOne(down.scroll, 100, 100 + LINE * 3 + 10, 7);
    expect(down.total()).toBe(-3);
  });

  test("two fingers' midpoint scrolls exactly like one finger", () => {
    const one = recorder();
    dragOne(one.scroll, 400, 130, 9);
    const two = recorder();
    dragTwo(new TwoFingerTouch(two.scroll), 400, 130, 9);
    expect(two.calls.map((call) => call.lines)).toEqual(
      one.calls.map((call) => call.lines),
    );
    expect(two.total()).toBe(Math.trunc(270 / LINE));
    // Two fingers report the scroll at their midpoint.
    expect(two.calls[0].at.x).toBe(200);
    expect(touchPoint(pair(200, 300))).toEqual({ x: 200, y: 300 });
    expect(touchPoint([at(0, 10, 20)])).toEqual({ x: 10, y: 20 });
  });

  test("a finished touch does not scroll on", () => {
    const { scroll, total } = recorder();
    dragOne(scroll, 400, 300);
    scroll.stop();
    const before = total();
    scroll.move(0, { x: 0, y: 0 }, 400);
    expect(total()).toBe(before);
    expect(scroll.tracking).toBe(false);
  });
});

describe("two-finger classification", () => {
  /**
   * Runs moves the way the page delivers them: the pane swipe on the surface
   * sees each move first and, once it claims a swipe, the terminal never does.
   */
  function gesture(moves: ReturnType<typeof pair>[], swipeFingers = 2) {
    const { scroll, calls, total } = recorder();
    const two = new TwoFingerTouch(scroll);
    const swipe = new SwipeTracker();
    const start = pair(200, 300);
    if (swipeFingers === 2) swipe.begin(start);
    two.begin(start, 0);
    moves.forEach((points, index) => {
      if (swipe.move(points) === "swipe") return;
      two.move(points, (index + 1) * 16);
    });
    return { calls, total, two, swipe };
  }
  const path = (dx: number, dy: number, spread = 0, steps = 10) =>
    Array.from({ length: steps }, (_, index) => {
      const k = (index + 1) / steps;
      return pair(200 + dx * k, 300 + dy * k, spread * k);
    });

  test("a vertical two-finger move scrolls", () => {
    const up = gesture(path(0, -200));
    expect(up.two.mode).toBe("pan");
    expect(up.total()).toBe(Math.trunc(200 / LINE));
    const down = gesture(path(4, 150));
    expect(down.total()).toBe(-Math.trunc(150 / LINE));
  });

  test("a pinch never scrolls", () => {
    // Spreading while drifting down: the spread decides first.
    const pinch = gesture(path(0, 120, 200));
    expect(pinch.two.mode).toBe("pinch");
    expect(pinch.calls).toEqual([]);
    const narrow = gesture(path(0, -60, -80));
    expect(narrow.two.mode).toBe("pinch");
    expect(narrow.calls).toEqual([]);
  });

  test("a horizontal swipe never scrolls", () => {
    const swipe = gesture(path(-240, 30));
    expect(swipe.swipe.mode).toBe("swipe");
    expect(swipe.two.mode).toBe("pending");
    expect(swipe.calls).toEqual([]);
  });

  test("without the swipe a sideways pan scrolls only its vertical part", () => {
    const pan = gesture(path(-240, -60), 3);
    expect(pan.two.mode).toBe("pan");
    expect(pan.total()).toBe(Math.trunc(60 / LINE));
  });

  test("a magnified view pans to its edge, then scrolls", () => {
    const { scroll, total } = recorder();
    const two = new TwoFingerTouch(scroll);
    // The view can move down 50px before its top edge shows.
    let viewY = -50;
    const panned: number[] = [];
    two.begin(pair(200, 300), 0);
    for (let step = 1; step <= 10; step++) {
      two.move(pair(200, 300 + step * 20), step * 16, (move) => {
        viewY = Math.min(0, -50 + move.dy);
        panned.push(viewY);
        return viewY + 50;
      });
      // Until the edge, the view takes the whole move.
      if (step <= 2) expect(total()).toBe(0);
    }
    expect(panned[panned.length - 1]).toBe(0);
    // 200px of travel: 50 panned the view, 150 scrolled back through history.
    expect(total()).toBe(-Math.trunc(150 / LINE));
  });
});

describe("touch scroll inertia", () => {
  test("a fast release keeps scrolling, slowing to a stop", () => {
    const { scroll, clock, calls, total } = recorder();
    // 240px up in 80ms: 3px/ms.
    const end = dragOne(scroll, 500, 260, 5);
    expect(total()).toBe(10);
    scroll.release(end);
    expect(scroll.flinging).toBe(true);
    const stoppedAt = clock.runFrom(end);
    expect(scroll.flinging).toBe(false);
    expect(total()).toBeGreaterThan(20);
    // A fling keeps the drag's direction.
    const flung = calls.slice(10).map((call) => call.lines);
    expect(flung.every((lines) => lines > 0)).toBe(true);
    expect(stoppedAt - end).toBeGreaterThan(500);
    expect(stoppedAt - end).toBeLessThan(3000);
  });

  test("two fingers fling the same way", () => {
    const one = recorder();
    one.scroll.release(dragOne(one.scroll, 500, 260, 5));
    one.clock.runFrom(80);
    const two = recorder();
    const fingers = new TwoFingerTouch(two.scroll);
    fingers.end(true, dragTwo(fingers, 500, 260, 5));
    two.clock.runFrom(80);
    expect(two.total()).toBe(one.total());
  });

  test("a slow or rested release, a tap or a new touch stops", () => {
    const slow = recorder();
    // 0.1px/ms, under FLING_MIN_SPEED.
    const end = dragOne(slow.scroll, 300, 284, 10);
    slow.scroll.release(end);
    expect(slow.scroll.flinging).toBe(false);

    const rested = recorder();
    rested.scroll.release(dragOne(rested.scroll, 500, 260, 5) + 300);
    expect(rested.scroll.flinging).toBe(false);

    const caught = recorder();
    caught.scroll.release(dragOne(caught.scroll, 500, 260, 5));
    caught.clock.runFrom(80, 3);
    const before = caught.total();
    caught.scroll.begin(200, { x: 0, y: 200 }, 200);
    expect(caught.scroll.flinging).toBe(false);
    expect(caught.clock.pending).toBe(0);
    expect(caught.total()).toBe(before);
  });

  test("a pinch or a cancelled pan does not fling", () => {
    const pinch = recorder();
    const fingers = new TwoFingerTouch(pinch.scroll);
    fingers.begin(pair(200, 300), 0);
    for (let step = 1; step <= 5; step++)
      fingers.move(pair(200, 300 - step * 40, step * 40), step * 16);
    fingers.end(true, 80);
    expect(pinch.scroll.flinging).toBe(false);
    expect(pinch.calls).toEqual([]);

    const cancelled = recorder();
    const pan = new TwoFingerTouch(cancelled.scroll);
    pan.end(false, dragTwo(pan, 500, 260, 5));
    expect(cancelled.scroll.flinging).toBe(false);
  });
});
