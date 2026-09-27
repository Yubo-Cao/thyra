import { expect, test } from "bun:test";
import {
  failSoftStorage,
  thyraStorage,
  thyraStorageEventKey,
} from "./browserStorage";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

test("fresh browser writes use Thyra keys", () => {
  const raw = memoryStorage();
  const storage = thyraStorage(raw);
  storage.setItem("theme", "dark");
  expect(raw.getItem("thyra:theme")).toBe("dark");
  expect(raw.getItem("theme")).toBeNull();
});

test("reads, removes and enumerates only Thyra keys", () => {
  const raw = memoryStorage({
    theme: "light",
    "thyra:diffViewerSelected:one": "saved",
    "other:key": "kept",
  });
  const storage = thyraStorage(raw);
  expect(storage.getItem("theme")).toBeNull();
  expect(storage.getItem("diffViewerSelected:one")).toBe("saved");
  expect(storage.length).toBe(1);
  expect(storage.key(0)).toBe("diffViewerSelected:one");
  expect(storage.key(1)).toBeNull();

  storage.setItem("theme", "dark");
  storage.removeItem("diffViewerSelected:one");
  expect(raw.getItem("thyra:diffViewerSelected:one")).toBeNull();
  expect(storage.getItem("theme")).toBe("dark");

  storage.clear();
  expect(storage.length).toBe(0);
  expect(raw.getItem("thyra:theme")).toBeNull();
  expect(raw.getItem("theme")).toBe("light");
  expect(raw.getItem("other:key")).toBe("kept");
});

test("storage events resolve to unprefixed Thyra keys only", () => {
  expect(thyraStorageEventKey({ key: "thyra:theme" })).toBe("theme");
  expect(thyraStorageEventKey({ key: "theme" })).toBeUndefined();
  expect(thyraStorageEventKey({ key: null })).toBeNull();
});

test("fail-soft storage reports refused writes and warns once", () => {
  const raw = memoryStorage({ "thyra:theme": "dark" });
  raw.setItem = () => {
    throw new DOMException("quota", "QuotaExceededError");
  };
  raw.removeItem = () => {
    throw new DOMException("denied", "SecurityError");
  };
  const warnings: string[] = [];
  const storage = failSoftStorage(
    () => thyraStorage(raw),
    "localStorage",
    (message) => warnings.push(message),
  );
  expect(storage.getItem("theme")).toBe("dark");
  expect(storage.setItem("theme", "light")).toBe(false);
  expect(storage.removeItem("theme")).toBe(false);
  expect(storage.clear()).toBe(false);
  expect(storage.getItem("theme")).toBe("dark");
  expect(warnings).toHaveLength(1);
});

test("fail-soft storage survives an inaccessible storage object", () => {
  const storage = failSoftStorage(
    () => {
      throw new DOMException("denied", "SecurityError");
    },
    "sessionStorage",
    () => {},
  );
  expect(storage.length).toBe(0);
  expect(storage.key(0)).toBeNull();
  expect(storage.getItem("theme")).toBeNull();
  expect(storage.setItem("theme", "dark")).toBe(false);
  expect(storage.removeItem("theme")).toBe(false);
});

test("fail-soft storage writes through when storage works", () => {
  const raw = memoryStorage();
  const storage = failSoftStorage(() => thyraStorage(raw), "localStorage");
  expect(storage.setItem("theme", "dark")).toBe(true);
  expect(raw.getItem("thyra:theme")).toBe("dark");
  expect(storage.removeItem("theme")).toBe(true);
  expect(raw.getItem("thyra:theme")).toBeNull();
});
