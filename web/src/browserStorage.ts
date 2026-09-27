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

/**
 * Thyra's browser storage. Writes fail soft: Safari private mode, a full
 * quota, or disabled storage make them return false instead of throwing, so
 * a lost preference never breaks the interface.
 */
export interface ThyraStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  /** False when the browser refused the write. */
  setItem(key: string, value: string): boolean;
  /** False when the browser refused the removal. */
  removeItem(key: string): boolean;
  /** False when the browser refused to clear. */
  clear(): boolean;
}

/** Wrap a storage getter so that every access fails soft; warns once. */
export function failSoftStorage(
  get: () => Storage,
  label: string,
  warn: (message: string) => void = console.warn,
): ThyraStorage {
  let warned = false;
  const attempt = <T>(action: () => T, fallback: T): T => {
    try {
      return action();
    } catch (error) {
      if (!warned) {
        warned = true;
        const reason = error instanceof Error ? error.name : String(error);
        warn(`${label} is unavailable (${reason}); changes will not persist.`);
      }
      return fallback;
    }
  };
  return {
    get length() {
      return attempt(() => get().length, 0);
    },
    key(index) {
      return attempt(() => get().key(index), null);
    },
    getItem(key) {
      return attempt(() => get().getItem(key), null);
    },
    setItem(key, value) {
      return attempt(() => {
        get().setItem(key, value);
        return true;
      }, false);
    },
    removeItem(key) {
      return attempt(() => {
        get().removeItem(key);
        return true;
      }, false);
    },
    clear() {
      return attempt(() => {
        get().clear();
        return true;
      }, false);
    },
  };
}

export const thyraLocalStorage = failSoftStorage(
  () => thyraStorage(globalThis.localStorage),
  "localStorage",
);
export const thyraSessionStorage = failSoftStorage(
  () => thyraStorage(globalThis.sessionStorage),
  "sessionStorage",
);
