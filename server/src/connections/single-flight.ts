/**
 * Shares one in-flight call among concurrent callers. A caller arriving after
 * it settles starts a fresh call, so results are never cached.
 */
export function singleFlight<T>(task: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const started = task().finally(() => {
      if (inFlight === started) inFlight = null;
    });
    inFlight = started;
    return started;
  };
}
