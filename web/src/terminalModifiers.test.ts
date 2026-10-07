import { describe, expect, test } from "bun:test";
import {
  applyTerminalModifiers,
  consumeTerminalModifiers,
  NO_TERMINAL_MODIFIERS,
  tapTerminalModifier,
  terminalKeyFromData,
} from "./terminalModifiers";
import { KEY_ALT, KEY_CTRL, KEY_SHIFT } from "../../shared/terminalKey";

const mods = (ctrl = false, alt = false, shift = false) => ({
  ctrl,
  alt,
  shift,
});

describe("latching terminal modifiers", () => {
  test("tap arms once, a quick second tap locks, a later tap releases", () => {
    const once = tapTerminalModifier(NO_TERMINAL_MODIFIERS, "ctrl", 10_000);
    expect(once.ctrl).toBe("once");
    expect(tapTerminalModifier(once, "ctrl", 200).ctrl).toBe("locked");
    expect(tapTerminalModifier(once, "ctrl", 900).ctrl).toBe("off");
    const locked = tapTerminalModifier(once, "ctrl", 200);
    expect(tapTerminalModifier(locked, "ctrl", 100).ctrl).toBe("off");
  });

  test("one-shot modifiers release after a key; locked ones stay", () => {
    expect(
      consumeTerminalModifiers({ ctrl: "once", alt: "locked", shift: "off" }),
    ).toEqual({ ctrl: "off", alt: "locked", shift: "off" });
  });
});

describe("applyTerminalModifiers", () => {
  test("control letters and symbols become Ctrl keys", () => {
    expect(applyTerminalModifiers("c", mods(true))).toEqual({
      key: "Char",
      char: "c",
      mods: KEY_CTRL,
    });
    expect(applyTerminalModifiers("C", mods(true))).toEqual({
      key: "Char",
      char: "c",
      mods: KEY_CTRL,
    });
    expect(applyTerminalModifiers("/", mods(true))).toEqual({
      key: "Char",
      char: "/",
      mods: KEY_CTRL,
    });
    expect(applyTerminalModifiers(" ", mods(true))?.mods).toBe(KEY_CTRL);
  });

  test("alt and shift keep the character and its text", () => {
    expect(applyTerminalModifiers("b", mods(false, true))).toEqual({
      key: "Char",
      char: "b",
      mods: KEY_ALT,
    });
    expect(applyTerminalModifiers("a", mods(false, false, true))).toEqual({
      key: "Char",
      char: "a",
      shifted: "A",
      text: "A",
      mods: KEY_SHIFT,
    });
    // Ctrl+X from a shortcut button with Alt latched.
    expect(applyTerminalModifiers("\x18", mods(false, true))).toEqual({
      key: "Char",
      char: "x",
      mods: KEY_CTRL | KEY_ALT,
    });
  });

  test("navigation and editing keys gain the modifiers", () => {
    expect(applyTerminalModifiers("\x1b[A", mods(true))).toEqual({
      key: "Up",
      mods: KEY_CTRL,
    });
    expect(applyTerminalModifiers("\x1bOD", mods(false, true))).toEqual({
      key: "Left",
      mods: KEY_ALT,
    });
    expect(applyTerminalModifiers("\x1b[5~", mods(false, false, true))).toEqual(
      { key: "PageUp", mods: KEY_SHIFT },
    );
    expect(applyTerminalModifiers("\t", mods(false, false, true))).toEqual({
      key: "Tab",
      mods: KEY_SHIFT,
    });
    expect(applyTerminalModifiers("\r", mods(false, false, true))).toEqual({
      key: "Enter",
      mods: KEY_SHIFT,
    });
    expect(applyTerminalModifiers("\x7f", mods(true))).toEqual({
      key: "Backspace",
      mods: KEY_CTRL,
    });
  });

  test("multi-character input leaves modifiers armed", () => {
    expect(applyTerminalModifiers("hello", mods(true))).toBeNull();
  });
});

describe("terminalKeyFromData", () => {
  test("decodes the shortcut bar's legacy bytes", () => {
    expect(terminalKeyFromData("\x03")).toEqual({
      key: "Char",
      char: "c",
      mods: KEY_CTRL,
    });
    expect(terminalKeyFromData("\x1b[13;2u")).toEqual({
      key: "Enter",
      mods: KEY_SHIFT,
    });
    expect(terminalKeyFromData("\x1b[1;3A")).toEqual({
      key: "Up",
      mods: KEY_ALT,
    });
    expect(terminalKeyFromData("\x1b[3~")).toEqual({ key: "Delete", mods: 0 });
    expect(terminalKeyFromData("\x1b")).toEqual({ key: "Esc", mods: 0 });
    expect(terminalKeyFromData("ab")).toBeNull();
  });
});
