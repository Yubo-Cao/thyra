import {
  decodeFontRanges,
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

/**
 * The bundled terminal font (Maple Mono NF CN, see
 * scripts/build-terminal-font.ts) is sliced into small woff2 chunks with
 * unicode-range rules. The GPU terminal shapes text itself, so it takes the
 * chunks as font data: the regular Latin chunks first, then the bold and
 * italic ones, then any chunk whose characters appear on screen. Coverage
 * fonts come last (scripts/build-terminal-emoji-font.py): their empty glyphs
 * make the engine draw emoji, and symbols or scripts Maple Mono lacks, with
 * the browser's own fonts.
 */
export type TerminalFontChunk = {
  url: string;
  weight: number;
  italic: boolean;
  ranges: [number, number][];
  core: boolean;
  /** A coverage font's engine label; these sort after every Maple chunk. */
  label?: string;
};

const COVERAGE_FONTS: TerminalFontChunk[] = [
  {
    url: "/assets/fonts/emoji/emoji-coverage-57e569d397.woff2",
    // "Apple Color Emoji" leads the engine's emoji canvas font stack.
    label: "Apple Color Emoji (Thyra emoji coverage)",
    ranges: [
      [0x2300, 0x23ff],
      [0x25fd, 0x27bf],
      [0x2b1b, 0x2b55],
      [0x1f000, 0x1faff],
    ],
    weight: 400,
    italic: false,
    core: false,
  },
  {
    url: "/assets/fonts/emoji/text-fallback-03f8e0f019.woff2",
    // Drawn in the cell's color with system fonts (patches/restty@*.patch).
    label: "Twemoji (Thyra text fallback)",
    ranges: [
      [0x0590, 0x06ff],
      [0x0900, 0x097f],
      [0x0e00, 0x0e7f],
      [0x1100, 0x11ff],
      [0x2000, 0x2bff],
      [0x3130, 0x318f],
      [0xac00, 0xd7a3],
      [0x1f100, 0x1f1ff],
      [0x1f780, 0x1f8ff],
      [0x1fb00, 0x1fbff],
    ],
    weight: 400,
    italic: false,
    core: false,
  },
  {
    url: "/assets/fonts/emoji/explicit-emoji-1ea275eacc.woff2",
    // Text-default emoji, picked only with U+FE0F (patches/restty@*.patch).
    label: "Apple Color Emoji (Thyra explicit emoji)",
    ranges: [[0xfe0f, 0xfe0f]],
    weight: 400,
    italic: false,
    core: false,
  },
];

export type TerminalFontData = {
  data: ArrayBuffer;
  name: string;
  weight: number;
  style: "normal" | "italic";
};

/** The chunks of @font-face rules: url, weight, style and unicode-range. */
export function parseTerminalFontChunks(
  css: string,
  core: boolean,
): TerminalFontChunk[] {
  return parseFontFaceRules(css).map((rule) => ({ ...rule, core }));
}

const covers = (chunk: TerminalFontChunk, codePoint: number) =>
  chunk.ranges.some(([low, high]) => codePoint >= low && codePoint <= high);

/**
 * Chunks by code point. Each layer holds ranges that do not overlap, sorted
 * for a binary search; a face's slices share one, so there are only a few.
 */
type FontChunkIndex = {
  starts: Uint32Array;
  ends: Uint32Array;
  owners: TerminalFontChunk[];
}[];

const chunkIndexes = new WeakMap<
  readonly TerminalFontChunk[],
  FontChunkIndex
>();

function chunkIndex(chunks: readonly TerminalFontChunk[]): FontChunkIndex {
  let index = chunkIndexes.get(chunks);
  if (index) return index;
  const spans: [number, number, TerminalFontChunk][] = [];
  for (const chunk of chunks)
    for (const [low, high] of chunk.ranges) spans.push([low, high, chunk]);
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const layers: { last: number; spans: typeof spans }[] = [];
  for (const span of spans) {
    let layer = layers.find((candidate) => candidate.last < span[0]);
    if (!layer) layers.push((layer = { last: -1, spans: [] }));
    layer.spans.push(span);
    layer.last = span[1];
  }
  index = layers.map((layer) => ({
    starts: Uint32Array.from(layer.spans, (span) => span[0]),
    ends: Uint32Array.from(layer.spans, (span) => span[1]),
    owners: layer.spans.map((span) => span[2]),
  }));
  chunkIndexes.set(chunks, index);
  return index;
}

/**
 * Chunks, in shaping order, that cover new code points of `text`. The list
 * is indexed on first use, so pass the same array for repeated lookups.
 */
export function terminalFontChunksFor(
  chunks: readonly TerminalFontChunk[],
  text: string,
  seen: Set<number>,
): TerminalFontChunk[] {
  const index = chunkIndex(chunks);
  const found = new Set<TerminalFontChunk>();
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint < 0x80 || seen.has(codePoint)) continue;
    seen.add(codePoint);
    for (const { starts, ends, owners } of index) {
      // The last range that starts at or before the code point.
      let low = 0;
      let high = starts.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (starts[middle]! <= codePoint) low = middle + 1;
        else high = middle;
      }
      if (low && ends[low - 1]! >= codePoint) found.add(owners[low - 1]!);
    }
  }
  // Callers get the chunks in the list's own order.
  return found.size > 1
    ? chunks.filter((chunk) => found.has(chunk))
    : [...found];
}

let coreChunks: TerminalFontChunk[] | null = null;
let coreManifest: TerminalFontChunk[] | null = null;
let fullManifest: Promise<TerminalFontChunk[]> | null = null;

/** The Latin, Latin-1 and Powerline slices (generated with the font). */
function terminalCoreChunks(): TerminalFontChunk[] {
  coreChunks ??= TERMINAL_FONT_CORE_FACES.map(
    ([url, weight, italic, ranges]) => ({
      url,
      weight,
      italic: italic === 1,
      core: true,
      ranges: decodeFontRanges(ranges),
    }),
  );
  return coreChunks;
}

/**
 * The core slices and the coverage fonts: all a first screen of a shell or
 * TUI needs, known without a request.
 */
export function terminalCoreFontManifest(): TerminalFontChunk[] {
  coreManifest ??= [...terminalCoreChunks(), ...COVERAGE_FONTS];
  return coreManifest;
}

async function fetchFontManifest(href: string): Promise<TerminalFontChunk[]> {
  const response = await fetch(href);
  if (!response.ok) throw new Error(`font manifest ${response.status}`);
  const manifest: unknown = await response.json();
  if (!isTerminalFontManifest(manifest)) throw new Error("font manifest");
  return terminalFontManifestRules(manifest).map((rule) => ({
    ...rule,
    core: false,
  }));
}

/**
 * Every slice. The manifest of those outside the core (CJK, icons, ...) is
 * fetched and decoded once, when such a character first appears, and every
 * terminal shares the result. A failed request is tried again by the next
 * call; that call still gets the core.
 */
export function terminalFontManifest(): Promise<TerminalFontChunk[]> {
  const loading = (fullManifest ??= fetchFontManifest(
    TERMINAL_FONT_MANIFEST,
  ).then(
    (rest) => [...terminalCoreFontManifest(), ...rest],
    () => {
      if (fullManifest === loading) fullManifest = null;
      return terminalCoreFontManifest();
    },
  ));
  return loading;
}

/** Whether a core slice has the code point. */
export function terminalCoreCoversCodePoint(codePoint: number): boolean {
  return (
    codePoint < 0x80 ||
    terminalCoreChunks().some((chunk) => covers(chunk, codePoint))
  );
}

/** Whether every character of `text` is in a core slice. */
export function terminalCoreCovers(text: string): boolean {
  for (const char of text)
    if (!terminalCoreCoversCodePoint(char.codePointAt(0)!)) return false;
  return true;
}

// One ArrayBuffer per file, so the engine's parsed-font cache keys on it.
export const fontBuffers = new Map<string, Promise<TerminalFontData | null>>();

export type FontFile = { url: string; weight: number; italic: boolean };

export function fontData(
  file: FontFile,
  name: string,
  response: Promise<Response | undefined>,
): Promise<TerminalFontData | null> {
  return response
    .then((found) => (found?.ok ? found.arrayBuffer() : null))
    .then((data) =>
      data
        ? {
            data,
            name,
            weight: file.weight,
            style: file.italic ? ("italic" as const) : ("normal" as const),
          }
        : null,
    )
    .catch(() => null);
}

// The engine picks bold and italic faces by these words in the name.
export const styleWords = (file: FontFile) =>
  `${file.weight >= 700 ? "Bold" : "Regular"}${file.italic ? " Italic" : ""}`;

export function terminalFontData(
  chunk: TerminalFontChunk,
): Promise<TerminalFontData | null> {
  let loaded = fontBuffers.get(chunk.url);
  if (!loaded) {
    loaded = fontData(
      chunk,
      chunk.label ?? `Thyra Mono ${styleWords(chunk)} ${chunk.url}`,
      fetch(chunk.url),
    );
    fontBuffers.set(chunk.url, loaded);
  }
  return loaded;
}

/**
 * Shaping order: regular before bold before italic, core first within each,
 * then the coverage fonts.
 */
export function sortTerminalFontChunks(
  chunks: Iterable<TerminalFontChunk>,
): TerminalFontChunk[] {
  const rank = (chunk: TerminalFontChunk) =>
    (chunk.label ? 10 + COVERAGE_FONTS.indexOf(chunk) : 0) +
    (chunk.italic ? 4 : 0) +
    (chunk.weight >= 700 ? 2 : 0) +
    (chunk.core ? 0 : 1) +
    // The ASCII chunk leads: the engine takes cell metrics from the first face.
    (chunk.core && chunk.ranges.some(([low]) => low <= 0x41) ? -0.5 : 0);
  return [...chunks].sort((a, b) => rank(a) - rank(b));
}

const stylesheets = new Set<string>();

function addStylesheet(href: string) {
  if (stylesheets.has(href) || typeof document === "undefined") return;
  stylesheets.add(href);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.terminalFont = "";
  document.head.append(link);
}

/** DOM text that mirrors the terminal (editors, previews) uses the CSS faces. */
export function addTerminalFontStylesheets() {
  addStylesheet(TERMINAL_FONT_CORE_STYLESHEET);
}

const FONT_FAMILY = "Thyra Mono";
let fullFaces = false;

const unicodeRange = (chunk: TerminalFontChunk) =>
  chunk.ranges
    .map(([low, high]) =>
      low === high
        ? `U+${low.toString(16)}`
        : `U+${low.toString(16)}-${high.toString(16)}`,
    )
    .join(",");

/**
 * The CSS faces of the slices outside the core, for DOM text over the
 * terminal. They are declared from the manifest, which the terminal has
 * usually fetched already, instead of the full stylesheet (some 470 KB of
 * @font-face rules); a browser loads a face's file only when text needs it.
 */
export function addTerminalFontFaces(): Promise<void> {
  if (fullFaces || typeof document === "undefined") return Promise.resolve();
  fullFaces = true;
  return terminalFontManifest().then((chunks) => {
    const rest = chunks.filter((chunk) => !chunk.core && !chunk.label);
    try {
      if (!rest.length) throw new Error("no font manifest");
      for (const chunk of rest)
        document.fonts.add(
          new FontFace(FONT_FAMILY, `url("${chunk.url}") format("woff2")`, {
            weight: String(chunk.weight),
            style: chunk.italic ? "italic" : "normal",
            display: "swap",
            unicodeRange: unicodeRange(chunk),
          }),
        );
    } catch {
      // No manifest or no FontFace API: the stylesheet declares the same.
      addStylesheet(TERMINAL_FONT_STYLESHEET);
    }
    addSymbolFallbackFace();
  });
}

/**
 * "Herdr Nerd Symbols", the last family of the terminal font stack
 * (appearance.ts): a 900 KB icon font of which the slices lack only a few
 * glyphs. Declared in the page's stylesheet, any icon outside the core
 * slices in DOM text (a prompt in the text preview) would download all of
 * it during startup, since no slice face covers the icon yet. Declared
 * here, after the slices, it loads only for a glyph they do not have.
 */
function addSymbolFallbackFace() {
  try {
    const url = new URL("./assets/herdr-nerd-symbols.woff2", import.meta.url);
    document.fonts.add(
      new FontFace("Herdr Nerd Symbols", `url("${url.href}") format("woff2")`, {
        display: "swap",
        unicodeRange: "U+E000-F8FF, U+F0000-FFFFD, U+100000-10FFFD",
      }),
    );
  } catch {
    // Icons then draw with whatever the system has.
  }
}
