// Hardware keys reach the pane as semantic key events, not as bytes a
// terminal engine encoded: Herdr encodes each one for the pane's negotiated
// keyboard protocol, so Ctrl+/ arrives as 0x1f in a legacy shell and as
// CSI 47;5u in a Kitty-keyboard application, exactly as from Ghostty.
// IME composition, dead keys, paste and on-screen keyboards stay with the
// terminal engine and its byte path.

import {
  KEY_ALT,
  KEY_CTRL,
  KEY_SHIFT,
  KEY_SUPER,
  type TerminalKey,
  type TerminalKeyName,
} from "../../../../shared/terminalKey";
import { keyboardKindNow } from "../../hardwareKeyboard";
import {
  exclusiveKeyboardActive,
  type OptionAsAlt,
  optionAsAltNow,
} from "../../terminalKeyPreferences";

export type TerminalKeyEventLike = Pick<
  KeyboardEvent,
  | "type"
  | "key"
  | "code"
  | "keyCode"
  | "repeat"
  | "shiftKey"
  | "altKey"
  | "ctrlKey"
  | "metaKey"
  | "isComposing"
> &
  Partial<Pick<KeyboardEvent, "getModifierState">>;

export type TerminalKeyContext = {
  /** macOS/iOS: Option composes characters unless it acts as Alt. */
  apple: boolean;
  optionAsAlt: OptionAsAlt;
  /** Which Alt/Option key is held, when known. */
  altSide?: "left" | "right" | null;
  /** The layout's unshifted character per physical key (Chromium only). */
  layout?: ReadonlyMap<string, string> | null;
};

const NAMED_KEYS: Record<string, TerminalKeyName> = {
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Escape: "Esc",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Delete: "Delete",
  Insert: "Insert",
};

// Unshifted and shifted characters of the US layout, by physical key: the
// fallback when the event's own character is a modifier's product (Option+f
// types "ƒ") or from a non-Latin layout under Ctrl.
const US_KEYS: Record<string, [string, string]> = {
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  Backquote: ["`", "~"],
  Space: [" ", " "],
};
for (const letter of "abcdefghijklmnopqrstuvwxyz")
  US_KEYS[`Key${letter.toUpperCase()}`] = [letter, letter.toUpperCase()];
")!@#$%^&*(".split("").forEach((shifted, digit) => {
  US_KEYS[`Digit${digit}`] = [String(digit), shifted];
});

const ASCII = /^[\x20-\x7e]$/;

function optionActsAsAlt(context: TerminalKeyContext): boolean {
  const side = context.altSide ?? "left";
  return (
    context.optionAsAlt === "both" ||
    (context.optionAsAlt !== "off" && context.optionAsAlt === side)
  );
}

/** The semantic key for a DOM key event, or null to leave it to the engine. */
export function terminalKeyFromEvent(
  event: TerminalKeyEventLike,
  context: TerminalKeyContext,
): TerminalKey | null {
  if (event.isComposing || event.keyCode === 229) return null;
  const { key: domKey, code } = event;
  if (!domKey || ["Dead", "Process", "Unidentified"].includes(domKey))
    return null;
  const kind =
    event.type === "keyup" ? "release" : event.repeat ? "repeat" : "press";
  let mods =
    (event.shiftKey ? KEY_SHIFT : 0) |
    (event.ctrlKey ? KEY_CTRL : 0) |
    (event.altKey ? KEY_ALT : 0) |
    (event.metaKey ? KEY_SUPER : 0);
  const named = code === "NumpadEnter" ? "Enter" : NAMED_KEYS[domKey];
  if (named) return { key: named, mods, kind };
  const fn = /^F([1-9]|1\d|2[0-4])$/.exec(domKey);
  if (fn) return { key: "F", fn: Number(fn[1]), mods, kind };
  // Modifier keys, media keys and other named keys have no terminal key.
  if (Array.from(domKey).length !== 1) return null;

  // AltGr and a composing Option key type the character they produce.
  const altGraph =
    !context.apple && event.getModifierState?.("AltGraph") === true;
  const optionTypes =
    context.apple && event.altKey && !optionActsAsAlt(context);
  if (altGraph || optionTypes) {
    mods &= ~(KEY_SHIFT | KEY_ALT | (altGraph ? KEY_CTRL : 0));
    return {
      key: "Char",
      char: domKey,
      ...(kind !== "release" && mods === 0 ? { text: domKey } : {}),
      mods,
      kind,
    };
  }

  const us = US_KEYS[code];
  const optionAlt = context.apple && event.altKey;
  let base =
    !event.shiftKey && !optionAlt
      ? domKey.toLowerCase()
      : (context.layout?.get(code) ?? us?.[0] ?? domKey.toLowerCase());
  const chord = (mods & (KEY_CTRL | KEY_ALT | KEY_SUPER)) !== 0;
  // Ctrl+С on a Cyrillic layout is Ctrl+C, as in native terminals.
  if (chord && !ASCII.test(base) && us) base = us[0];
  let shifted: string | undefined;
  if (event.shiftKey) {
    shifted = optionAlt ? us?.[1] : domKey;
    // Chrome on macOS reports Cmd+Shift+K as "k".
    if ((!shifted || shifted === base) && us && us[1] !== base) shifted = us[1];
    if (shifted === base) shifted = undefined;
  }
  return {
    key: "Char",
    char: base,
    ...(shifted ? { shifted } : {}),
    ...(kind !== "release" && !chord ? { text: domKey } : {}),
    mods,
    kind,
  };
}

// Command chords left to the browser and engine unless exclusive keyboard
// mode holds them: reload, address bar, tabs, windows, zoom, quit, hide,
// minimize, find, and select all (Ghostty binds the last two to itself too).
const BROWSER_COMMAND_CODES = new Set([
  "KeyR",
  "KeyL",
  "KeyT",
  "KeyW",
  "KeyN",
  "KeyQ",
  "KeyH",
  "KeyM",
  "KeyA",
  "KeyF",
  "Tab",
  "Backquote",
  "Equal",
  "Minus",
  "Comma",
  ...Array.from({ length: 10 }, (_, digit) => `Digit${digit}`),
]);

function browserKeepsKey(event: KeyboardEvent, apple: boolean): boolean {
  if (exclusiveKeyboardActive()) return false;
  return apple && event.metaKey && BROWSER_COMMAND_CODES.has(event.code);
}

let altSide: "left" | "right" | null = null;
let layout: ReadonlyMap<string, string> | null = null;
let tracking = false;

function trackKeyboardState() {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  const onAlt = (event: KeyboardEvent) => {
    if (event.code === "AltLeft" || event.code === "AltRight")
      altSide =
        event.type === "keydown"
          ? event.code === "AltLeft"
            ? "left"
            : "right"
          : null;
  };
  window.addEventListener("keydown", onAlt, { capture: true });
  window.addEventListener("keyup", onAlt, { capture: true });
  const loadLayout = () => {
    const keyboard = (
      navigator as Navigator & {
        keyboard?: {
          getLayoutMap?: () => Promise<ReadonlyMap<string, string>>;
        };
      }
    ).keyboard;
    keyboard
      ?.getLayoutMap?.()
      .then((map) => {
        layout = map;
      })
      .catch(() => {});
  };
  loadLayout();
  window.addEventListener("focus", loadLayout);
}

export type TerminalKeyHandlers = {
  apple: boolean;
  signal: AbortSignal;
  /** False while the pane takes no input; the engine's own gate applies. */
  accepts: () => boolean;
  /** Runs first for every key the listener sees. */
  keydown?: (event: KeyboardEvent) => void;
  /** Thyra's terminal shortcuts (copy, paste, scroll, configured keys). */
  shortcut: (event: KeyboardEvent) => boolean;
  send: (key: TerminalKey) => void;
};

/**
 * Takes hardware keys on `host` before the terminal engine sees them and
 * sends them as semantic keys, releases included.
 */
export function installTerminalKeyEvents(
  host: HTMLElement,
  handlers: TerminalKeyHandlers,
) {
  trackKeyboardState();
  const pressed = new Map<string, TerminalKey>();
  const context = (): TerminalKeyContext => ({
    apple: handlers.apple,
    optionAsAlt: optionAsAltNow(),
    altSide,
    layout,
  });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !handlers.accepts()) return;
    handlers.keydown?.(event);
    if (handlers.shortcut(event)) {
      event.stopPropagation();
      return;
    }
    // On-screen keyboards type through the engine, autocorrect included.
    if (
      keyboardKindNow() !== "hardware" &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    )
      return;
    if (browserKeepsKey(event, handlers.apple)) return;
    const key = terminalKeyFromEvent(event, context());
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    pressed.set(event.code, key);
    handlers.send(key);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    const key = pressed.get(event.code);
    if (!key) return;
    pressed.delete(event.code);
    event.preventDefault();
    event.stopPropagation();
    if (handlers.accepts()) {
      const release: TerminalKey = { ...key, kind: "release" };
      delete release.text;
      handlers.send(release);
    }
  };
  const options = { capture: true, signal: handlers.signal };
  host.addEventListener("keydown", onKeyDown, options);
  host.addEventListener("keyup", onKeyUp, options);
  host.addEventListener("focusout", () => pressed.clear(), {
    signal: handlers.signal,
  });
}
