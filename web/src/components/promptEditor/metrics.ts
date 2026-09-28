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
  const scale = bounds.height / screen.offsetHeight;
  return {
    left: bounds.left - origin.left,
    top: bounds.top - origin.top,
    width: bounds.width,
    rows: term.rows,
    rowHeight: bounds.height / term.rows,
    cellWidth: bounds.width / term.cols,
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
