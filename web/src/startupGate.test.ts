import { afterEach, expect, test } from "bun:test";
import {
  afterStartup,
  noteTerminalAttached,
  noteTerminalOutput,
  resetStartupGateForTests,
  STARTUP_CEILING_MS,
  STARTUP_FALLBACK_MS,
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
