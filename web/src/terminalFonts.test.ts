import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL_FONT_OPTIONS } from "./appearance";
import { TerminalTextScreen } from "./terminalEngine";
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
