/** What a lazy value is right now; a new object whenever it changes. */
export type LazyValueState<T> = { value: T | null; failed: boolean };

/**
 * A value fetched once, on demand, that components can subscribe to with
 * `useSyncExternalStore(subscribe, read)`. A failed fetch is reported and
 * tried again by the next `load()`.
 */
export function createLazyValue<T>(fetchValue: () => Promise<T>) {
  let state: LazyValueState<T> = { value: null, failed: false };
  let loading = false;
  const listeners = new Set<() => void>();
  const settle = (next: LazyValueState<T>) => {
    loading = false;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    read: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load() {
      if (loading || state.value !== null) return;
      loading = true;
      fetchValue().then(
        (value) => settle({ value, failed: false }),
        () => settle({ value: null, failed: true }),
      );
    },
  };
}
