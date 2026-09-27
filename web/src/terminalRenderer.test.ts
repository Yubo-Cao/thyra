import { expect, test } from "bun:test";
import { TERMINAL_FONT_CORE_STYLESHEET } from "./terminalFontStylesheet";
import {
  pinCellSize,
  terminalLigatureRanges,
  unrequestedGlyphs,
} from "./terminalRenderer";

test("joins programming ligatures, longest match first", () => {
  expect(terminalLigatureRanges("a => b")).toEqual([[2, 4]]);
  expect(terminalLigatureRanges("x !== y")).toEqual([[2, 5]]);
  expect(terminalLigatureRanges("<!-- -->")).toEqual([
    [0, 4],
    [5, 8],
  ]);
  expect(terminalLigatureRanges("plain text")).toEqual([]);
});

test("requests each non-ASCII glyph's font chunk only once", () => {
  expect(unrequestedGlyphs(["plain ascii", "中文 \ue0b0"])).toBe("中文\ue0b0");
  expect(unrequestedGlyphs(["中文 again", "新"])).toBe("新");
});

test("pins the bundled font's cell size on the device-pixel grid", () => {
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const stored = new Map<string, string>([
    [
      "thyra:terminalCellSize",
      JSON.stringify({
        font: TERMINAL_FONT_CORE_STYLESHEET,
        sizes: { 12: [7.2, 16] },
      }),
    ],
  ]);
  Object.defineProperties(globalThis, {
    devicePixelRatio: { value: 2, configurable: true },
    localStorage: {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    },
  });
  try {
    // A fallback font is on screen while the bundled one downloads.
    let measured = { width: 7.83, height: 15 };
    const service = {
      width: 0,
      height: 0,
      _measureStrategy: { measure: () => measured },
      measure() {
        Object.assign(this, this._measureStrategy.measure());
      },
    };
    const options = { fontFamily: '"Thyra Mono", monospace', fontSize: 13 };
    pinCellSize({ _core: { _charSizeService: service }, options } as never);
    // Maple Mono's nominal 0.6em advance and 17px box, floored to 7.5px.
    expect(service.width).toBeCloseTo(7.5, 5);
    expect(Math.floor(service.width * 2)).toBe(15);
    expect(service.height).toBe(17);
    // The font arriving later does not move the grid.
    measured = { width: 8, height: 18 };
    service.measure();
    expect(service.width).toBeCloseTo(7.5, 5);
    // A size measured on an earlier load wins over the nominal metrics.
    options.fontSize = 12;
    service.measure();
    expect(service.width).toBeCloseTo(7, 5);
    expect(service.height).toBe(16);
    // Other fonts keep their measurement, still on the device-pixel grid.
    options.fontFamily = '"JetBrains Mono", "Thyra Mono"';
    service.measure();
    expect(service.width).toBeCloseTo(8, 5);
    expect(service.height).toBe(18);
  } finally {
    for (const key of ["devicePixelRatio", "localStorage"]) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
