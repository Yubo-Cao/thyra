import { describe, expect, test } from "bun:test";
import {
  KEY_ALT,
  KEY_CTRL,
  KEY_SHIFT,
  KEY_SUPER,
} from "../../../../shared/terminalKey";
import {
  type TerminalKeyContext,
  type TerminalKeyEventLike,
  terminalKeyFromEvent,
} from "./terminalKeyEvents";

const linux: TerminalKeyContext = { apple: false, optionAsAlt: "left" };
const mac: TerminalKeyContext = { apple: true, optionAsAlt: "left" };

function key(
  domKey: string,
  code: string,
  init: Partial<TerminalKeyEventLike> = {},
): TerminalKeyEventLike {
  return {
    type: "keydown",
    key: domKey,
    code,
    keyCode: 0,
    repeat: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    ...init,
  };
}

describe("terminalKeyFromEvent", () => {
  test("Ctrl+/ is the slash key with Ctrl, not Ctrl+_", () => {
    for (const context of [linux, mac])
      expect(
        terminalKeyFromEvent(key("/", "Slash", { ctrlKey: true }), context),
      ).toEqual({ key: "Char", char: "/", mods: KEY_CTRL, kind: "press" });
  });

  test("Ctrl+Shift+A keeps the base and shifted characters", () => {
    expect(
      terminalKeyFromEvent(
        key("A", "KeyA", { ctrlKey: true, shiftKey: true }),
        linux,
      ),
    ).toEqual({
      key: "Char",
      char: "a",
      shifted: "A",
      mods: KEY_CTRL | KEY_SHIFT,
      kind: "press",
    });
  });

  test("Alt+Shift+F", () => {
    expect(
      terminalKeyFromEvent(
        key("F", "KeyF", { altKey: true, shiftKey: true }),
        linux,
      ),
    ).toEqual({
      key: "Char",
      char: "f",
      shifted: "F",
      mods: KEY_ALT | KEY_SHIFT,
      kind: "press",
    });
  });

  test("modified Enter and NumpadEnter", () => {
    expect(
      terminalKeyFromEvent(key("Enter", "Enter", { ctrlKey: true }), linux),
    ).toEqual({ key: "Enter", mods: KEY_CTRL, kind: "press" });
    expect(
      terminalKeyFromEvent(
        key("Enter", "NumpadEnter", { shiftKey: true }),
        mac,
      ),
    ).toEqual({ key: "Enter", mods: KEY_SHIFT, kind: "press" });
  });

  test("Ctrl+1 is the digit with Ctrl", () => {
    expect(
      terminalKeyFromEvent(key("1", "Digit1", { ctrlKey: true }), linux),
    ).toEqual({ key: "Char", char: "1", mods: KEY_CTRL, kind: "press" });
  });

  test("Option as Alt sends the physical key on macOS", () => {
    const optionF = key("ƒ", "KeyF", { altKey: true });
    expect(terminalKeyFromEvent(optionF, { ...mac, altSide: "left" })).toEqual({
      key: "Char",
      char: "f",
      mods: KEY_ALT,
      kind: "press",
    });
    expect(
      terminalKeyFromEvent(optionF, {
        ...mac,
        optionAsAlt: "both",
        altSide: "right",
      }),
    ).toEqual({ key: "Char", char: "f", mods: KEY_ALT, kind: "press" });
    // The other Option key, or Option-as-Alt off, types the character.
    for (const context of [
      { ...mac, altSide: "right" as const },
      { ...mac, optionAsAlt: "off" as const, altSide: "left" as const },
    ])
      expect(terminalKeyFromEvent(optionF, context)).toEqual({
        key: "Char",
        char: "ƒ",
        text: "ƒ",
        mods: 0,
        kind: "press",
      });
    // Option+Shift+F as Alt reports the shifted US key, not "Ï".
    expect(
      terminalKeyFromEvent(
        key("Ï", "KeyF", { altKey: true, shiftKey: true }),
        mac,
      ),
    ).toEqual({
      key: "Char",
      char: "f",
      shifted: "F",
      mods: KEY_ALT | KEY_SHIFT,
      kind: "press",
    });
  });

  test("Command chords carry Super", () => {
    expect(
      terminalKeyFromEvent(key("k", "KeyK", { metaKey: true }), mac),
    ).toEqual({ key: "Char", char: "k", mods: KEY_SUPER, kind: "press" });
    // Chrome on macOS reports Cmd+Shift+K as "k".
    expect(
      terminalKeyFromEvent(
        key("k", "KeyK", { metaKey: true, shiftKey: true }),
        mac,
      ),
    ).toEqual({
      key: "Char",
      char: "k",
      shifted: "K",
      mods: KEY_SUPER | KEY_SHIFT,
      kind: "press",
    });
  });

  test("plain and shifted keys carry their text; releases do not", () => {
    expect(terminalKeyFromEvent(key("a", "KeyA"), linux)).toEqual({
      key: "Char",
      char: "a",
      text: "a",
      mods: 0,
      kind: "press",
    });
    expect(
      terminalKeyFromEvent(key("?", "Slash", { shiftKey: true }), linux),
    ).toEqual({
      key: "Char",
      char: "/",
      shifted: "?",
      text: "?",
      mods: KEY_SHIFT,
      kind: "press",
    });
    expect(
      terminalKeyFromEvent(key("a", "KeyA", { type: "keyup" }), linux),
    ).toEqual({ key: "Char", char: "a", mods: 0, kind: "release" });
    expect(
      terminalKeyFromEvent(key("a", "KeyA", { repeat: true }), linux)?.kind,
    ).toBe("repeat");
  });

  test("Ctrl on a non-Latin layout uses the physical US key", () => {
    expect(
      terminalKeyFromEvent(key("с", "KeyC", { ctrlKey: true }), linux),
    ).toEqual({ key: "Char", char: "c", mods: KEY_CTRL, kind: "press" });
  });

  test("AltGr types its character without Ctrl or Alt", () => {
    expect(
      terminalKeyFromEvent(
        key("@", "KeyQ", {
          ctrlKey: true,
          altKey: true,
          getModifierState: (state) => state === "AltGraph",
        }),
        linux,
      ),
    ).toEqual({ key: "Char", char: "@", text: "@", mods: 0, kind: "press" });
  });

  test("function keys, Shift+Tab and Escape", () => {
    expect(terminalKeyFromEvent(key("F5", "F5"), linux)).toEqual({
      key: "F",
      fn: 5,
      mods: 0,
      kind: "press",
    });
    expect(
      terminalKeyFromEvent(key("Tab", "Tab", { shiftKey: true }), linux),
    ).toEqual({ key: "Tab", mods: KEY_SHIFT, kind: "press" });
    expect(terminalKeyFromEvent(key("Escape", "Escape"), linux)?.key).toBe(
      "Esc",
    );
  });

  test("leaves IME, dead keys and bare modifiers to the engine", () => {
    expect(
      terminalKeyFromEvent(key("a", "KeyA", { isComposing: true }), linux),
    ).toBeNull();
    expect(
      terminalKeyFromEvent(key("Process", "KeyA", { keyCode: 229 }), linux),
    ).toBeNull();
    expect(terminalKeyFromEvent(key("Dead", "Quote"), mac)).toBeNull();
    expect(terminalKeyFromEvent(key("Shift", "ShiftLeft"), linux)).toBeNull();
    expect(
      terminalKeyFromEvent(key("Unidentified", "", { keyCode: 0 }), linux),
    ).toBeNull();
  });
});
