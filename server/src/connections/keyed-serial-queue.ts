/**
 * Runs tasks that share a key strictly one after another, in the order they
 * were submitted. Tasks under different keys do not wait for each other, and a
 * key with nothing queued starts its task immediately.
 */
export function createKeyedSerialQueue() {
  const tails = new Map<string, Promise<void>>();
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(key);
      const result = previous ? previous.then(task) : task();
      // A failed task must not stall or fail the ones queued behind it.
      const tail = result.then(
        () => {},
        () => {},
      );
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
    get size() {
      return tails.size;
    },
  };
}
