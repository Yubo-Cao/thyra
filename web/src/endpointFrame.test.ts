import { expect, test } from "bun:test";
import { headlessTerminal } from "./terminalEngine.fixture";
import { frameToAnsi } from "../../server/src/bridge/frame-to-ansi";
import type { FrameData } from "../../server/src/bridge/thin-client";

test.each(["中", "🙂", "👩‍💻", "🇨🇳", "ｶﾞ", "e\u0301"])(
  "keeps source columns and cursor after %s with production Unicode rendering",
  async (symbol) => {
    for (const cols of [5, 10]) {
      const term = await headlessTerminal(cols, 3);
      try {
        const frame: FrameData = {
          width: 5,
          height: 2,
          cursor: { x: 4, y: 0, visible: true, shape: 1 },
          hyperlinks: [],
          cells: ["a", symbol, " ", " ", "x", symbol, " ", " ", "x", " "].map(
            (symbol) => ({
              symbol,
              fg: 0,
              bg: 0,
              modifier: 0,
              skip: false,
              hyperlink: null,
            }),
          ),
        };
        term.write(frameToAnsi(frame));
        const first = term.line(0);
        const second = term.line(1);
        expect(first.getCell(0)?.getChars()).toBe("a");
        expect(first.getCell(1)?.getChars()).toBe(symbol);
        expect(first.getCell(3)?.getChars()).toBe(" ");
        expect(first.getCell(4)?.getChars()).toBe("x");
        expect(second.getCell(0)?.getChars()).toBe(symbol);
        expect(second.getCell(2)?.getChars()).toBe(" ");
        expect(second.getCell(3)?.getChars()).toBe("x");
        expect(term.cursor()).toMatchObject({ col: 4, row: 0 });
      } finally {
        term.dispose();
      }
    }
  },
);

test.each([10, 11, 14])(
  "a %i-column TUI frame never wraps or scrolls a 10-column viewport",
  async (width) => {
    const term = await headlessTerminal(10, 4);
    try {
      const lines = ["top", "item A", "item B", "bottom"].map(
        (text) => `|${text.padEnd(width - 2)}|`,
      );
      const frame: FrameData = {
        width,
        height: lines.length,
        cursor: null,
        hyperlinks: [],
        cells: Array.from(lines.join(""), (symbol) => ({
          symbol,
          fg: 0,
          bg: 0,
          modifier: 0,
          skip: false,
          hyperlink: null,
        })),
      };
      for (let repaint = 0; repaint < 2; repaint++) {
        term.write(frameToAnsi(frame, { cols: 10, rows: 4 }));
        for (let y = 0; y < lines.length; y++) {
          expect(term.line(y).translateToString(false)).toBe(
            lines[y].slice(0, 10),
          );
        }
        // The tail re-enables autowrap for whatever follows the frame.
        term.write("\r\n\x1b[4;1H1234567890+");
        expect(term.line(3).translateToString(true)).toBe("+");
      }
    } finally {
      term.dispose();
    }
  },
);

test("viewport clipping preserves the final column and row and hides outside cursors", async () => {
  const term = await headlessTerminal(10, 3);
  const lines = ["123456789AB", "abcdefghijk", "ABCDEFGHIJK", "bottom-row!"];
  const frame: FrameData = {
    width: 11,
    height: 4,
    cursor: { x: 10, y: 3, visible: true, shape: 1 },
    hyperlinks: [],
    cells: Array.from(lines.join(""), (symbol) => ({
      symbol,
      fg: 0,
      bg: 0,
      modifier: 0,
      skip: false,
      hyperlink: null,
    })),
  };
  try {
    const ansi = frameToAnsi(frame, { cols: 10, rows: 3 });
    expect(ansi).toEndWith("\x1b[?25l");
    term.write(ansi);
    for (let y = 0; y < 3; y++) {
      expect(term.line(y).translateToString()).toBe(lines[y].slice(0, 10));
    }
    frame.cells[9].symbol = "中";
    frame.cells[10].symbol = " ";
    term.write(frameToAnsi(frame, { cols: 10, rows: 3 }));
    expect(term.line(0).translateToString()).toBe("123456789 ");
    expect(term.line(1).translateToString()).toBe(lines[1].slice(0, 10));
  } finally {
    term.dispose();
  }
});

test("endpoint repaints clear shortened text, blank rows, and a smaller pane", async () => {
  const term = await headlessTerminal(10, 3);
  try {
    for (const [text, width, height] of [
      ["abcdefghij".repeat(3), 10, 3],
      ["abc", 10, 3],
      ["x", 2, 1],
      ["", 2, 1],
    ] as const) {
      const frame: FrameData = {
        width,
        height,
        cursor: null,
        hyperlinks: [],
        cells: Array.from(text.padEnd(width * height), (symbol) => ({
          symbol,
          fg: 0,
          bg: 0,
          modifier: 0,
          skip: false,
          hyperlink: null,
        })),
      };
      term.write(frameToAnsi(frame));
      for (let y = 0; y < 3; y++) {
        expect(term.line(y).translateToString(true)).toBe(
          text.slice(y * width, (y + 1) * width),
        );
      }
    }
  } finally {
    term.dispose();
  }
});
