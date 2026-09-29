import type { Terminal } from "@xterm/xterm";
import { useLayoutEffect } from "react";
export type TerminalMetrics = {
  left: number;
  top: number;
  width: number;
  rows: number;
  rowHeight: number;
  cellWidth: number;
  fontSize: number;
};

/** The terminal grid in the editor's coordinates (CSS zoom and follow scale included). */
export function measureTerminal(
  term: Terminal,
  host: HTMLElement | null,
): TerminalMetrics | null {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!host || !screen || !screen.offsetHeight || !term.rows || !term.cols)
    return null;
  const bounds = screen.getBoundingClientRect();
  const origin = host.getBoundingClientRect();
  const hostScaleX = host.offsetWidth ? origin.width / host.offsetWidth : 1;
  const hostScaleY = host.offsetHeight ? origin.height / host.offsetHeight : 1;
  const left = (bounds.left - origin.left) / hostScaleX;
  const scale = bounds.height / screen.offsetHeight / hostScaleY;
  return {
    left,
    top: (bounds.top - origin.top) / hostScaleY,
    width: Math.max(
      0,
      Math.min(bounds.width / hostScaleX, host.clientWidth - left),
    ),
    rows: term.rows,
    rowHeight: bounds.height / hostScaleY / term.rows,
    cellWidth: bounds.width / hostScaleX / term.cols,
    fontSize: (term.options.fontSize ?? 13) * scale,
  };
}

/** Rows a local editor covers, in the pane's coordinates. */
export type EditorSpan = { top: number; bottom: number };

/**
 * Reports what a local editor covers (null while hidden), so the pane's
 * floating touch controls can stand clear of it.
 */
export function useEditorSpan(
  top: number | null,
  height: number,
  onChange: (span: EditorSpan | null) => void,
) {
  const bottom = top === null ? null : top + height;
  useLayoutEffect(
    () => onChange(top === null || bottom === null ? null : { top, bottom }),
    [bottom, onChange, top],
  );
  useLayoutEffect(() => () => onChange(null), [onChange]);
}
