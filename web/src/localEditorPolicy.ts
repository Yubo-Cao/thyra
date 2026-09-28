/**
 * When the local editors (the agent prompt editor and the shell command line)
 * appear, and how they take focus on touch-first devices.
 */

type MatchMediaWindow = {
  matchMedia?: (query: string) => { matches: boolean };
};

/**
 * A touch-first device: its primary pointer is a finger. iPads stay touch
 * first with a hardware keyboard or trackpad attached.
 */
export function coarsePrimaryPointer(
  target: MatchMediaWindow | undefined = typeof window === "undefined"
    ? undefined
    : window,
): boolean {
  return !!target?.matchMedia?.("(pointer: coarse)").matches;
}

/**
 * The editors belong to the desktop layout, whatever the pointer: a tablet
 * in the desktop layout has no mobile composer, so it needs them most on a
 * slow link. The mobile layout keeps its own composer.
 */
export function localEditorsAvailable(mobileLayout: boolean): boolean {
  return !mobileLayout;
}

/**
 * Whether focus may move on the user's behalf: always on a desktop, and on a
 * touch device only with a hardware keyboard. Otherwise a focus would raise
 * the on-screen keyboard unasked (or drop it), so focus follows taps only.
 */
export function programmaticFocusAllowed(
  coarsePointer: boolean,
  keyboard: "unknown" | "hardware" | "software",
): boolean {
  return !coarsePointer || keyboard === "hardware";
}

type ContainsElement = { contains(other: unknown): boolean };

/**
 * Whether an editor may focus itself when it appears (not on a user tap):
 * when focus may move at all, and nothing else editable has it (nothing, the
 * page, or the pane's own terminal).
 */
export function editorMayTakeFocus(
  focused: unknown,
  body: unknown,
  terminal: ContainsElement | null | undefined,
  focusAllowed: boolean,
): boolean {
  if (!focusAllowed) return false;
  return !focused || focused === body || !!terminal?.contains(focused);
}
