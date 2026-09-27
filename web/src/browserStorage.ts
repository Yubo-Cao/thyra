const PREFIX = "thyra:";
const DELETED_PREFIX = "thyra:deleted:";
// Keys written before the split from Roamgate, then unprefixed herdr-gui keys.
const LEGACY_PREFIXES = ["roamgate:", ""];

/** Keep legacy originals; deletion markers prevent removed values reappearing. */
export function thyraStorage(storage: Storage): Storage {
  const keys = () => [
    ...new Set(
      Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .filter(
          (key): key is string =>
            key !== null &&
            !key.startsWith(DELETED_PREFIX) &&
            !key.startsWith("roamgate:deleted:"),
        )
        .map((key) => {
          const prefix = [PREFIX, ...LEGACY_PREFIXES].find((candidate) =>
            key.startsWith(candidate),
          );
          return key.slice(prefix?.length ?? 0);
        }),
    ),
  ];
  return {
    get length() {
      return keys().length;
    },
    key(index) {
      return keys()[index] ?? null;
    },
    getItem(key) {
      const current = storage.getItem(PREFIX + key);
      if (current !== null) return current;
      if (storage.getItem(DELETED_PREFIX + encodeURIComponent(key)) !== null)
        return null;
      const legacy = legacyItem(storage, key);
      if (legacy !== null) {
        try {
          storage.setItem(PREFIX + key, legacy);
        } catch {
          /* Read still works when storage is full. */
        }
      }
      return legacy;
    },
    setItem(key, value) {
      storage.setItem(PREFIX + key, value);
    },
    removeItem(key) {
      storage.setItem(DELETED_PREFIX + encodeURIComponent(key), "1");
      storage.removeItem(PREFIX + key);
    },
    clear() {
      for (const key of keys()) this.removeItem(key);
    },
  };
}

function legacyItem(storage: Storage, key: string): string | null {
  if (storage.getItem(`roamgate:deleted:${encodeURIComponent(key)}`) !== null)
    return null;
  for (const prefix of LEGACY_PREFIXES) {
    const value = storage.getItem(prefix + key);
    if (value !== null) return value;
  }
  return null;
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
