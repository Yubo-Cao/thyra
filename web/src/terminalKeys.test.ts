import { describe, expect, test } from "bun:test";
import { terminalShortcutKey } from "./terminalKeys";
import {
  KEY_ALT,
  KEY_CTRL,
  KEY_SHIFT,
  type TerminalKey,
} from "../../shared/terminalKey";
import { defaultShortcutBindings } from "./shortcutBindings";
type KeyEvent = Parameters<typeof terminalShortcutKey>[0];
const modifiedEnterSequence = (event: KeyEvent) =>
  terminalShortcutKey(event, defaultShortcutBindings("linux"));
const macCommandEditingSequence = (event: KeyEvent, isMac: boolean) =>
  isMac ? terminalShortcutKey(event, defaultShortcutBindings("mac")) : null;

function keyEvent(
  overrides: Partial<Parameters<typeof modifiedEnterSequence>[0]> = {},
): Parameters<typeof modifiedEnterSequence>[0] {
  return {
    type: "keydown",
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  };
}

describe("terminal modified Enter keys", () => {
  test("keeps Shift+Enter, Alt+Enter and Ctrl+Enter distinct", () => {
    expect(modifiedEnterSequence(keyEvent({ shiftKey: true }))).toEqual({
      key: "Enter",
      mods: KEY_SHIFT,
    });
    expect(modifiedEnterSequence(keyEvent({ altKey: true }))).toEqual({
      key: "Enter",
      mods: KEY_ALT,
    });
    for (const platform of ["mac", "windows", "linux"] as const) {
      for (const code of ["Enter", "NumpadEnter"]) {
        expect(
          terminalShortcutKey(
            keyEvent({ code, ctrlKey: true }),
            defaultShortcutBindings(platform),
          ),
        ).toEqual({ key: "Enter", mods: KEY_CTRL });
      }
    }
  });

  test("does not collapse other modifier combinations", () => {
    for (let modifiers = 0; modifiers < 16; modifiers++) {
      const sequence = modifiedEnterSequence(
        keyEvent({
          shiftKey: (modifiers & 1) !== 0,
          altKey: (modifiers & 2) !== 0,
          ctrlKey: (modifiers & 4) !== 0,
          metaKey: (modifiers & 8) !== 0,
        }),
      );
      const expected: TerminalKey | null =
        modifiers === 1
          ? { key: "Enter", mods: KEY_SHIFT }
          : modifiers === 2
            ? { key: "Enter", mods: KEY_ALT }
            : modifiers === 4
              ? { key: "Enter", mods: KEY_CTRL }
              : null;
      expect(sequence).toEqual(expected);
    }
  });

  test("supports the numpad Enter code", () => {
    expect(
      modifiedEnterSequence(
        keyEvent({ key: "", code: "NumpadEnter", altKey: true }),
      ),
    ).toEqual({ key: "Enter", mods: KEY_ALT });
  });

  test("leaves unrelated and combined modifiers to xterm", () => {
    expect(modifiedEnterSequence(keyEvent())).toBeNull();
    expect(
      modifiedEnterSequence(keyEvent({ shiftKey: true, altKey: true })),
    ).toBeNull();
    expect(
      modifiedEnterSequence(keyEvent({ altKey: true, ctrlKey: true })),
    ).toBeNull();
    expect(
      modifiedEnterSequence(keyEvent({ type: "keyup", altKey: true })),
    ).toBeNull();
  });

  test("does not bypass IME composition handling", () => {
    expect(
      modifiedEnterSequence(keyEvent({ altKey: true, isComposing: true })),
    ).toBeNull();
    expect(
      modifiedEnterSequence(keyEvent({ altKey: true, keyCode: 229 })),
    ).toBeNull();
  });
});

describe("terminal macOS Command editing keys", () => {
  test("maps pure Command editing shortcuts to readline controls", () => {
    expect(
      macCommandEditingSequence(
        keyEvent({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }),
        true,
      ),
    ).toEqual({ key: "Char", char: "a", mods: KEY_CTRL });
    expect(
      macCommandEditingSequence(
        keyEvent({ key: "ArrowDown", code: "ArrowDown", metaKey: true }),
        true,
      ),
    ).toEqual({ key: "Char", char: "e", mods: KEY_CTRL });
    expect(
      macCommandEditingSequence(
        keyEvent({ key: "Backspace", code: "Backspace", metaKey: true }),
        true,
      ),
    ).toEqual({ key: "Char", char: "u", mods: KEY_CTRL });
  });

  test("does not downgrade additional modifiers to pure Command", () => {
    expect(
      macCommandEditingSequence(
        keyEvent({
          key: "ArrowLeft",
          code: "ArrowLeft",
          metaKey: true,
          shiftKey: true,
        }),
        true,
      ),
    ).toBeNull();
    expect(
      macCommandEditingSequence(
        keyEvent({
          key: "Backspace",
          code: "Backspace",
          metaKey: true,
          altKey: true,
        }),
        true,
      ),
    ).toBeNull();
  });

  test("does not reinterpret Meta keys on non-Apple platforms", () => {
    expect(
      macCommandEditingSequence(
        keyEvent({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }),
        false,
      ),
    ).toBeNull();
  });

  test("does not bypass IME composition handling", () => {
    expect(
      macCommandEditingSequence(
        keyEvent({
          key: "Backspace",
          code: "Backspace",
          keyCode: 8,
          metaKey: true,
          isComposing: true,
        }),
        true,
      ),
    ).toBeNull();
  });
});
