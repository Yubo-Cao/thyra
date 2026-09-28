import { expect, test } from "bun:test";
import {
  idlePrefetchAllowed,
  prefetchWhenIdle,
  richEditorLoadPolicy,
} from "./idlePrefetch";

test("the rich editor prefetches only on fast 4G", () => {
  expect(richEditorLoadPolicy({ effectiveType: "4g", downlink: 10 })).toBe(
    "prefetch",
  );
  expect(richEditorLoadPolicy({ effectiveType: "4g", downlink: 5 })).toBe(
    "prefetch",
  );
  // Slower or unmeasured links wait for the editor's first use.
  expect(richEditorLoadPolicy({ effectiveType: "4g", downlink: 1.5 })).toBe(
    "on-demand",
  );
  expect(richEditorLoadPolicy({ effectiveType: "4g" })).toBe("on-demand");
  expect(richEditorLoadPolicy({ effectiveType: "3g", downlink: 10 })).toBe(
    "on-demand",
  );
  expect(richEditorLoadPolicy(undefined)).toBe("on-demand");
  // Data Saver and 2G keep the plain field.
  expect(
    richEditorLoadPolicy({ saveData: true, effectiveType: "4g", downlink: 50 }),
  ).toBe("never");
  expect(richEditorLoadPolicy({ effectiveType: "2g", downlink: 10 })).toBe(
    "never",
  );
  expect(richEditorLoadPolicy({ effectiveType: "slow-2g" })).toBe("never");
});

test("touch-first devices never load the rich editor", () => {
  expect(
    richEditorLoadPolicy({ effectiveType: "4g", downlink: 50 }, true),
  ).toBe("never");
  expect(richEditorLoadPolicy(undefined, true)).toBe("never");
  expect(
    richEditorLoadPolicy({ effectiveType: "4g", downlink: 50 }, false),
  ).toBe("prefetch");
});

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
