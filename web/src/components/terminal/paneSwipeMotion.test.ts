import { describe, expect, test } from "bun:test";
import {
  rubberBand,
  SwipeChain,
  swipeRecognition,
  swipeRelease,
  SwipeVelocity,
} from "./paneSwipeMotion";

const WIDTH = 400;

describe("pane swipe drag", () => {
  test("starts once horizontal travel passes the slop", () => {
    expect(swipeRecognition(10, 2)).toBe("pending");
    expect(swipeRecognition(-18, 6)).toBe("track");
    expect(swipeRecognition(12, 20)).toBe("reject");
  });

  test("follows 1:1, then resists past 40% of the width", () => {
    expect(rubberBand(100, WIDTH)).toBe(100);
    expect(rubberBand(-160, WIDTH)).toBe(-160);
    const far = rubberBand(360, WIDTH);
    expect(far).toBeGreaterThan(160);
    expect(far).toBeLessThan(360);
    expect(rubberBand(4000, WIDTH)).toBeLessThan(WIDTH * 0.75);
    // With nothing to swipe to, resistance starts at once.
    expect(Math.abs(rubberBand(-100, WIDTH, 0))).toBeLessThan(100);
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
  test("commits past 30% of the width, in the fingers' direction", () => {
    expect(swipeRelease(130, 10, WIDTH, 0)).toBe(1);
    expect(swipeRelease(-130, 10, WIDTH, 0)).toBe(-1);
    expect(swipeRelease(110, 0, WIDTH, 0.1)).toBe(0);
  });

  test("a flick commits a short swipe; a flick back cancels a long one", () => {
    expect(swipeRelease(40, 0, WIDTH, 0.8)).toBe(1);
    expect(swipeRelease(-40, 0, WIDTH, -0.5)).toBe(-1);
    expect(swipeRelease(40, 0, WIDTH, -0.8)).toBe(0);
    expect(swipeRelease(200, 0, WIDTH, -0.6)).toBe(0);
  });

  test("a release that turned vertical cancels", () => {
    expect(swipeRelease(200, 180, WIDTH, 1)).toBe(0);
    expect(swipeRelease(0, 0, WIDTH, 1)).toBe(0);
    expect(swipeRelease(200, 0, 0, 1)).toBe(0);
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
