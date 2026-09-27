import { expect, test } from "bun:test";
import { idlePrefetchAllowed, prefetchWhenIdle } from "./idlePrefetch";

function idleTarget() {
  const callbacks: (() => void)[] = [];
  return {
    callbacks,
    target: {
      setTimeout: (() => 0) as unknown as Window["setTimeout"],
      clearTimeout: () => {},
      requestIdleCallback: (callback: () => void) =>
        callbacks.push(callback) - 1,
      cancelIdleCallback: (handle: number) => {
        callbacks[handle] = () => {};
      },
    },
    async runNext() {
      callbacks.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

test("prefetch respects Data Saver and 2G-class links", () => {
  expect(idlePrefetchAllowed(undefined)).toBe(true);
  expect(idlePrefetchAllowed({ effectiveType: "4g" })).toBe(true);
  expect(idlePrefetchAllowed({ effectiveType: "3g" })).toBe(true);
  expect(idlePrefetchAllowed({ effectiveType: "2g" })).toBe(false);
  expect(idlePrefetchAllowed({ effectiveType: "slow-2g" })).toBe(false);
  expect(idlePrefetchAllowed({ saveData: true, effectiveType: "4g" })).toBe(
    false,
  );
});

test("loaders run one per idle period, in order, and survive failures", async () => {
  const idle = idleTarget();
  const loaded: string[] = [];
  prefetchWhenIdle(
    [
      async () => void loaded.push("a"),
      () => Promise.reject(new Error("offline")),
      async () => void loaded.push("c"),
    ],
    idle.target,
    () => true,
  );
  await idle.runNext();
  expect(loaded).toEqual(["a"]);
  await idle.runNext();
  await idle.runNext();
  expect(loaded).toEqual(["a", "c"]);
});

test("cancel and a disallowed link stop the remaining loaders", async () => {
  const idle = idleTarget();
  const loaded: string[] = [];
  const cancel = prefetchWhenIdle(
    [async () => void loaded.push("a"), async () => void loaded.push("b")],
    idle.target,
    () => true,
  );
  await idle.runNext();
  cancel();
  await idle.runNext();
  expect(loaded).toEqual(["a"]);

  const saver = idleTarget();
  prefetchWhenIdle(
    [async () => void loaded.push("x")],
    saver.target,
    () => false,
  );
  await saver.runNext();
  expect(loaded).toEqual(["a"]);
});
