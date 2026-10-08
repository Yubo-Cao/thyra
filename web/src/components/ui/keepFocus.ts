import type { MouseEvent } from "react";

/**
 * `onMouseDown` handler for a button that must not steal focus (from the
 * terminal or an editor, keeping the on-screen keyboard up). Cancel
 * mousedown, never pointerdown: WebKit, including iPad Safari, drops a tap's
 * click when its pointerdown is cancelled.
 */
export function keepFocus(event: Pick<MouseEvent, "preventDefault">) {
  event.preventDefault();
}
