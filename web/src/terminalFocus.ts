/**
 * Guards the terminal's frame-driven refocusing. Terminal frames refocus the
 * xterm textarea so keyboard input keeps working, but doing so while an
 * overlay owns focus dismisses it: a non-modal popover closes when focus
 * leaves it. The
 * Workspace Inspector likewise owns keyboard focus while browsing resources,
 * as does the pane switcher while its search field is open. Streaming output
 * must not steal focus from any of those surfaces.
 */
const TERMINAL_FOCUS_OVERLAY_SELECTOR =
  '.ui-popover, .modal-backdrop, .workspace-tree-panel, .workspace-inspector, .tabbar-utilities, .mobile-nav, .pane-jump-backdrop, .popup-overlay-backdrop, [role="dialog"], [role="menu"]';
const OPEN_POPOVER = ".ui-popover";

type FocusableLike = Pick<Element, "closest">;
type DocumentLike = Pick<Document, "querySelector">;

export function terminalTouchShouldDismissInput(
  started: boolean,
  moved: boolean,
  inputActive: boolean,
): boolean {
  return started && !moved && inputActive;
}

/**
 * Whether a tap should open the device keyboard. Agent CLIs keep their input
 * box on the last rows around the cursor, so a tap there means "type here";
 * taps higher up are for reading and selecting.
 */
export function terminalTapOpensInput(
  tapRow: number,
  rows: number,
  cursorRow: number | null,
): boolean {
  if (rows <= 0 || tapRow < 0) return false;
  const bottomBand = Math.max(3, Math.ceil(rows * 0.3));
  return (
    tapRow >= rows - bottomBand ||
    (cursorRow !== null && Math.abs(tapRow - cursorRow) <= 2)
  );
}

export function terminalPointerShouldBlurInput(
  coarsePointer: boolean,
  editableTarget: boolean,
  targetInsideTerminal: boolean,
): boolean {
  return coarsePointer && !editableTarget && !targetInsideTerminal;
}

export function terminalFocusBlockedByOverlay(
  activeElement: FocusableLike | null,
  doc: DocumentLike,
): boolean {
  // An open popover is mounted in a portal. Block even before focus lands
  // inside it (the open-animation frame), so a terminal frame cannot win that
  // race and dismiss the popover. Closed popovers unmount.
  if (doc.querySelector(OPEN_POPOVER)) return true;
  if (!activeElement) return false;
  return Boolean(activeElement.closest(TERMINAL_FOCUS_OVERLAY_SELECTOR));
}
