import { createStore, useStore } from "zustand";
import { useEffect } from "react";
import { thyraLocalStorage } from "./browserStorage";
import { coarsePrimaryPointer } from "./localEditorPolicy";
import { isEditableElement } from "./utils";

/**
 * Whether a touch-first device (an iPad) types on a hardware keyboard. With
 * one, the local editors focus themselves like on a desktop; with the
 * on-screen keyboard (or before we know), a focus would raise the keyboard
 * unasked, so they wait for a tap. Desktops always count as hardware.
 */
export type KeyboardKind = "unknown" | "hardware" | "software";

export const KEYBOARD_KIND_STORAGE_KEY = "keyboardKind";
/** The on-screen keyboard takes at least this much of the visual viewport. */
export const SOFTWARE_KEYBOARD_MIN_SHRINK_PX = 150;
/** How long after a focus the keyboard (or the shortcut bar) settles. */
export const KEYBOARD_SETTLE_MS = 600;

// Keys an on-screen keyboard does not send.
const HARDWARE_KEYS = new Set([
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
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);

export type KeyEvidenceEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  isTrusted?: boolean;
};

export function parseKeyboardKind(raw: string | null): KeyboardKind {
  return raw === "hardware" || raw === "software" ? raw : "unknown";
}

/**
 * A key press proves a hardware keyboard when nothing editable has focus
 * (an on-screen keyboard only exists for a focused field) or when it is a
 * modifier chord or a navigation key the on-screen keyboard lacks. IME
 * composition and synthesized events prove nothing.
 */
export function keydownEvidence(
  event: KeyEvidenceEvent,
  editableFocused: boolean,
): "hardware" | null {
  if (event.isTrusted === false) return null;
  if (event.isComposing || event.keyCode === 229) return null;
  if (!editableFocused) return "hardware";
  if (event.metaKey || event.ctrlKey || event.altKey) return "hardware";
  return HARDWARE_KEYS.has(event.key) ? "hardware" : null;
}

/**
 * What the visual viewport did in the moments after a text field took
 * focus: the on-screen keyboard takes a large part of it, while a hardware
 * keyboard only brings iPadOS's small shortcut bar. No change proves nothing.
 */
export function viewportEvidence(
  baselineHeight: number,
  settledHeight: number,
): "hardware" | "software" | null {
  const shrink = baselineHeight - settledHeight;
  if (shrink >= SOFTWARE_KEYBOARD_MIN_SHRINK_PX) return "software";
  return shrink > 0 ? "hardware" : null;
}

type DetectorEnvironment = {
  viewportHeight(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  report(kind: "hardware" | "software"): void;
};

/** Turns key, focus, and viewport events into keyboard verdicts. */
export function createKeyboardDetector(env: DetectorEnvironment) {
  let baseline: number | null = null;
  let lowest = Number.POSITIVE_INFINITY;
  let timer: unknown = null;
  const stop = () => {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
    baseline = null;
  };
  const settle = () => {
    const start = baseline;
    stop();
    if (start === null) return;
    const verdict = viewportEvidence(start, lowest);
    if (verdict) env.report(verdict);
  };
  return {
    keydown(event: KeyEvidenceEvent, editableFocused: boolean) {
      const verdict = keydownEvidence(event, editableFocused);
      if (verdict) env.report(verdict);
    },
    /** A text field took focus: watch the viewport while a keyboard shows. */
    focus() {
      stop();
      baseline = env.viewportHeight();
      lowest = baseline;
      timer = env.setTimeout(settle, KEYBOARD_SETTLE_MS);
    },
    viewportResize() {
      if (baseline === null) return;
      lowest = Math.min(lowest, env.viewportHeight());
      // The on-screen keyboard is certain as soon as it is this tall.
      if (baseline - lowest >= SOFTWARE_KEYBOARD_MIN_SHRINK_PX) settle();
    },
    dispose: stop,
  };
}

// The last verdict on this device is the best guess until new evidence.
const keyboardStore = createStore<{ kind: KeyboardKind }>()(() => ({
  kind: parseKeyboardKind(thyraLocalStorage.getItem(KEYBOARD_KIND_STORAGE_KEY)),
}));
let started = false;

function report(kind: "hardware" | "software") {
  if (keyboardStore.getState().kind === kind) return;
  keyboardStore.setState({ kind });
  thyraLocalStorage.setItem(KEYBOARD_KIND_STORAGE_KEY, kind);
}

// The on-screen keyboard shows for our editors and the terminal.
const WATCHED_INPUTS = ".prompt-editor, .shell-editor, .xterm";
// The mobile shortcut bar sends bytes, not keys; never count its presses.
const SHORTCUT_BAR = ".terminal-mobile-keys, .terminal-mobile-side-shortcuts";

/** Starts listening on a touch-first device; idempotent. */
export function startKeyboardDetection() {
  if (started || typeof window === "undefined") return;
  started = true;
  const viewport = window.visualViewport;
  const detector = createKeyboardDetector({
    viewportHeight: () => viewport?.height ?? window.innerHeight,
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    report,
  });
  window.addEventListener(
    "keydown",
    (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(SHORTCUT_BAR)) return;
      detector.keydown(event, isEditableElement(document.activeElement));
    },
    { capture: true },
  );
  const watch = (event: Event) => {
    const target = event.target;
    if (
      isEditableElement(target) &&
      target instanceof Element &&
      target.closest(WATCHED_INPUTS)
    )
      detector.focus();
  };
  document.addEventListener("focusin", watch);
  // A tap on a field that already has focus raises a hidden keyboard too.
  document.addEventListener("pointerup", watch, { capture: true });
  viewport?.addEventListener("resize", () => detector.viewportResize());
}

/** The keyboard verdict now, outside React. */
export function keyboardKindNow(): KeyboardKind {
  return coarsePrimaryPointer() ? keyboardStore.getState().kind : "hardware";
}

/** The keyboard verdict; desktops (fine pointers) always type on hardware. */
export function useKeyboardKind(): KeyboardKind {
  const coarse = coarsePrimaryPointer();
  useEffect(() => {
    if (coarse) startKeyboardDetection();
  }, [coarse]);
  const kind = useStore(keyboardStore, (state) => state.kind);
  return coarse ? kind : "hardware";
}
