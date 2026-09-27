import { expect, test } from "bun:test";
import { thyraStorage } from "./browserStorage";

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

test("legacy preferences, drafts and connection selections copy once; new empty values win", () => {
  for (const key of [
    "theme",
    "reviewAnnotations:resource",
    "herdr.connection/one/filePreview",
  ]) {
    const raw = memoryStorage({ [key]: "saved" });
    expect(thyraStorage(raw).getItem(key)).toBe("saved");
    expect(raw.getItem(`thyra:${key}`)).toBe("saved");
    raw.setItem(key, "stale");
    expect(thyraStorage(raw).getItem(key)).toBe("saved");
    raw.setItem(`thyra:${key}`, "");
    expect(thyraStorage(raw).getItem(key)).toBe("");
    expect(raw.getItem(key)).toBe("stale");
  }
});

test("clearing migrated values does not resurrect originals on reload", () => {
  const raw = memoryStorage({ theme: "dark" });
  const storage = thyraStorage(raw);
  expect(storage.getItem("theme")).toBe("dark");
  storage.removeItem("theme");
  expect(thyraStorage(raw).getItem("theme")).toBeNull();
  expect(raw.getItem("theme")).toBe("dark");
  storage.setItem("theme", "light");
  expect(storage.getItem("theme")).toBe("light");
});

test("failed migration reads saved values and can retry", () => {
  const raw = memoryStorage({ theme: "dark" });
  const setItem = raw.setItem;
  raw.setItem = () => {
    throw new Error("quota exceeded");
  };
  expect(thyraStorage(raw).getItem("theme")).toBe("dark");
  raw.setItem = setItem;
  expect(thyraStorage(raw).getItem("theme")).toBe("dark");
  expect(raw.getItem("thyra:theme")).toBe("dark");
});

test("enumeration keeps legacy connection migration working without duplicate keys", () => {
  const raw = memoryStorage({
    "diffViewerSelected:one": "saved",
    "thyra:diffViewerSelected:one": "new",
  });
  const storage = thyraStorage(raw);
  expect(storage.length).toBe(1);
  expect(storage.key(0)).toBe("diffViewerSelected:one");
  storage.clear();
  expect(storage.getItem("diffViewerSelected:one")).toBeNull();
  expect(raw.getItem("diffViewerSelected:one")).toBe("saved");
});

test("Roamgate keys copy once and Roamgate deletions stay deleted", () => {
  const raw = memoryStorage({
    "roamgate:theme": "light",
    theme: "dark",
    draft: "old draft",
    "roamgate:deleted:draft": "1",
  });
  const storage = thyraStorage(raw);
  expect(storage.getItem("theme")).toBe("light");
  expect(raw.getItem("thyra:theme")).toBe("light");
  expect(storage.getItem("draft")).toBeNull();
  expect(
    Array.from({ length: storage.length }, (_, i) => storage.key(i)),
  ).toEqual(["theme", "draft"]);
  storage.setItem("theme", "dark");
  expect(storage.getItem("theme")).toBe("dark");
  expect(raw.getItem("roamgate:theme")).toBe("light");
});
