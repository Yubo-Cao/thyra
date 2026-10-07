import {
  KEY_ALT,
  KEY_CTRL,
  KEY_SHIFT,
  KEY_SUPER,
  type TerminalKey,
  type TerminalKeyName,
} from "../../shared/terminalKey";

// Latching Ctrl/Alt/Shift for touch keyboards, which have no modifier keys.
// A tap arms a modifier for the next key, a double tap locks it until tapped
// again. Armed modifiers apply to the next key typed on the device keyboard
// or sent from a shortcut button.

export type TerminalModifier = "ctrl" | "alt" | "shift";
export type TerminalModifierLatch = "off" | "once" | "locked";
export type TerminalModifierState = Record<
  TerminalModifier,
  TerminalModifierLatch
>;

export const NO_TERMINAL_MODIFIERS: TerminalModifierState = {
  ctrl: "off",
  alt: "off",
  shift: "off",
};

export const MODIFIER_DOUBLE_TAP_MS = 400;

/** Tap: off → once; once tapped again quickly → locked; otherwise → off. */
export function tapTerminalModifier(
  state: TerminalModifierState,
  modifier: TerminalModifier,
  sinceLastTapMs: number,
): TerminalModifierState {
  const current = state[modifier];
  const next: TerminalModifierLatch =
    current === "off"
      ? "once"
      : current === "once" && sinceLastTapMs <= MODIFIER_DOUBLE_TAP_MS
        ? "locked"
        : "off";
  return { ...state, [modifier]: next };
}

/** Release one-shot modifiers after they were applied to a key. */
export function consumeTerminalModifiers(
  state: TerminalModifierState,
): TerminalModifierState {
  const release = (latch: TerminalModifierLatch) =>
    latch === "once" ? "off" : latch;
  return {
    ctrl: release(state.ctrl),
    alt: release(state.alt),
    shift: release(state.shift),
  };
}

export function terminalModifiersActive(state: TerminalModifierState) {
  return state.ctrl !== "off" || state.alt !== "off" || state.shift !== "off";
}

/** Outgoing input after latched modifiers: plain bytes or one modified key. */
export type TerminalModifiedInput = { bytes: string } | { key: TerminalKey };

const CTRL_BYTE_CHARS = " abcdefghijklmnopqrstuvwxyz[\\]^_";
const CSI_FINAL_KEYS: Record<string, TerminalKeyName> = {
  A: "Up",
  B: "Down",
  C: "Right",
  D: "Left",
  H: "Home",
  F: "End",
};
const TILDE_KEYS: Record<string, TerminalKeyName> = {
  "1": "Home",
  "2": "Insert",
  "3": "Delete",
  "4": "End",
  "5": "PageUp",
  "6": "PageDown",
  "7": "Home",
  "8": "End",
};
const TILDE_FN: Record<string, number> = {
  "11": 1,
  "12": 2,
  "13": 3,
  "14": 4,
  "15": 5,
  "17": 6,
  "18": 7,
  "19": 8,
  "20": 9,
  "21": 10,
  "23": 11,
  "24": 12,
};

/** xterm modifier parameter (1 + shift + 2*alt + 4*ctrl + 8*super). */
function xtermMods(param: string | undefined): number {
  const bits = Math.max(0, Number(param ?? 1) - 1);
  return (
    (bits & 1 ? KEY_SHIFT : 0) |
    (bits & 2 ? KEY_ALT : 0) |
    (bits & 4 ? KEY_CTRL : 0) |
    (bits & 8 ? KEY_SUPER : 0)
  );
}

/** The one key that legacy bytes (a shortcut button, an engine) encode. */
export function terminalKeyFromData(data: string): TerminalKey | null {
  if (data === "\r") return { key: "Enter", mods: 0 };
  if (data === "\t") return { key: "Tab", mods: 0 };
  if (data === "\x7f") return { key: "Backspace", mods: 0 };
  if (data === "\x1b") return { key: "Esc", mods: 0 };
  if (data === "\x1b[Z") return { key: "Tab", mods: KEY_SHIFT };
  const csi = /^\x1b(?:\[(?:1;(\d+))?|O)([ABCDHFPQRS])$/.exec(data);
  if (csi) {
    const mods = xtermMods(csi[1]);
    const fn = "PQRS".indexOf(csi[2]) + 1;
    return fn > 0
      ? { key: "F", fn, mods }
      : { key: CSI_FINAL_KEYS[csi[2]], mods };
  }
  const tilde = /^\x1b\[(\d+)(?:;(\d+))?~$/.exec(data);
  if (tilde) {
    const mods = xtermMods(tilde[2]);
    if (tilde[1] in TILDE_KEYS) return { key: TILDE_KEYS[tilde[1]], mods };
    if (tilde[1] in TILDE_FN) return { key: "F", fn: TILDE_FN[tilde[1]], mods };
    return null;
  }
  const enter = /^\x1b\[13;(\d+)u$/.exec(data);
  if (enter) return { key: "Enter", mods: xtermMods(enter[1]) };
  const alt = data.startsWith("\x1b") && data.length > 1;
  const rest = alt ? data.slice(1) : data;
  const chars = Array.from(rest);
  if (chars.length !== 1) return null;
  const code = rest.codePointAt(0)!;
  let key: TerminalKey;
  if (code === 0x08) key = { key: "Char", char: "h", mods: KEY_CTRL };
  else if (code === 0x7f) key = { key: "Backspace", mods: 0 };
  else if (code === 0x0d) key = { key: "Enter", mods: 0 };
  else if (code === 0x09) key = { key: "Tab", mods: 0 };
  else if (code < 0x20)
    key = { key: "Char", char: CTRL_BYTE_CHARS[code], mods: KEY_CTRL };
  else key = { key: "Char", char: rest, text: rest, mods: 0 };
  return alt ? withTerminalModifiers(key, KEY_ALT) : key;
}

/** Adds modifier bits to a key, keeping its character and text consistent. */
export function withTerminalModifiers(
  key: TerminalKey,
  mods: number,
): TerminalKey {
  const merged = key.mods | mods;
  if (key.key !== "Char" || !key.char) return { ...key, mods: merged };
  const typed = key.text ?? key.char;
  const lower = typed.toLowerCase();
  const char = lower.toUpperCase() !== lower ? lower : key.char;
  const shifted =
    merged & KEY_SHIFT
      ? (key.shifted ??
        (char.toUpperCase() !== char ? char.toUpperCase() : undefined))
      : undefined;
  const chord = (merged & (KEY_CTRL | KEY_ALT | KEY_SUPER)) !== 0;
  const text = chord
    ? undefined
    : merged & KEY_SHIFT
      ? (shifted ?? typed)
      : typed;
  return {
    key: "Char",
    char,
    ...(shifted ? { shifted } : {}),
    ...(text ? { text } : {}),
    mods: merged,
    ...(key.kind ? { kind: key.kind } : {}),
  };
}

export function terminalModifierBits(modifiers: {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}): number {
  return (
    (modifiers.ctrl ? KEY_CTRL : 0) |
    (modifiers.alt ? KEY_ALT : 0) |
    (modifiers.shift ? KEY_SHIFT : 0)
  );
}

/**
 * Applies armed modifiers to one key's input. Returns null when the input is
 * not a single key (e.g. an autocorrected word or IME text), which leaves the
 * modifiers armed for the next key.
 */
export function applyTerminalModifiers(
  data: string,
  modifiers: { ctrl: boolean; alt: boolean; shift: boolean },
): TerminalKey | null {
  const key = terminalKeyFromData(data);
  return key && withTerminalModifiers(key, terminalModifierBits(modifiers));
}
