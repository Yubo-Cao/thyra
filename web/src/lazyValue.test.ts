import { describe, expect, test } from "bun:test";
import { createLazyValue } from "./lazyValue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("a lazy value", () => {
  test("is fetched once, on demand, and announced to subscribers", async () => {
    const pending = deferred<string>();
    let fetches = 0;
    const lazy = createLazyValue(() => {
      fetches += 1;
      return pending.promise;
    });
    let changes = 0;
    const unsubscribe = lazy.subscribe(() => (changes += 1));
    const initial = lazy.read();
    expect(initial).toEqual({ value: null, failed: false });
    expect(fetches).toBe(0);

    lazy.load();
    lazy.load();
    expect(fetches).toBe(1);
    expect(lazy.read()).toBe(initial);

    pending.resolve("icons");
    await pending.promise;
    await Promise.resolve();
    expect(lazy.read()).toEqual({ value: "icons", failed: false });
    expect(changes).toBe(1);

    lazy.load();
    expect(fetches).toBe(1);
    unsubscribe();
  });

  test("reports a failed fetch and tries again when asked", async () => {
    const attempts = [deferred<string>(), deferred<string>()];
    let fetches = 0;
    const lazy = createLazyValue(() => attempts[fetches++]!.promise);
    let changes = 0;
    lazy.subscribe(() => (changes += 1));

    lazy.load();
    attempts[0]!.reject(new Error("offline"));
    await attempts[0]!.promise.catch(() => {});
    await Promise.resolve();
    expect(lazy.read()).toEqual({ value: null, failed: true });
    expect(changes).toBe(1);

    lazy.load();
    expect(fetches).toBe(2);
    attempts[1]!.resolve("icons");
    await attempts[1]!.promise;
    await Promise.resolve();
    expect(lazy.read()).toEqual({ value: "icons", failed: false });
    expect(changes).toBe(2);
  });
});
