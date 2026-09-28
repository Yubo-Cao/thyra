import { thyraLocalStorage } from "./browserStorage";
import { msg } from "./i18n";
import { PANE_SWIPE_KEY, type PaneSwipeFingers } from "./touchGestures";

// The pane swipe's preferences. The finger count is read on every touch, so
// its getter stays with the eager recognizer (touchGestures.ts); the rest is
// only needed by the settings and the lazily loaded drag.

export const PANE_SWIPE_OPTIONS = [
  { value: "2", label: msg("Two fingers") },
  { value: "3", label: msg("Three fingers") },
  { value: "4", label: msg("Four fingers") },
  { value: "0", label: msg("Off") },
];

export function setPaneSwipeFingers(fingers: PaneSwipeFingers) {
  thyraLocalStorage.setItem(PANE_SWIPE_KEY, String(fingers));
}

const REVERSE_KEY = "paneSwipeReversed";

/**
 * Whether dragging to the right moves to the next pane. By default the panes
 * sit side by side: dragging right reveals the previous pane on the left.
 */
export function paneSwipeReversed(): boolean {
  return thyraLocalStorage.getItem(REVERSE_KEY) === "1";
}

export function setPaneSwipeReversed(reversed: boolean) {
  if (reversed) thyraLocalStorage.setItem(REVERSE_KEY, "1");
  else thyraLocalStorage.removeItem(REVERSE_KEY);
}
