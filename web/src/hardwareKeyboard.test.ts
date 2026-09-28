import { expect, test } from "bun:test";
import {
  createKeyboardDetector,
  KEYBOARD_SETTLE_MS,
  keydownEvidence,
  parseKeyboardKind,
  viewportEvidence,
} from "./hardwareKeyboard";

const key = (key: string, extra: Partial<KeyboardEvent> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 0,
  isTrusted: true,
  ...extra,
});

test("the persisted verdict is parsed strictly", () => {
  expect(parseKeyboardKind("hardware")).toBe("hardware");
  expect(parseKeyboardKind("software")).toBe("software");
  expect(parseKeyboardKind(null)).toBe("unknown");
  expect(parseKeyboardKind("bluetooth")).toBe("unknown");
});

test("a key with nothing editable focused proves a hardware keyboard", () => {
  expect(keydownEvidence(key("a"), false)).toBe("hardware");
  expect(keydownEvidence(key("Enter"), false)).toBe("hardware");
});

test("in a field, only chords and keys the on-screen keyboard lacks count", () => {
  expect(keydownEvidence(key("a"), true)).toBeNull();
  expect(keydownEvidence(key("Enter"), true)).toBeNull();
  expect(keydownEvidence(key("Backspace"), true)).toBeNull();
  expect(keydownEvidence(key("A", { shiftKey: true }), true)).toBeNull();
  expect(keydownEvidence(key("Enter", { metaKey: true }), true)).toBe(
    "hardware",
  );
  expect(keydownEvidence(key("c", { ctrlKey: true }), true)).toBe("hardware");
  expect(keydownEvidence(key("x", { altKey: true }), true)).toBe("hardware");
  for (const name of [
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Escape",
    "Tab",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "F1",
    "F12",
  ])
    expect(keydownEvidence(key(name), true)).toBe("hardware");
});

test("composition and synthesized keys prove nothing", () => {
  expect(keydownEvidence(key("a", { isComposing: true }), false)).toBeNull();
  expect(keydownEvidence(key("Process", { keyCode: 229 }), false)).toBeNull();
  expect(
    keydownEvidence(key("ArrowUp", { isComposing: true }), true),
  ).toBeNull();
  expect(keydownEvidence(key("Escape", { isTrusted: false }), false)).toBe(
    null,
  );
});

test("the viewport's shrink after a focus tells the keyboards apart", () => {
  // The on-screen keyboard takes hundreds of pixels.
  expect(viewportEvidence(1024, 700)).toBe("software");
  expect(viewportEvidence(1024, 874)).toBe("software");
  // A hardware keyboard only brings the shortcut bar.
  expect(viewportEvidence(1024, 969)).toBe("hardware");
  // Nothing appeared (a floating keyboard, or focus without a keyboard).
  expect(viewportEvidence(1024, 1024)).toBeNull();
  expect(viewportEvidence(1024, 1030)).toBeNull();
});

function detector(initialHeight: number) {
  let height = initialHeight;
  const timers: (() => void)[] = [];
  const reports: string[] = [];
  const instance = createKeyboardDetector({
    viewportHeight: () => height,
    setTimeout: (callback, ms) => {
      expect(ms).toBe(KEYBOARD_SETTLE_MS);
      return timers.push(callback) - 1;
    },
    clearTimeout: (handle) => {
      timers[handle as number] = () => {};
    },
    report: (kind) => reports.push(kind),
  });
  return {
    instance,
    reports,
    resize(next: number) {
      height = next;
      instance.viewportResize();
    },
    settle: () => timers[timers.length - 1]?.(),
  };
}

test("an on-screen keyboard is reported as soon as it is tall enough", () => {
  const d = detector(1024);
  d.instance.focus();
  d.resize(900);
  expect(d.reports).toEqual([]);
  d.resize(724);
  expect(d.reports).toEqual(["software"]);
  // Settling afterwards reports nothing more.
  d.settle();
  d.resize(600);
  expect(d.reports).toEqual(["software"]);
});

test("a small shortcut bar after a focus means a hardware keyboard", () => {
  const d = detector(1024);
  d.instance.focus();
  d.resize(969);
  expect(d.reports).toEqual([]);
  d.settle();
  expect(d.reports).toEqual(["hardware"]);
});

test("no viewport change after a focus gives no verdict", () => {
  const d = detector(1024);
  d.instance.focus();
  d.settle();
  expect(d.reports).toEqual([]);
  // Resizes outside the watch window are ignored.
  d.resize(500);
  expect(d.reports).toEqual([]);
});

test("keys report through the detector", () => {
  const d = detector(1024);
  d.instance.keydown(key("a"), true);
  expect(d.reports).toEqual([]);
  d.instance.keydown(key("a"), false);
  expect(d.reports).toEqual(["hardware"]);
});
