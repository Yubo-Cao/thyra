import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PANE_SWIPE_OPTIONS,
  paneSwipeReversed,
  setPaneSwipeFingers,
  setPaneSwipeReversed,
} from "../../paneSwipeSettings";
import { paneSwipeFingers, PinchTracker } from "../../touchGestures";
import type { Pane } from "../../types";
import {
  adjacentPane,
  classifySwipe,
  paneNavigationOrder,
  revealedEdge,
  SwipeChain,
  swipeCommits,
  swipeOffset,
  swipeProgress,
  swipeStep,
  SwipeTracker,
  SwipeVelocity,
} from "./paneSwipeMotion";

const WIDTH = 400;
const noRoom = () => 0;

const at = (identifier: number, clientX: number, clientY: number) => ({
  identifier,
  clientX,
  clientY,
});
/** Two fingers 100px apart horizontally, moved by (dx, dy), `spread` wider. */
const pair = (dx = 0, dy = 0, spread = 0) => [
  at(0, 150 + dx - spread / 2, 200 + dy),
  at(1, 250 + dx + spread / 2, 200 + dy),
];
/** `count` fingers 20px apart vertically, all shifted by (dx, dy). */
const fingers = (count: number, dx = 0, dy = 0) =>
  Array.from({ length: count }, (_, i) => at(i, 200 + dx, 100 + i * 20 + dy));

/** Drives a tracker through `steps` moves to the final position. */
function track(
  start: ReturnType<typeof pair>,
  moves: ReturnType<typeof pair>[],
  room: (direction: -1 | 1) => number = noRoom,
) {
  const tracker = new SwipeTracker();
  tracker.begin(start);
  let mode = tracker.mode;
  for (const move of moves) mode = tracker.move(move, room);
  return { mode, tracker };
}

describe("two-finger classification", () => {
  test("a horizontal drag at a constant distance is a swipe past 16px", () => {
    expect(track(pair(), [pair(10, 1)]).mode).toBe("pending");
    const { mode, tracker } = track(pair(), [pair(10, 1), pair(-18, 3)]);
    expect(mode).toBe("swipe");
    expect(tracker.delta().dx).toBe(-18);
  });

  test("a changing distance is a pinch, even while it moves sideways", () => {
    expect(track(pair(), [pair(8, 0, 20)]).mode).toBe("pinch");
    expect(track(pair(), [pair(0, 0, -16)]).mode).toBe("pinch");
    // Spread short of a pinch still rules out a swipe.
    expect(track(pair(), [pair(20, 0, 12)]).mode).toBe("pan");
  });

  test("vertical or diagonal travel scrolls", () => {
    expect(track(pair(), [pair(2, 30)]).mode).toBe("pan");
    expect(track(pair(), [pair(-20, 30)]).mode).toBe("pan");
    // Two fingers need twice as much horizontal as vertical travel.
    expect(track(pair(), [pair(30, 16)]).mode).toBe("pan");
    expect(track(pair(), [pair(34, 16)]).mode).toBe("swipe");
  });

  test("the classification locks for the rest of the gesture", () => {
    const scroll = track(pair(), [pair(0, 20), pair(200, 20)]);
    expect(scroll.mode).toBe("pan");
    const swipe = track(pair(), [pair(20, 0), pair(20, 200, 60)]);
    expect(swipe.mode).toBe("swipe");
    const pinch = track(pair(), [pair(0, 0, 30), pair(200, 0, 30)]);
    expect(pinch.mode).toBe("pinch");
  });

  test("agrees with the terminal's pinch tracker on everything else", () => {
    const moves: [number, number, number][] = [
      [0, 20, 0],
      [5, 5, 18],
      [20, 0, 12],
      [-12, 14, 4],
      [3, -17, -2],
      [25, 25, 0],
    ];
    for (const [dx, dy, spread] of moves) {
      const pinch = new PinchTracker();
      pinch.begin(pair());
      const expected = pinch.move(pair(dx, dy, spread))?.mode;
      expect(expected).toBeDefined();
      expect(track(pair(), [pair(dx, dy, spread)]).mode as string).toBe(
        expected as string,
      );
    }
  });

  test("a zoomed view pans until it reaches the edge, then swipes", () => {
    // Content can still move right (its left part is off screen)...
    const room = (direction: -1 | 1) => (direction > 0 ? 120 : 0);
    expect(track(pair(), [pair(30, 0)], room).mode).toBe("pan");
    // ...but is already at its right edge, so a leftward drag swipes.
    expect(track(pair(), [pair(-30, 0)], room).mode).toBe("swipe");
    // Less than a pixel is rounding, not room.
    expect(track(pair(), [pair(30, 0)], () => 0.4).mode).toBe("swipe");
    expect(classifySwipe(2, 30, 0, 0, () => 1)).toBe("pan");
  });

  test("three or four fingers swipe without pinch or pan checks", () => {
    const tracker = new SwipeTracker();
    tracker.begin(fingers(3));
    expect(tracker.move(fingers(3, 20, 12))).toBe("swipe");
    tracker.begin(fingers(4));
    expect(tracker.move(fingers(4, 20, 14))).toBe("pan");
  });

  test("a finished or cancelled tracker ignores moves until it begins", () => {
    const tracker = new SwipeTracker();
    expect(tracker.move(pair(40))).toBe("idle");
    tracker.begin(pair());
    tracker.finish();
    expect(tracker.move(pair(40))).toBe("done");
    tracker.cancel();
    expect(tracker.move(pair(40))).toBe("idle");
    tracker.begin(pair());
    expect(tracker.move(pair(40))).toBe("swipe");
  });
});

describe("pane swipe direction", () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    stored = new Map();
    globalThis.localStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    } as Storage;
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  test("dragging right reveals the previous pane on the left", () => {
    expect(swipeStep(1)).toBe(-1);
    expect(swipeStep(-1)).toBe(1);
    expect(revealedEdge(1)).toBe("left");
    expect(revealedEdge(-1)).toBe("right");
  });

  test("the reverse toggle makes dragging right move to the next pane", () => {
    expect(paneSwipeReversed()).toBe(false);
    setPaneSwipeReversed(true);
    expect(paneSwipeReversed()).toBe(true);
    expect(swipeStep(1, paneSwipeReversed())).toBe(1);
    expect(swipeStep(-1, paneSwipeReversed())).toBe(-1);
    // The icon still sits on the side the drag uncovers.
    expect(revealedEdge(1)).toBe("left");
    setPaneSwipeReversed(false);
    expect(paneSwipeReversed()).toBe(false);
  });

  test("two fingers by default; off, three and four when chosen", () => {
    expect(paneSwipeFingers()).toBe(2);
    expect(PANE_SWIPE_OPTIONS.map((option) => option.value)).toEqual([
      "2",
      "3",
      "4",
      "0",
    ]);
    for (const fingers of [0, 3, 4, 2] as const) {
      setPaneSwipeFingers(fingers);
      expect(paneSwipeFingers()).toBe(fingers);
    }
    stored.set("thyra:paneSwipeFingers", "7");
    expect(paneSwipeFingers()).toBe(2);
  });
});

describe("pane swipe drag", () => {
  test("follows 1:1 up to the width while a pane is there", () => {
    expect(swipeOffset(100, WIDTH, true)).toBe(100);
    expect(swipeOffset(-260, WIDTH, true)).toBe(-260);
    expect(swipeOffset(900, WIDTH, true)).toBe(WIDTH);
  });

  test("resists at once with nothing to reveal", () => {
    const pull = swipeOffset(-100, WIDTH, false);
    expect(pull).toBeLessThan(0);
    expect(Math.abs(pull)).toBeLessThan(100);
    expect(swipeOffset(4000, WIDTH, false)).toBeLessThan(WIDTH * 0.35);
  });

  test("speed comes from the last 100 ms of travel", () => {
    const velocity = new SwipeVelocity();
    // A slow drag for 300 ms, then a fast 100 ms finish.
    for (let time = 0; time <= 300; time += 20) velocity.add(time, time * 0.1);
    for (let time = 320; time <= 400; time += 20)
      velocity.add(time, 30 + (time - 300));
    expect(velocity.at(400)).toBeCloseTo(1, 5);
    // Fingers that rested before lifting read as still.
    expect(velocity.at(600)).toBe(0);
    expect(new SwipeVelocity().at(0)).toBe(0);
  });
});

describe("pane swipe release", () => {
  test("switches with more than half the width revealed", () => {
    expect(swipeCommits(0.6, 0)).toBe(true);
    expect(swipeCommits(0.51, -2)).toBe(true);
    expect(swipeCommits(0.5, 0)).toBe(false);
    expect(swipeCommits(0.4, 0.5)).toBe(false);
  });

  test("a fast flick switches from a quarter of the width", () => {
    expect(swipeCommits(0.25, 0.8)).toBe(true);
    expect(swipeCommits(0.3, 1.5)).toBe(true);
    expect(swipeCommits(0.24, 3)).toBe(false);
    expect(swipeCommits(0.4, 0.79)).toBe(false);
    // A flick back toward the pane does not count.
    expect(swipeCommits(0.4, -1)).toBe(false);
  });

  test("the icon arms exactly when a release would switch", () => {
    // A drag frame by frame: fast to 120px, a rest, then on past half.
    const velocity = new SwipeVelocity();
    const frames: [number, number][] = [
      [0, 0],
      [16, 30],
      [32, 70],
      [48, 120],
      [64, 110],
      [200, 110],
      [216, 150],
      [232, 210],
      [248, 205],
    ];
    const armed = frames.map(([time, dx]) => {
      velocity.add(time, dx);
      const frame = swipeProgress(dx, WIDTH, true, velocity.at(time));
      // The armed state is the release rule for what the frame shows.
      expect(frame.armed).toBe(
        swipeCommits(frame.revealed, velocity.at(time) * Math.sign(dx)),
      );
      return frame.armed;
    });
    // Armed by the flick past a quarter, disarmed once the fingers rest,
    // armed by the next flick and then past half the width.
    expect(armed).toEqual([
      false,
      false,
      false,
      true,
      true,
      false,
      true,
      true,
      true,
    ]);
    // Leftward drags arm on leftward speed; nothing to reveal never arms.
    expect(swipeProgress(-220, WIDTH, true, 0).armed).toBe(true);
    expect(swipeProgress(-120, WIDTH, true, -1).armed).toBe(true);
    expect(swipeProgress(-120, WIDTH, true, 1).armed).toBe(false);
    expect(swipeProgress(-300, WIDTH, false, -2).armed).toBe(false);
  });
});

describe("pane swipe chain", () => {
  test("switches after the animation settles and the fingers lift", () => {
    const chain = new SwipeChain();
    expect(chain.from("a")).toBe("a");
    chain.touching = true;
    chain.commit("b");
    chain.animating = true;
    expect(chain.due()).toBeNull();
    chain.touching = false;
    expect(chain.due()).toBeNull();
    chain.animating = false;
    expect(chain.revealable("a")).toBe(false);
    expect(chain.due()).toBe("b");
    expect(chain.due()).toBeNull();
    // The card stays until the switch is on screen.
    expect(chain.revealable("a")).toBe(false);
    expect(chain.revealable("b")).toBe(true);
    chain.revealed();
    expect(chain.from("b")).toBe("b");
  });

  test("a swipe during the settle starts from its destination", () => {
    const chain = new SwipeChain();
    chain.commit("b");
    chain.animating = true;
    chain.touching = true; // the second swipe lands
    chain.animating = false; // and jumps the first animation to its end
    expect(chain.from("a")).toBe("b");
    expect(chain.due()).toBeNull();
    chain.commit("c");
    chain.animating = true;
    chain.touching = false;
    chain.animating = false;
    // Only the last destination is switched to.
    expect(chain.due()).toBe("c");
    expect(chain.due()).toBeNull();
  });

  test("a cancelled second swipe keeps the first destination", () => {
    const chain = new SwipeChain();
    chain.commit("b");
    chain.touching = true;
    expect(chain.due()).toBeNull();
    chain.touching = false; // sprang back
    expect(chain.due()).toBe("b");
    // A swipe while the switch is in flight also starts from it.
    expect(chain.from("a")).toBe("b");
    chain.touching = true;
    expect(chain.revealable("b")).toBe(false);
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

  test("dragging right from p1 reveals p4 on the left; left reveals p2", () => {
    expect(adjacentPane(order, "p1", swipeStep(1))?.pane_id).toBe("p4");
    expect(adjacentPane(order, "p1", swipeStep(-1))?.pane_id).toBe("p2");
    expect(adjacentPane(order, "p1", swipeStep(1, true))?.pane_id).toBe("p2");
  });
});
