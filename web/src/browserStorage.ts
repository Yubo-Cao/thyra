const PREFIX = "thyra:";

/** Scope a Storage to `thyra:` keys so other apps on the origin stay separate. */
export function thyraStorage(storage: Storage): Storage {
  const keys = () =>
    Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key?.startsWith(PREFIX) ?? false)
      .map((key) => key.slice(PREFIX.length));
  return {
    get length() {
      return keys().length;
    },
    key(index) {
      return keys()[index] ?? null;
    },
    getItem(key) {
      return storage.getItem(PREFIX + key);
    },
    setItem(key, value) {
      storage.setItem(PREFIX + key, value);
    },
    removeItem(key) {
      storage.removeItem(PREFIX + key);
    },
    clear() {
      for (const key of keys()) storage.removeItem(PREFIX + key);
    },
  };
}

/**
 * Unprefixed key of a cross-tab storage event: null when storage was cleared,
 * undefined when the key belongs to something other than Thyra.
 */
export function thyraStorageEventKey(
  event: Pick<StorageEvent, "key">,
): string | null | undefined {
  if (event.key === null) return null;
  return event.key.startsWith(PREFIX)
    ? event.key.slice(PREFIX.length)
    : undefined;
}

function browserStorage(kind: "localStorage" | "sessionStorage"): Storage {
  const get = () => thyraStorage(globalThis[kind]);
  return {
    get length() {
      return get().length;
    },
    key(index) {
      return get().key(index);
    },
    getItem(key) {
      try {
        return get().getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      get().setItem(key, value);
    },
    removeItem(key) {
      get().removeItem(key);
    },
    clear() {
      get().clear();
    },
  };
}

export const thyraLocalStorage = browserStorage("localStorage");
export const thyraSessionStorage = browserStorage("sessionStorage");
