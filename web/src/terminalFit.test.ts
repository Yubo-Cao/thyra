import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { TerminalFit } from "./terminalRenderer";

test("fits the WebGL grid whichever renderer measured the cells", () => {
  const term = new Terminal({
    allowProposedApi: true,
    scrollback: 2000,
    scrollbar: { showScrollbar: false },
  });
  const parentElement = {};
  const element = {
    parentElement,
    ownerDocument: {
      defaultView: {
        devicePixelRatio: 2,
        getComputedStyle(target: unknown) {
          return {
            getPropertyValue(property: string) {
              if (target !== parentElement) return "0px";
              return property === "width" ? "1005px" : "500px";
            },
          };
        },
      },
    },
  };
  Object.assign(parentElement, { ownerDocument: element.ownerDocument });
  // The DOM renderer keeps a fractional device char width (15.6px); WebGL
  // floors it to 15px, so both must fit 7.5px CSS cells. The 41px device
  // cell height is the same in both renderers.
  const dimensions = {
    device: { char: { width: 15.6 }, cell: { height: 41 } },
  };
  Object.defineProperties(term, {
    element: { value: element },
    dimensions: { get: () => dimensions },
  });
  const fit = new TerminalFit();
  try {
    term.loadAddon(fit);
    // No gutter for xterm's hidden scrollbar.
    expect(fit.proposeDimensions()).toEqual({ cols: 134, rows: 24 });
    fit.fit();
    expect(term.cols).toBe(134);
    expect(term.rows).toBe(24);
    dimensions.device.char.width = 15;
    expect(fit.proposeDimensions()).toEqual({ cols: 134, rows: 24 });
    term.options.scrollbar = { showScrollbar: true, width: 14 };
    expect(fit.proposeDimensions()).toEqual({ cols: 132, rows: 24 });
  } finally {
    term.dispose();
  }
});
