import {
  TERMINAL_FONT_CORE_STYLESHEET,
  TERMINAL_FONT_STYLESHEET,
} from "./terminalFontStylesheet";

/**
 * The bundled terminal font (Maple Mono NF CN, see
 * scripts/build-terminal-font.ts) is sliced into small woff2 chunks with
 * unicode-range rules. The GPU terminal shapes text itself, so it takes the
 * chunks as font data: the regular Latin chunks first, then the bold and
 * italic ones, then any chunk whose characters appear on screen. Two coverage
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
];

export type TerminalFontData = {
  data: ArrayBuffer;
  name: string;
  weight: number;
  style: "normal" | "italic";
};

/** Parses @font-face rules: url, weight, style and unicode-range. */
export function parseTerminalFontChunks(
  css: string,
  core: boolean,
): TerminalFontChunk[] {
  const chunks: TerminalFontChunk[] = [];
  for (const rule of css.split("}")) {
    const url = rule.match(/url\("([^"]+)"\)/)?.[1];
    const ranges = rule.match(/unicode-range:([^;}]*)/)?.[1];
    if (!url || !ranges) continue;
    chunks.push({
      url,
      weight: Number(rule.match(/font-weight:(\d+)/)?.[1] ?? 400),
      italic: /font-style:italic/.test(rule),
      core,
      ranges: ranges.split(",").map((range) => {
        const [start, end = start] = range.trim().slice(2).split("-");
        return [parseInt(start!, 16), parseInt(end!, 16)];
      }),
    });
  }
  return chunks;
}

const covers = (chunk: TerminalFontChunk, codePoint: number) =>
  chunk.ranges.some(([low, high]) => codePoint >= low && codePoint <= high);

/** Chunks, in shaping order, that cover new code points of `text`. */
export function terminalFontChunksFor(
  chunks: readonly TerminalFontChunk[],
  text: string,
  seen: Set<number>,
): TerminalFontChunk[] {
  const found = new Set<TerminalFontChunk>();
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint < 0x80 || seen.has(codePoint)) continue;
    seen.add(codePoint);
    for (const chunk of chunks) if (covers(chunk, codePoint)) found.add(chunk);
  }
  return [...found];
}

let manifest: Promise<TerminalFontChunk[]> | null = null;

/** Every chunk: the core stylesheet's first, regular faces leading. */
export function terminalFontManifest(): Promise<TerminalFontChunk[]> {
  manifest ??= Promise.all(
    [TERMINAL_FONT_CORE_STYLESHEET, TERMINAL_FONT_STYLESHEET].map((href) =>
      fetch(href).then((response) => (response.ok ? response.text() : "")),
    ),
  )
    .then(([core = "", rest = ""]) => [
      ...parseTerminalFontChunks(core, true),
      ...parseTerminalFontChunks(rest, false),
      ...COVERAGE_FONTS,
    ])
    .catch(() => []);
  return manifest;
}

// One ArrayBuffer per chunk, so the engine's parsed-font cache keys on it.
const buffers = new Map<string, Promise<TerminalFontData | null>>();

export function terminalFontData(
  chunk: TerminalFontChunk,
): Promise<TerminalFontData | null> {
  let loaded = buffers.get(chunk.url);
  if (!loaded) {
    loaded = fetch(chunk.url)
      .then((response) => (response.ok ? response.arrayBuffer() : null))
      .then((data) =>
        data
          ? {
              data,
              // The engine picks bold and italic faces by these words.
              name:
                chunk.label ??
                `Thyra Mono ${chunk.weight >= 700 ? "Bold" : "Regular"}${chunk.italic ? " Italic" : ""} ${chunk.url}`,
              weight: chunk.weight,
              style: chunk.italic ? ("italic" as const) : ("normal" as const),
            }
          : null,
      )
      .catch(() => null);
    buffers.set(chunk.url, loaded);
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

let stylesheets = false;

/** DOM text that mirrors the terminal (editors, previews) uses the CSS faces. */
export function addTerminalFontStylesheets() {
  if (stylesheets || typeof document === "undefined") return;
  stylesheets = true;
  for (const href of [
    TERMINAL_FONT_CORE_STYLESHEET,
    TERMINAL_FONT_STYLESHEET,
  ]) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.terminalFont = "";
    document.head.append(link);
  }
}
