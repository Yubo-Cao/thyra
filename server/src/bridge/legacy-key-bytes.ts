import {
  KEY_ALT,
  KEY_CTRL,
  KEY_SHIFT,
  type TerminalKey,
} from "../../../shared/terminalKey";

// Direct terminal attaches (popups, Herdr without the endpoint) write bytes
// straight to the PTY, so semantic keys need an xterm-style legacy encoding.

const CTRL_SYMBOLS: Record<string, number> = {
  " ": 0x00,
  "@": 0x00,
  "2": 0x00,
  "[": 0x1b,
  "3": 0x1b,
  "\\": 0x1c,
  "4": 0x1c,
  "]": 0x1d,
  "5": 0x1d,
  "^": 0x1e,
  "6": 0x1e,
  _: 0x1f,
  "-": 0x1f,
  "7": 0x1f,
  "/": 0x1f,
  "?": 0x7f,
  "8": 0x7f,
};
const CSI_LETTER: Partial<Record<TerminalKey["key"], string>> = {
  Up: "A",
  Down: "B",
  Right: "C",
  Left: "D",
  Home: "H",
  End: "F",
};
const CSI_TILDE: Partial<Record<TerminalKey["key"], number>> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
};
const F_TILDE = [15, 17, 18, 19, 20, 21, 23, 24];

function legacyKey(key: TerminalKey): string {
  if (key.kind === "release") return "";
  const shift = (key.mods & KEY_SHIFT) !== 0;
  const alt = (key.mods & KEY_ALT) !== 0;
  const ctrl = (key.mods & KEY_CTRL) !== 0;
  const param = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const prefix = alt ? "\x1b" : "";
  const letter = CSI_LETTER[key.key];
  if (letter)
    return param === 1 ? `\x1b[${letter}` : `\x1b[1;${param}${letter}`;
  const tilde = CSI_TILDE[key.key];
  if (tilde) return param === 1 ? `\x1b[${tilde}~` : `\x1b[${tilde};${param}~`;
  switch (key.key) {
    case "F": {
      const n = key.fn ?? 1;
      if (n <= 4) {
        const final = "PQRS"[n - 1];
        return param === 1 ? `\x1bO${final}` : `\x1b[1;${param}${final}`;
      }
      const code = F_TILDE[n - 5];
      if (!code) return "";
      return param === 1 ? `\x1b[${code}~` : `\x1b[${code};${param}~`;
    }
    case "Enter":
      return `${prefix}\r`;
    case "Tab":
      return shift && !ctrl ? `${prefix}\x1b[Z` : `${prefix}\t`;
    case "BackTab":
      return `${prefix}\x1b[Z`;
    case "Backspace":
      return `${prefix}${ctrl ? "\x08" : "\x7f"}`;
    case "Esc":
      return `${prefix}\x1b`;
    case "Char": {
      let ch = key.text ?? (shift ? (key.shifted ?? key.char) : key.char) ?? "";
      if (ctrl) {
        const lower = (key.char ?? ch).toLowerCase();
        if (lower >= "a" && lower <= "z")
          ch = String.fromCharCode(lower.charCodeAt(0) - 0x60);
        else if (lower in CTRL_SYMBOLS)
          ch = String.fromCharCode(CTRL_SYMBOLS[lower]);
      }
      return `${prefix}${ch}`;
    }
    default:
      return "";
  }
}

export function legacyKeyBytes(keys: TerminalKey[]): Buffer {
  return Buffer.from(keys.map(legacyKey).join(""), "utf8");
}
