/** A terminal's grid: the engine knows its cell area, xterm its padded element. */
type CellGrid = {
  cols: number;
  rows: number;
  element?: HTMLElement | null;
  screenBounds?: () => DOMRect;
};

export type TerminalScroll = {
  direction: "up" | "down";
  lines: number;
  source: "wheel" | "page-key" | "history";
};

export type TerminalWheelScroll = TerminalScroll & { source: "wheel" };

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** Normalizes browser wheel units into Herdr's terminal scroll request shape. */
export function terminalWheelScroll(
  deltaY: number,
  deltaMode: number,
  rows: number,
): TerminalWheelScroll | null {
  if (deltaY === 0) return null;

  const lines =
    deltaMode === DOM_DELTA_PAGE
      ? Math.max(1, rows)
      : deltaMode === DOM_DELTA_LINE
        ? Math.max(1, Math.ceil(Math.abs(deltaY)))
        : deltaMode === DOM_DELTA_PIXEL
          ? Math.max(1, Math.ceil(Math.abs(deltaY) / 40))
          : Math.max(1, Math.ceil(Math.abs(deltaY)));

  return {
    direction: deltaY < 0 ? "up" : "down",
    lines,
    source: "wheel",
  };
}

/** Full pages let Herdr route the key; half pages explicitly scroll history. */
export function terminalPageScroll(
  direction: "up" | "down",
  rows: number,
  amount: "full" | "half" = "full",
): TerminalScroll {
  const viewportLines = Math.max(1, rows - 2);
  return {
    direction,
    lines:
      amount === "half"
        ? Math.max(1, Math.floor(viewportLines / 2))
        : viewportLines,
    // The bridge retains legacy wheel semantics for half pages, but endpoint
    // sessions must distinguish these coordinate-less shortcuts from a mouse.
    source: amount === "full" ? "page-key" : "history",
  };
}

/**
 * The terminal cell under a client point. Herdr uses the cell to pick which
 * pane a wheel event belongs to, so a scroll request carries it alongside the
 * direction and line count. Returns an empty object when the geometry is not
 * measurable yet (no element, or a zero-sized view), which the callers spread
 * into the request as "no cell".
 */
export function terminalCellAtPoint(
  term: CellGrid,
  clientX: number,
  clientY: number,
) {
  const element = term.element;
  if (!element || term.cols <= 0 || term.rows <= 0) return {};
  let { left, top, width, height } = element.getBoundingClientRect();
  if (term.screenBounds) {
    ({ left, top, width, height } = term.screenBounds());
  } else {
    const style = window.getComputedStyle(element);
    const px = (value: string) => Number.parseFloat(value) || 0;
    left += px(style.paddingLeft);
    top += px(style.paddingTop);
    width -= px(style.paddingLeft) + px(style.paddingRight);
    height -= px(style.paddingTop) + px(style.paddingBottom);
  }
  if (width <= 0 || height <= 0) return {};

  const x = clientX - left;
  const y = clientY - top;
  const column = Math.max(
    0,
    Math.min(term.cols - 1, Math.floor(x / (width / term.cols))),
  );
  const row = Math.max(
    0,
    Math.min(term.rows - 1, Math.floor(y / (height / term.rows))),
  );
  return { column, row };
}

export function terminalCellAt(term: CellGrid, e: WheelEvent) {
  return terminalCellAtPoint(term, e.clientX, e.clientY);
}
