import { expect, test } from "bun:test";
import { thyraStorage, thyraStorageEventKey } from "./browserStorage";

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
