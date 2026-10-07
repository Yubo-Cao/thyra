/**
 * One key event as a terminal sees it, before any byte encoding. The browser
 * sends these over `terminal.key`; Herdr encodes them for each pane's
 * negotiated keyboard protocol (legacy, modifyOtherKeys or Kitty), the way a
 * native terminal would.
 */

/** crossterm KeyModifiers bits, as Herdr's wire protocol carries them. */
export const KEY_SHIFT = 0x1;
export const KEY_CTRL = 0x2;
export const KEY_ALT = 0x4;
export const KEY_SUPER = 0x8;

export const TERMINAL_KEY_NAMES = [
  "Backspace",
  "Enter",
  "Left",
  "Right",
  "Up",
  "Down",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Tab",
  "BackTab",
  "Delete",
  "Insert",
  "Esc",
  "Char",
  "F",
] as const;
export type TerminalKeyName = (typeof TERMINAL_KEY_NAMES)[number];
export type TerminalKeyKind = "press" | "repeat" | "release";

export type TerminalKey = {
  key: TerminalKeyName;
  /** The unshifted character on the current layout, for `Char`. */
  char?: string;
  /** Function key number, for `F`. */
  fn?: number;
  /** The character with Shift held, when Shift is held. */
  shifted?: string;
  /** Text the key types (plain or Shift-only keys). */
  text?: string;
  mods: number;
  kind?: TerminalKeyKind;
};

const MAX_KEYS = 256;
const MAX_TEXT = 32;

function isOneCodePoint(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2 &&
    Array.from(value).length === 1
  );
}

/** Validates `terminal.key` events; null when any event is malformed. */
export function parseTerminalKeys(value: unknown): TerminalKey[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_KEYS)
    return null;
  const keys: TerminalKey[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const raw = item as Record<string, unknown>;
    const name = raw.key;
    if (!TERMINAL_KEY_NAMES.includes(name as TerminalKeyName)) return null;
    const mods = raw.mods ?? 0;
    if (
      !Number.isInteger(mods) ||
      (mods as number) < 0 ||
      (mods as number) > 15
    )
      return null;
    const kind = raw.kind ?? "press";
    if (kind !== "press" && kind !== "repeat" && kind !== "release")
      return null;
    const key: TerminalKey = {
      key: name as TerminalKeyName,
      mods: mods as number,
      kind,
    };
    if (name === "Char") {
      if (!isOneCodePoint(raw.char)) return null;
      key.char = raw.char;
    }
    if (name === "F") {
      if (!Number.isInteger(raw.fn) || (raw.fn as number) < 1) return null;
      if ((raw.fn as number) > 24) return null;
      key.fn = raw.fn as number;
    }
    if (raw.shifted !== undefined) {
      if (!isOneCodePoint(raw.shifted)) return null;
      key.shifted = raw.shifted;
    }
    if (raw.text !== undefined) {
      if (
        typeof raw.text !== "string" ||
        raw.text.length === 0 ||
        raw.text.length > MAX_TEXT
      )
        return null;
      key.text = raw.text;
    }
    keys.push(key);
  }
  return keys;
}
