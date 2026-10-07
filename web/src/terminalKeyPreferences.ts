import { createStore, useStore } from "zustand";
import { thyraLocalStorage } from "./browserStorage";

/**
 * Which macOS Option keys act as Alt in the terminal, as Ghostty's
 * `macos-option-as-alt`: Option+f sends Alt+f instead of typing "ƒ". The
 * other Option key keeps composing characters.
 */
export type OptionAsAlt = "left" | "right" | "both" | "off";
export const OPTION_AS_ALT_VALUES: OptionAsAlt[] = [
  "left",
  "right",
  "both",
  "off",
];
export const OPTION_AS_ALT_STORAGE_KEY = "terminal.optionAsAlt";

export function parseOptionAsAlt(raw: string | null): OptionAsAlt {
  return OPTION_AS_ALT_VALUES.includes(raw as OptionAsAlt)
    ? (raw as OptionAsAlt)
    : "left";
}

const optionStore = createStore<{ optionAsAlt: OptionAsAlt }>()(() => ({
  optionAsAlt: parseOptionAsAlt(
    thyraLocalStorage.getItem(OPTION_AS_ALT_STORAGE_KEY),
  ),
}));

export function optionAsAltNow(): OptionAsAlt {
  return optionStore.getState().optionAsAlt;
}

export function setOptionAsAlt(optionAsAlt: OptionAsAlt) {
  optionStore.setState({ optionAsAlt });
  thyraLocalStorage.setItem(OPTION_AS_ALT_STORAGE_KEY, optionAsAlt);
}

export function useOptionAsAlt(): OptionAsAlt {
  return useStore(optionStore, (state) => state.optionAsAlt);
}

type KeyboardLock = {
  lock?: (codes?: string[]) => Promise<void>;
  unlock?: () => void;
};

function keyboardLock(): KeyboardLock | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
}

/** Keyboard Lock (Chromium) holds browser shortcuts only in fullscreen. */
export function exclusiveKeyboardSupported(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof keyboardLock()?.lock === "function" &&
    typeof document.documentElement.requestFullscreen === "function"
  );
}

const exclusiveStore = createStore<{ active: boolean }>()(() => ({
  active: false,
}));
let fullscreenWatched = false;

/** True while the page holds every key, browser shortcuts included. */
export function exclusiveKeyboardActive(): boolean {
  return exclusiveStore.getState().active;
}

export function useExclusiveKeyboard(): boolean {
  return useStore(exclusiveStore, (state) => state.active);
}

/**
 * Enters fullscreen and locks the keyboard, so Cmd/Ctrl+W, T, N and the
 * like reach the pane. Holding Escape leaves, as the browser announces.
 */
export async function enterExclusiveKeyboard() {
  if (!exclusiveKeyboardSupported()) return;
  if (!fullscreenWatched) {
    fullscreenWatched = true;
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement) return;
      keyboardLock()?.unlock?.();
      exclusiveStore.setState({ active: false });
    });
  }
  if (!document.fullscreenElement)
    await document.documentElement.requestFullscreen();
  await keyboardLock()!.lock!();
  exclusiveStore.setState({ active: true });
}

export async function exitExclusiveKeyboard() {
  keyboardLock()?.unlock?.();
  exclusiveStore.setState({ active: false });
  if (document.fullscreenElement) await document.exitFullscreen();
}
