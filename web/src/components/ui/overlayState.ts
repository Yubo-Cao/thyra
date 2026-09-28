/**
 * Selectors for open overlays, for code outside them that must stand down
 * while one is up. Every modal (Dialog, ConfirmDialog, sheets, the Herdr
 * popup) renders the one shared underlay, `.ui-dialog-backdrop`.
 */
export const MODAL_OVERLAY_SELECTOR = ".ui-dialog-backdrop";

/** Overlays that own the keyboard while open: modals, menus, and pickers. */
export const KEYBOARD_OVERLAY_SELECTOR = [
  MODAL_OVERLAY_SELECTOR,
  ".ui-menu-popover",
  ".ui-select-popover",
  ".command-popover",
].join(", ");

export function keyboardOverlayOpen(): boolean {
  return !!document.querySelector(KEYBOARD_OVERLAY_SELECTOR);
}
