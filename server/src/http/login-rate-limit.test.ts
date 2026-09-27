import { describe, expect, test } from "bun:test";

import { createLoginRateLimiter } from "./login-rate-limit";

function clock(start = 1_000_000) {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("login rate limiter", () => {
  test("blocks after ten failures a minute, doubling each block", () => {
    const time = clock();
    const limiter = createLoginRateLimiter({ now: time.now });
    for (let attempt = 0; attempt < 9; attempt += 1) limiter.failure("a");
    expect(limiter.retryAfterSeconds("a")).toBe(0);
    limiter.failure("a");
    expect(limiter.retryAfterSeconds("a")).toBe(60);
    expect(limiter.retryAfterSeconds("b")).toBe(0);
    time.advance(60_000);
    expect(limiter.retryAfterSeconds("a")).toBe(0);
    for (let attempt = 0; attempt < 10; attempt += 1) limiter.failure("a");
    expect(limiter.retryAfterSeconds("a")).toBe(120);
  });

  test("failures older than the window do not count", () => {
    const time = clock();
    const limiter = createLoginRateLimiter({ now: time.now });
    for (let attempt = 0; attempt < 9; attempt += 1) limiter.failure("a");
    time.advance(61_000);
    limiter.failure("a");
    expect(limiter.retryAfterSeconds("a")).toBe(0);
  });

  test("caps the block and forgets quiet clients", () => {
    const time = clock();
    const limiter = createLoginRateLimiter({ now: time.now });
    for (let block = 0; block < 8; block += 1) {
      for (let attempt = 0; attempt < 10; attempt += 1) limiter.failure("a");
      time.advance(limiter.retryAfterSeconds("a") * 1000);
    }
    for (let attempt = 0; attempt < 10; attempt += 1) limiter.failure("a");
    expect(limiter.retryAfterSeconds("a")).toBe(15 * 60);
    time.advance(31 * 60_000);
    for (let attempt = 0; attempt < 10; attempt += 1) limiter.failure("a");
    expect(limiter.retryAfterSeconds("a")).toBe(60);
  });

  test("success clears the record", () => {
    const limiter = createLoginRateLimiter();
    for (let attempt = 0; attempt < 9; attempt += 1) limiter.failure("a");
    limiter.success("a");
    limiter.failure("a");
    expect(limiter.retryAfterSeconds("a")).toBe(0);
  });
});
