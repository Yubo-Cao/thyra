/**
 * Per-client limit on failed login attempts (passkey assertions and
 * enrollment secrets). `limit` failures within `windowMs` block the client
 * for `windowMs`, doubling with each further block up to `maxBlockMs`. While
 * blocked, every attempt is refused (including a valid one), so guessing
 * gains nothing. A successful login clears the client's record.
 */

type Entry = {
  failures: number[];
  strikes: number;
  blockedUntil: number;
  lastSeen: number;
};

export type LoginRateLimiter = ReturnType<typeof createLoginRateLimiter>;

export function createLoginRateLimiter(
  options: {
    limit?: number;
    windowMs?: number;
    maxBlockMs?: number;
    maxEntries?: number;
    now?: () => number;
  } = {},
) {
  const limit = options.limit ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const maxBlockMs = options.maxBlockMs ?? 15 * 60_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function prune(at: number) {
    for (const [key, entry] of entries) {
      // Strikes are forgotten once a client has been quiet for a full
      // maximum block, so backoff does not accumulate forever.
      if (entry.blockedUntil <= at && at - entry.lastSeen > maxBlockMs)
        entries.delete(key);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    /** Seconds the client must wait, or 0 when an attempt is allowed. */
    retryAfterSeconds(key: string): number {
      const at = now();
      const entry = entries.get(key);
      if (!entry || entry.blockedUntil <= at) return 0;
      return Math.max(1, Math.ceil((entry.blockedUntil - at) / 1000));
    },

    failure(key: string) {
      const at = now();
      prune(at);
      const entry = entries.get(key) ?? {
        failures: [],
        strikes: 0,
        blockedUntil: 0,
        lastSeen: at,
      };
      entries.delete(key);
      entries.set(key, entry);
      entry.lastSeen = at;
      entry.failures = entry.failures.filter((time) => at - time < windowMs);
      entry.failures.push(at);
      if (entry.failures.length >= limit) {
        entry.strikes += 1;
        entry.failures = [];
        entry.blockedUntil =
          at + Math.min(maxBlockMs, windowMs * 2 ** (entry.strikes - 1));
      }
    },

    success(key: string) {
      entries.delete(key);
    },
  };
}

export function tooManyAttemptsResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "too many login attempts; try again later" },
    {
      status: 429,
      headers: {
        "retry-after": String(retryAfterSeconds),
        "cache-control": "no-store",
      },
    },
  );
}
