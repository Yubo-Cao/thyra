import type { TerminalEngine } from "../../terminalEngine";
import { type RefObject, useLayoutEffect } from "react";
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
  term: TerminalEngine,
  host: HTMLElement | null,
): TerminalMetrics | null {
  const screen = term.screenSize();
  if (!host || !screen.height || !term.rows || !term.cols) return null;
  const bounds = term.screenBounds();
  const origin = host.getBoundingClientRect();
  const hostScaleX = host.offsetWidth ? origin.width / host.offsetWidth : 1;
  const hostScaleY = host.offsetHeight ? origin.height / host.offsetHeight : 1;
  const left = (bounds.left - origin.left) / hostScaleX;
  const scale = bounds.height / screen.height / hostScaleY;
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

/**
 * How far to move the terminal up for `rows` of its rows, `rowHeight`
 * viewport pixels each: whole device pixels, since a fractional move
 * resamples (and blurs) the canvas. A row is a whole number of them.
 */
export function liftOffset(rows: number, rowHeight: number, ratio: number) {
  if (rows <= 0 || rowHeight <= 0) return 0;
  return Math.round(rows * rowHeight * ratio) / ratio;
}

/**
 * Moves the terminal up by `rows` rows while a local editor grows above the
 * agent's box, so the newest output shows above the editor rather than
 * under it. The pane keeps its size: the agent neither reflows nor sees
 * the move. `lifted` holds the rows moved, to measure the grid unmoved.
 */
export function useTerminalLift(
  term: TerminalEngine,
  rows: number,
  rowHeight: number,
  lifted: RefObject<number>,
) {
  useLayoutEffect(() => {
    if (rows <= 0) return;
    const element = term.element;
    const previous = element.style.translate;
    const offset = liftOffset(
      rows,
      term.rows ? term.screenBounds().height / term.rows : 0,
      window.devicePixelRatio || 1,
    );
    element.style.translate = `0 ${-offset}px`;
    lifted.current = rows;
    return () => {
      element.style.translate = previous;
      lifted.current = 0;
    };
  }, [lifted, rowHeight, rows, term]);
}
