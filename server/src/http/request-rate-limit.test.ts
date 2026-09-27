import { describe, expect, test } from "bun:test";

import { createRequestRateLimiter } from "./request-rate-limit";

describe("request rate limit", () => {
  test("refills evenly and isolates clients", () => {
    let now = 0;
    const limiter = createRequestRateLimiter({
      limit: 3,
      windowMs: 3000,
      now: () => now,
    });
    expect([1, 2, 3].map(() => limiter.take("a"))).toEqual([0, 0, 0]);
    expect(limiter.take("a")).toBe(1);
    expect(limiter.take("b")).toBe(0);
    now = 1000;
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBeGreaterThan(0);
  });

  test("bounds its table", () => {
    const limiter = createRequestRateLimiter({ limit: 1, maxEntries: 2 });
    limiter.take("a");
    limiter.take("b");
    limiter.take("c");
    // "a" was evicted, so it starts with a full bucket again.
    expect(limiter.take("a")).toBe(0);
  });
});
