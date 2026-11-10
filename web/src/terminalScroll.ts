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

export type TerminalWheelRequest = TerminalWheelScroll & {
  terminal_id: string;
  column?: number;
  row?: number;
};

type WheelPoint = { x: number; y: number };

/**
 * Coalesces wheel scrolls into one request per animation frame: a trackpad
 * fires far more wheel events than frames. The first scroll of a burst goes
 * out at once; those that follow within the frame add up and go out when it
 * ends. Lines are summed per event, so the total equals what one request per
 * event would have scrolled, and a change of direction, terminal or pointer
 * position sends what is pending first so requests keep their order. The
 * cell under the pointer is measured once per request, not per event.
 */
export function createWheelScrollBatcher(
  send: (request: TerminalWheelRequest) => void,
  cellAt: (point: WheelPoint) => { column?: number; row?: number },
  schedule: (callback: () => void) => number = (callback) =>
    requestAnimationFrame(callback),
  unschedule: (handle: number) => void = (handle) =>
    cancelAnimationFrame(handle),
) {
  let pending: {
    terminalId: string;
    scroll: TerminalWheelScroll;
    point: WheelPoint;
  } | null = null;
  let frame: number | null = null;
  const sendPending = () => {
    const request = pending;
    pending = null;
    if (request)
      send({
        terminal_id: request.terminalId,
        ...request.scroll,
        ...cellAt(request.point),
      });
  };
  const onFrame = () => {
    frame = null;
    if (!pending) return;
    sendPending();
    // Scrolling goes on: keep to one request per frame.
    frame = schedule(onFrame);
  };
  return {
    push(terminalId: string, scroll: TerminalWheelScroll, point: WheelPoint) {
      if (
        pending &&
        (pending.terminalId !== terminalId ||
          pending.scroll.direction !== scroll.direction ||
          pending.point.x !== point.x ||
          pending.point.y !== point.y)
      )
        sendPending();
      if (pending) {
        pending.scroll.lines += scroll.lines;
        return;
      }
      pending = { terminalId, scroll: { ...scroll }, point };
      if (frame !== null) return;
      sendPending();
      frame = schedule(onFrame);
    },
    /** Sends what is pending and stops the frame loop. */
    dispose() {
      if (frame !== null) unschedule(frame);
      frame = null;
      sendPending();
    },
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
    // Endpoint sessions must distinguish these coordinate-less shortcuts
    // from a mouse wheel.
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
