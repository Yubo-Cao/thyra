import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL_FONT_OPTIONS } from "./appearance";
import {
  decodeFontRanges,
  encodeFontRanges,
  isTerminalFontManifest,
  parseFontFaceRules,
  terminalFontManifestRules,
} from "../../shared/terminalFontManifest";
import {
  TERMINAL_FONT_CORE_FACES,
  TERMINAL_FONT_CORE_STYLESHEET,
  TERMINAL_FONT_MANIFEST,
  TERMINAL_FONT_STYLESHEET,
} from "../../shared/terminalFontStylesheet";
import {
  preEngineTextInput,
  sgrStyle,
  TerminalTextScreen,
  terminalPaletteColor,
  terminalTextCss,
} from "./terminalEngine";
import {
  parseTerminalFontChunks,
  sortTerminalFontChunks,
  terminalCoreCovers,
  terminalCoreFontManifest,
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

test("finds every chunk of overlapping faces, in the list's order", () => {
  const chunks = [
    ...parseTerminalFontChunks(
      face("regular-a", "normal", 400, "U+4E00-4E7F,U+2500") +
        face("regular-b", "normal", 400, "U+4E80-4EFF,U+2501-257F") +
        face("bold", "normal", 700, "U+2500-257F,U+4E00-4EFF") +
        face("italic", "italic", 400, "U+4E40-4EBF"),
      false,
    ),
  ];
  const urls = (text: string) =>
    terminalFontChunksFor(chunks, text, new Set()).map((chunk) => chunk.url);
  expect(urls("\u4e00")).toEqual(["/f/regular-a.woff2", "/f/bold.woff2"]);
  expect(urls("\u4e80\u2500")).toEqual([
    "/f/regular-a.woff2",
    "/f/regular-b.woff2",
    "/f/bold.woff2",
    "/f/italic.woff2",
  ]);
  expect(urls("\u4ebf")).toEqual([
    "/f/regular-b.woff2",
    "/f/bold.woff2",
    "/f/italic.woff2",
  ]);
  expect(urls("\u4f00\u24ff\u{1f600}")).toEqual([]);
});

test("range lists survive the manifest's encoding", () => {
  const ranges: [number, number][] = [
    [0, 0],
    [0x20, 0x7e],
    [0x7f, 0x7f],
    [0x4e00, 0x4e05],
    [0xf0000, 0x10fffd],
  ];
  expect(encodeFontRanges(ranges)).toBe("0,w-2m,1,fb5-5,kn3v-2t4t");
  expect(decodeFontRanges(encodeFontRanges(ranges))).toEqual(ranges);
  expect(decodeFontRanges("")).toEqual([]);
});

test("the slice manifest and the embedded core match the stylesheets", () => {
  const read = (url: string) => readFileSync(join(publicDir, url), "utf8");
  const manifest: unknown = JSON.parse(read(TERMINAL_FONT_MANIFEST));
  if (!isTerminalFontManifest(manifest)) throw new Error("not a manifest");
  const rest = parseFontFaceRules(read(TERMINAL_FONT_STYLESHEET));
  expect(rest.length).toBeGreaterThan(500);
  expect(terminalFontManifestRules(manifest)).toEqual(rest);
  // A twelfth of the stylesheet the terminal used to fetch and parse.
  expect(read(TERMINAL_FONT_MANIFEST).length).toBeLessThan(
    read(TERMINAL_FONT_STYLESHEET).length / 4,
  );

  const core = parseFontFaceRules(read(TERMINAL_FONT_CORE_STYLESHEET));
  expect(
    TERMINAL_FONT_CORE_FACES.map(([url, weight, italic, ranges]) => ({
      url,
      weight,
      italic: italic === 1,
      ranges: decodeFontRanges(ranges),
    })),
  ).toEqual(core);
  expect(
    terminalCoreFontManifest()
      .filter((chunk) => chunk.core)
      .map((chunk) => chunk.url),
  ).toEqual(core.map((rule) => rule.url));
  expect(terminalCoreCovers("plain ASCII, caf\u00e9 \ue0b0")).toBe(true);
  expect(terminalCoreCovers("\u2500")).toBe(false);
  expect(terminalCoreCovers("\u4e2d")).toBe(false);
});

test("text composed before the engine runs is sent once", () => {
  const sent: string[] = [];
  const event = (inputType: string, data: string | null, isComposing = false) =>
    ({ inputType, data, isComposing }) as InputEvent;
  let input = preEngineTextInput((text) => sent.push(text));
  // Chrome: the composing input event comes first.
  input.input(event("insertCompositionText", "\u4f60\u597d", true));
  input.compositionEnd("\u4f60\u597d");
  expect(sent).toEqual(["\u4f60\u597d"]);
  // Typing afterwards is unaffected.
  input.input(event("insertText", "a"));
  input.input(event("insertLineBreak", null));
  input.input(event("deleteContentBackward", null));
  expect(sent).toEqual(["\u4f60\u597d", "a", "\r", "\x7f"]);

  // Safari and Firefox: an input event repeats the text after the end.
  for (const type of ["insertFromComposition", "insertCompositionText"]) {
    sent.length = 0;
    input = preEngineTextInput((text) => sent.push(text));
    input.compositionEnd("\u4e2d");
    input.input(event(type, "\u4e2d"));
    expect(sent).toEqual(["\u4e2d"]);
    // The same text composed again is new input.
    input.compositionEnd("\u4e2d");
    input.input(event(type, "\u4e2d"));
    expect(sent).toEqual(["\u4e2d", "\u4e2d"]);
  }

  // A commit reported only by its input event still arrives.
  sent.length = 0;
  input = preEngineTextInput((text) => sent.push(text));
  input.input(event("insertCompositionText", "\u6587"));
  expect(sent).toEqual(["\u6587"]);
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
