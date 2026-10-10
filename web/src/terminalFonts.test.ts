import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL_FONT_OPTIONS } from "./appearance";
import {
  sgrStyle,
  TerminalTextScreen,
  terminalPaletteColor,
  terminalTextCss,
} from "./terminalEngine";
import {
  parseTerminalFontChunks,
  sortTerminalFontChunks,
  terminalFontChunksFor,
} from "./terminalFonts";
import {
  terminalFontPreset,
  terminalPresetFontData,
} from "./terminalFontPresets";

const publicDir = join(import.meta.dir, "../public");

const face = (file: string, style: string, weight: number, range: string) =>
  `@font-face{font-family:"Thyra Mono";src:url("/f/${file}.woff2")format("woff2");font-style:${style};font-display:swap;font-weight:${weight};unicode-range:${range};}`;

test("parses unicode-range chunks and finds each new character's chunk once", () => {
  const chunks = parseTerminalFontChunks(
    face("cjk", "normal", 400, "U+4E00-4E2D,U+6587") +
      face("latin", "normal", 400, "U+20-7E"),
    false,
  );
  expect(chunks[0]).toMatchObject({
    url: "/f/cjk.woff2",
    weight: 400,
    italic: false,
    ranges: [
      [0x4e00, 0x4e2d],
      [0x6587, 0x6587],
    ],
  });
  const seen = new Set<number>();
  expect(terminalFontChunksFor(chunks, "ascii 中文", seen)).toEqual([
    chunks[0]!,
  ]);
  expect(terminalFontChunksFor(chunks, "中文 again", seen)).toEqual([]);
});

test("orders regular before bold before italic, with the ASCII chunk first", () => {
  const [ascii, latin1, bold, italic, cjk] = [
    ...parseTerminalFontChunks(
      face("ascii", "normal", 400, "U+20-7E") +
        face("latin1", "normal", 400, "U+A0-FF") +
        face("bold", "normal", 700, "U+20-7E") +
        face("italic", "italic", 400, "U+20-7E"),
      true,
    ),
    ...parseTerminalFontChunks(face("cjk", "normal", 400, "U+4E00"), false),
  ];
  expect(
    sortTerminalFontChunks([italic!, cjk!, bold!, latin1!, ascii!]).map(
      (chunk) => chunk.url,
    ),
  ).toEqual([
    "/f/ascii.woff2",
    "/f/latin1.woff2",
    "/f/cjk.woff2",
    "/f/bold.woff2",
    "/f/italic.woff2",
  ]);
});

test("the text preview follows full repaints, row updates and plain streams", () => {
  const screen = new TerminalTextScreen();
  screen.write(
    "\x1b[0m\x1b[H\x1b[2J\x1b[?7l\x1b[1mone\x1b[2;1Htwo\x1b]8;;x\x07link\x1b]8;;\x07\x1b[?7h\x1b[1;3H",
  );
  expect(screen.text).toBe("one\ntwolink");
  screen.write("\x1b[0m\x1b[?7l\x1b[2;1H\x1b[0m\x1b[2KTWO\x1b[?7h");
  expect(screen.text).toBe("one\nTWO");
  screen.write("\r\nthree\r\n");
  expect(screen.text).toBe("one\nTWO\nthree\n");
});

test("the text preview keeps SGR runs per row, as the grid colours them", () => {
  const screen = new TerminalTextScreen();
  screen.write("\x1b[H\x1b[2J\x1b[1;31mred\x1b[22m plain\x1b[0m end");
  expect(screen.lines[0]!.map((run) => [run.text, run.style])).toEqual([
    ["red", { bold: true, fg: 1 }],
    [" plain", { bold: false, faint: false, fg: 1 }],
    [" end", {}],
  ]);
  expect(screen.rowText(0)).toBe("red plain end");
  expect(sgrStyle({}, "38;5;196;48;2;1;2;3")).toEqual({
    fg: 196,
    bg: "rgb(1, 2, 3)",
  });
  expect(sgrStyle({}, "38:2::4:5:6;4:0;93")).toEqual({
    fg: 11,
    underline: false,
  });
});

test("preview runs paint with the theme's palette and restty's emphasis", () => {
  const theme = { foreground: "#eee", background: "#111", red: "#f00" };
  expect(terminalPaletteColor(1, theme)).toBe("#f00");
  expect(terminalPaletteColor(2, theme)).toBe("#4e9a06");
  expect(terminalPaletteColor(196, theme)).toBe("rgb(255, 0, 0)");
  expect(terminalPaletteColor(244, theme)).toBe("rgb(128, 128, 128)");
  expect(terminalTextCss({}, theme)).toBeNull();
  expect(terminalTextCss({ fg: 1, bg: "rgb(1, 2, 3)" }, theme)).toEqual({
    color: "#f00",
    background: "rgb(1, 2, 3)",
  });
  expect(terminalTextCss({ inverse: true, faint: true }, theme)).toEqual({
    color: "color-mix(in srgb, #111 60%, transparent)",
    background: "#eee",
  });
  expect(terminalTextCss({ bold: true }, {})).toEqual({
    color: "color-mix(in srgb, var(--terminal-fg) 82%, white)",
    fontWeight: "bold",
  });
});

test("every font preset ships its files, regular first", () => {
  for (const { value, fontFamily } of TERMINAL_FONT_OPTIONS) {
    const preset = terminalFontPreset(value);
    if (!value) {
      expect(preset).toBeNull();
      continue;
    }
    // DOM text names the same family (TerminalEngine.cssFontFamily).
    expect(`"${preset?.family}"`).toBe(fontFamily);
    expect(preset?.faces[0]).toMatchObject({ weight: 400, italic: false });
    for (const face of preset!.faces)
      expect(existsSync(join(publicDir, face.url))).toBe(true);
  }
  expect(terminalFontPreset("constructor")).toBeNull();
});

test("a preset's faces wait for the network unless already loaded", async () => {
  expect(await terminalPresetFontData("fira-code", false)).toEqual([]);
  expect(await terminalPresetFontData("", true)).toEqual([]);
});

test("the text preview follows the screen's cursor", () => {
  const screen = new TerminalTextScreen();
  screen.write("$ ls\r\nab你");
  expect(screen.cursor).toEqual({ row: 1, col: 4, visible: true });
  screen.write("\x1b[3;7H");
  expect(screen.cursor).toEqual({ row: 2, col: 6, visible: true });
  screen.write("\x1b[?25l");
  expect(screen.cursor.visible).toBe(false);
  screen.write("\x1b[2J\x1b[?25h");
  expect(screen.cursor).toEqual({ row: 0, col: 0, visible: true });
});
