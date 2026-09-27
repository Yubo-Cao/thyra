import { afterEach, expect, test } from "bun:test";
import {
  afterStartup,
  noteTerminalOutput,
  resetStartupGateForTests,
  startupSettled,
} from "./startupGate";

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    timers: {
      setTimeout: ((callback: () => void) => {
        pending.set(next, callback);
        return next++;
      }) as unknown as typeof globalThis.setTimeout,
      clearTimeout: ((handle: number) =>
        void pending.delete(
          handle,
        )) as unknown as typeof globalThis.clearTimeout,
    },
    fireAll() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    size: () => pending.size,
  };
}

afterEach(resetStartupGateForTests);

test("deferred work waits for the first terminal output", () => {
  const clock = fakeTimers();
  const ran: string[] = [];
  afterStartup(() => ran.push("warmup"), 4000, clock.timers);
  expect(ran).toEqual([]);
  noteTerminalOutput();
  expect(ran).toEqual(["warmup"]);
  expect(clock.size()).toBe(0);
  noteTerminalOutput();
  expect(ran).toEqual(["warmup"]);
  // Once settled, new work runs immediately.
  afterStartup(() => ran.push("later"), 4000, clock.timers);
  expect(ran).toEqual(["warmup", "later"]);
});

test("without output, the fallback releases every waiter once", () => {
  const clock = fakeTimers();
  const ran: string[] = [];
  afterStartup(() => ran.push("a"), 4000, clock.timers);
  afterStartup(() => ran.push("b"), 4000, clock.timers);
  clock.fireAll();
  expect(ran).toEqual(["a", "b"]);
  expect(startupSettled()).toBe(true);
});

test("cancelled work never runs", () => {
  const clock = fakeTimers();
  const ran: string[] = [];
  const cancel = afterStartup(() => ran.push("a"), 4000, clock.timers);
  cancel();
  expect(clock.size()).toBe(0);
  noteTerminalOutput();
  expect(ran).toEqual([]);
});
