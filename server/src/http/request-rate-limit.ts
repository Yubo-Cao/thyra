/**
 * Per-client token bucket for the public listener: `limit` requests, refilled
 * evenly over `windowMs`. Keys are client addresses (`CF-Connecting-IP` from
 * a trusted cloudflared). The table is bounded; the least recently used
 * clients are forgotten first.
 */

type Bucket = { tokens: number; updatedAt: number };

export type RequestRateLimiter = ReturnType<typeof createRequestRateLimiter>;

export function createRequestRateLimiter(
  options: {
    limit?: number;
    windowMs?: number;
    maxEntries?: number;
    now?: () => number;
  } = {},
) {
  const limit = options.limit ?? 300;
  const windowMs = options.windowMs ?? 60_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? Date.now;
  const perMs = limit / windowMs;
  const buckets = new Map<string, Bucket>();

  return {
    /** Spend one request; seconds to wait when none is left, else 0. */
    take(key: string): number {
      const at = now();
      const previous = buckets.get(key);
      const bucket: Bucket = previous
        ? {
            tokens: Math.min(
              limit,
              previous.tokens + (at - previous.updatedAt) * perMs,
            ),
            updatedAt: at,
          }
        : { tokens: limit, updatedAt: at };
      // Re-insert so iteration order is least recently used first.
      buckets.delete(key);
      buckets.set(key, bucket);
      while (buckets.size > maxEntries) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return 0;
      }
      return Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000));
    },
  };
}

export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return new Response("too many requests", {
    status: 429,
    headers: {
      "retry-after": String(retryAfterSeconds),
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
