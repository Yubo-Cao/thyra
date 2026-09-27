/** Token-bucket limiter keyed by caller (MCP token id or client address). */
export function createRateLimiter(args: {
  perMinute: number;
  burst?: number;
  now?: () => number;
  maxKeys?: number;
}) {
  const capacity = Math.max(1, Math.floor(args.burst ?? args.perMinute));
  const refillPerMs = Math.max(args.perMinute, 1) / 60_000;
  const now = args.now ?? Date.now;
  const maxKeys = args.maxKeys ?? 4096;
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();

  return {
    /** Consume one request. Returns 0 when allowed, else seconds to wait. */
    take(key: string): number {
      const time = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= maxKeys) {
          // Forget the oldest caller rather than growing without bound.
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
        bucket = { tokens: capacity, updatedAt: time };
        buckets.set(key, bucket);
      }
      bucket.tokens = Math.min(
        capacity,
        bucket.tokens + (time - bucket.updatedAt) * refillPerMs,
      );
      bucket.updatedAt = time;
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return 0;
      }
      return Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000));
    },
  };
}
