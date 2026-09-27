import { describe, expect, test } from "bun:test";

import { createAuthHandlers } from "./auth";
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

describe("login endpoint rate limit", () => {
  const login = (
    handlers: ReturnType<typeof createAuthHandlers>,
    password: string,
    clientKey: string,
  ) =>
    handlers.handleLogin(
      new Request("http://localhost/api/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
      { clientKey },
    );

  test("refuses even the right password while a client is blocked", async () => {
    const handlers = createAuthHandlers({
      authRequired: false,
      password: "right",
      loginLimiter: createLoginRateLimiter(),
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await login(handlers, "wrong", "100.64.0.1")).status).toBe(401);
    }
    const blocked = await login(handlers, "right", "100.64.0.1");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(blocked.headers.get("set-cookie")).toBeNull();
    // Another client is unaffected.
    expect((await login(handlers, "right", "100.64.0.2")).status).toBe(200);
  });

  test("counts failed URL tokens and ignores them on API paths", () => {
    const limiter = createLoginRateLimiter();
    const handlers = createAuthHandlers({
      authRequired: true,
      password: "right",
      urlLoginToken: "right",
      loginLimiter: limiter,
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = handlers.handleTokenLogin(
        new Request("http://localhost/?token=wrong"),
        { clientKey: "c" },
      );
      expect(response?.status).toBe(303);
    }
    expect(
      handlers.handleTokenLogin(new Request("http://localhost/?token=right"), {
        clientKey: "c",
      })?.status,
    ).toBe(429);
    expect(
      handlers.handleTokenLogin(
        new Request("http://localhost/api/health?token=right"),
      ),
    ).toBeNull();
    expect(
      handlers.handleTokenLogin(new Request("http://localhost/ws?token=right")),
    ).toBeNull();
    expect(
      handlers.handleTokenLogin(
        new Request("http://localhost/?token=right", {
          headers: { "sec-fetch-dest": "image" },
        }),
      ),
    ).toBeNull();
  });
});
