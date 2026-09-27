// Find and select-all keep their default behavior in editable elements.
export { isEditableElement as isEditablePreviewTarget } from "../utils";

/**
 * True when a keyboard event comes from inside the preview or from a neutral
 * target (nothing else focused), so the preview may claim select-all.
 */
export function isPreviewKeyboardTarget(
  previewRoot: HTMLElement,
  target: EventTarget | null,
): boolean {
  if (target instanceof Node && previewRoot.contains(target)) return true;
  return (
    target === previewRoot.ownerDocument.body ||
    target === previewRoot.ownerDocument.documentElement
  );
}

/** Select all rendered content of a preview element. */
export function selectAllInPreviewElement(element: HTMLElement | null): void {
  if (!element) return;
  const selection = element.ownerDocument.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  selection.addRange(range);
}
