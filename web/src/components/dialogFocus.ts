/** Returns false while the target is unmounted; otherwise consumes the request. */
export function focusIfUnchanged(
  target: HTMLElement | null,
  source: Element | null,
): boolean {
  if (!target) return false;
  const document = target.ownerDocument;
  if (
    document.activeElement === source ||
    (source && !source.isConnected && document.activeElement === document.body)
  ) {
    target.focus({ preventScroll: true });
  }
  return true;
}
