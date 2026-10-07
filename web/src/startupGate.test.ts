import { afterEach, expect, test } from "bun:test";
import {
  afterStartup,
  afterTerminalFrame,
  holdStartup,
  noteTerminalFrame,
  noteTerminalAttached,
  noteTerminalOutput,
  resetStartupGateForTests,
  STARTUP_CEILING_MS,
  STARTUP_FALLBACK_MS,
  STARTUP_HOLD_MS,
  startupSettled,
} from "./startupGate";

function fakeTimers() {
  const pending = new Map<number, { delay: number; callback: () => void }>();
  let next = 1;
  return {
    timers: {
      setTimeout: ((callback: () => void, delay: number) => {
        pending.set(next, { delay, callback });
        return next++;
      }) as unknown as typeof globalThis.setTimeout,
      clearTimeout: ((handle: number) =>
        void pending.delete(
          handle,
        )) as unknown as typeof globalThis.clearTimeout,
    },
    /** Fire the timers with exactly this delay. */
    fire(delay: number) {
      for (const [handle, timer] of pending) {
        if (timer.delay !== delay) continue;
        pending.delete(handle);
        timer.callback();
      }
    },
    size: () => pending.size,
  };
}

afterEach(resetStartupGateForTests);

test("deferred work waits for the first terminal output", () => {
  const clock = fakeTimers();
  const ran: string[] = [];
  afterStartup(() => ran.push("warmup"), clock.timers);
  expect(ran).toEqual([]);
  noteTerminalOutput();
  expect(ran).toEqual(["warmup"]);
  expect(clock.size()).toBe(0);
  noteTerminalOutput();
  expect(ran).toEqual(["warmup"]);
  // Once settled, new work runs immediately.
  afterStartup(() => ran.push("later"), clock.timers);
  expect(ran).toEqual(["warmup", "later"]);
});

test("the short fallback only starts once a terminal has attached", () => {
  const clock = fakeTimers();
  const ran: string[] = [];
  afterStartup(() => ran.push("a"), clock.timers);
  afterStartup(() => ran.push("b"), clock.timers);
  // A slow link is still downloading the terminal: nothing times out yet.
  clock.fire(STARTUP_FALLBACK_MS);
  expect(ran).toEqual([]);
  noteTerminalAttached(clock.timers);
  clock.fire(STARTUP_FALLBACK_MS);
  expect(ran).toEqual(["a", "b"]);
  expect(startupSettled()).toBe(true);
  expect(clock.size()).toBe(0);
});

test("without any attach, the ceiling releases waiters", () => {
  const clock = fakeTimers();
  const ran: string[] = [];
  afterStartup(() => ran.push("a"), clock.timers);
  clock.fire(STARTUP_CEILING_MS);
  expect(ran).toEqual(["a"]);
});

test("cancelled work never runs", () => {
  const clock = fakeTimers();
  const ran: string[] = [];
  const cancel = afterStartup(() => ran.push("a"), clock.timers);
  cancel();
  noteTerminalOutput();
  expect(ran).toEqual([]);
});

test("the fallbacks wait for a loading engine, up to the hold limit", async () => {
  const clock = fakeTimers();
  const ran: string[] = [];
  let loaded!: () => void;
  holdStartup(new Promise<void>((resolve) => (loaded = resolve)), clock.timers);
  afterStartup(() => ran.push("warmup"), clock.timers);
  noteTerminalAttached(clock.timers);
  clock.fire(STARTUP_FALLBACK_MS);
  await Promise.resolve();
  expect(ran).toEqual([]);
  loaded();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(ran).toEqual(["warmup"]);

  resetStartupGateForTests();
  holdStartup(new Promise(() => {}), clock.timers);
  afterStartup(() => ran.push("capped"), clock.timers);
  clock.fire(STARTUP_CEILING_MS);
  await Promise.resolve();
  expect(ran).toEqual(["warmup"]);
  clock.fire(STARTUP_HOLD_MS);
  expect(ran).toEqual(["warmup", "capped"]);
});

test("frame work runs at the first frame or once startup settles", () => {
  const clock = fakeTimers();
  const ran: string[] = [];
  afterTerminalFrame(() => ran.push("frame"), clock.timers);
  afterStartup(() => ran.push("startup"), clock.timers);
  noteTerminalFrame();
  expect(ran).toEqual(["frame"]);
  noteTerminalOutput();
  expect(ran).toEqual(["frame", "startup"]);

  resetStartupGateForTests();
  afterTerminalFrame(() => ran.push("settled"), clock.timers);
  noteTerminalOutput();
  expect(ran).toEqual(["frame", "startup", "settled"]);
});
