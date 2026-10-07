import {
  KEY_ALT,
  KEY_CTRL,
  KEY_SHIFT,
  type TerminalKey,
} from "../../shared/terminalKey";
import { matchesShortcut, type ShortcutBindings } from "./shortcutBindings";
type TerminalKeyEvent = Pick<
  KeyboardEvent,
  | "type"
  | "key"
  | "code"
  | "keyCode"
  | "shiftKey"
  | "altKey"
  | "ctrlKey"
  | "metaKey"
  | "isComposing"
>;

const ctrl = (char: string): TerminalKey => ({
  key: "Char",
  char,
  mods: KEY_CTRL,
});
/** The key each configurable terminal action types into the pane. */
const ACTION_KEYS = {
  "terminal.multiline": { key: "Enter", mods: KEY_SHIFT },
  "terminal.altEnter": { key: "Enter", mods: KEY_ALT },
  "terminal.ctrlEnter": { key: "Enter", mods: KEY_CTRL },
  "terminal.lineStart": ctrl("a"),
  "terminal.lineEnd": ctrl("e"),
  "terminal.deleteToStart": ctrl("u"),
} as const satisfies Record<string, TerminalKey>;

/** The pane key a configured terminal action sends for this key press. */
export function terminalShortcutKey(
  event: TerminalKeyEvent,
  bindings: ShortcutBindings,
): TerminalKey | null {
  if (event.type !== "keydown" || event.isComposing || event.keyCode === 229)
    return null;
  for (const id of Object.keys(ACTION_KEYS) as (keyof typeof ACTION_KEYS)[]) {
    if (matchesShortcut(event, id, bindings)) return { ...ACTION_KEYS[id] };
  }
  return null;
}
