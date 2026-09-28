import type { Terminal } from "@xterm/xterm";
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
