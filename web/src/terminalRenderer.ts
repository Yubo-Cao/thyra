import type { ITerminalAddon, Terminal } from "@xterm/xterm";
import { thyraLocalStorage } from "./browserStorage";
import { afterStartup } from "./startupGate";
import {
  TERMINAL_FONT_CORE_STYLESHEET,
  TERMINAL_FONT_STYLESHEET,
} from "./terminalFontStylesheet";

// Programming ligatures drawn as one glyph when the GPU renderer is active.
// Taken from Iosevka's default "calt" set, which @xterm/addon-ligatures also
// uses when it cannot read the font file. Joining these runs lets the font's
// contextual alternates shape them; everything else stays one cell per glyph.
export const TERMINAL_LIGATURES = [
  "<--",
  "<---",
  "<<-",
  "<-",
  "->",
  "->>",
  "-->",
  "--->",
  "<==",
  "<===",
  "<<=",
  "<=",
  "=>",
  "=>>",
  "==>",
  "===>",
  ">=",
  ">>=",
  "<->",
  "<-->",
  "<--->",
  "<---->",
  "<=>",
  "<==>",
  "<===>",
  "<====>",
  "::",
  ":::",
  "<~~",
  "</",
  "</>",
  "/>",
  "~~>",
  "==",
  "!=",
  "/=",
  "~=",
  "<>",
  "===",
  "!==",
  "!===",
  "<:",
  ":=",
  "*=",
  "*+",
  "<*",
  "<*>",
  "*>",
  "<|",
  "<|>",
  "|>",
  "+*",
  "=*",
  "=:",
  ":>",
  "/*",
  "*/",
  "+++",
  "<!--",
  "<!---",
  "&&",
  "||",
  "..",
  "...",
  "..=",
  "..<",
  "??",
  "?.",
  "=~",
  "!~",
  "#{",
  "#[",
  "]#",
  "::=",
  "|||",
  ">>",
  "<<",
  ">>>",
  "<<<",
  "__",
  "//",
  "///",
];

const LIGATURE_PATTERN = new RegExp(
  [...new Set(TERMINAL_LIGATURES)]
    .sort((left, right) => right.length - left.length)
    .map((ligature) => ligature.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
    .join("|"),
  "g",
);

/** Ranges of `text` to draw as single ligature glyphs. */
export function terminalLigatureRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  LIGATURE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(LIGATURE_PATTERN)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

export const TERMINAL_WEB_FONT_FAMILY = "Thyra Mono";

interface CellSize {
  width: number;
  height: number;
}

// Every Maple Mono NF CN face advances 600/1000 em with a 1020/300 ascent and
// descent; browsers round the canvas font box to whole pixels.
function bundledCellSize(fontSize: number): CellSize {
  return {
    width: fontSize * 0.6,
    height: Math.round(fontSize * 1.02) + Math.round(fontSize * 0.3),
  };
}

// The bundled font as this browser measures it (Chromium on Linux rounds its
// advances to whole pixels), remembered for the next page load.
const CELL_SIZE_KEY = "terminalCellSize";
let bundledFontLoaded = false;
// Once a font size is in use its cell size stays fixed for the page.
const pinnedCellSizes = new Map<number, CellSize>();

function storedCellSizes(): Record<string, [number, number]> {
  try {
    const stored = JSON.parse(thyraLocalStorage.getItem(CELL_SIZE_KEY) ?? "");
    return stored?.font === TERMINAL_FONT_CORE_STYLESHEET ? stored.sizes : {};
  } catch {
    return {};
  }
}

function rememberCellSize(fontSize: number, { width, height }: CellSize) {
  const sizes = storedCellSizes();
  const [storedWidth, storedHeight] = sizes[fontSize] ?? [];
  if (storedWidth === width && storedHeight === height) return;
  sizes[fontSize] = [width, height];
  try {
    thyraLocalStorage.setItem(
      CELL_SIZE_KEY,
      JSON.stringify({ font: TERMINAL_FONT_CORE_STYLESHEET, sizes }),
    );
  } catch {
    // Without storage the next load starts from the font's nominal metrics.
  }
}

function pinnedCellSize(fontSize: number, measured: CellSize | null) {
  let size = pinnedCellSizes.get(fontSize);
  if (!size) {
    const [width, height] = storedCellSizes()[fontSize] ?? [];
    size =
      width && height
        ? { width, height }
        : (measured ?? bundledCellSize(fontSize));
    pinnedCellSizes.set(fontSize, size);
  }
  return size;
}

type MeasureStrategy = { measure(): CellSize };
type CharSizeService = { measure(): void; _measureStrategy?: MeasureStrategy };

/**
 * Makes the terminal's cell size independent of font loading and renderer:
 * the bundled font's cells are known before it downloads, and widths snap to
 * device pixels as the WebGL renderer's do, so the DOM renderer draws the
 * same grid until WebGL arrives. Neither can then resize the terminal and
 * reflow a full-screen app. Reaches into xterm's measurement (pinned
 * version); without it xterm measures as usual.
 */
export function pinCellSize(term: Terminal) {
  const service = (
    term as unknown as { _core?: { _charSizeService?: CharSizeService } }
  )._core?._charSizeService;
  const strategy = service?._measureStrategy;
  if (!service || typeof strategy?.measure !== "function") return;
  const measure = strategy.measure.bind(strategy);
  strategy.measure = () => {
    const { fontFamily = "", fontSize = 13 } = term.options;
    const measured = { ...measure() };
    let size = measured;
    if (fontFamily.startsWith(`"${TERMINAL_WEB_FONT_FAMILY}"`)) {
      if (bundledFontLoaded) rememberCellSize(fontSize, size);
      size = pinnedCellSize(fontSize, bundledFontLoaded ? size : null);
    }
    const dpr = globalThis.devicePixelRatio || 1;
    // The epsilon keeps floor(width * dpr) exact in the renderers.
    const width = (Math.floor(size.width * dpr) + 1e-6) / dpr;
    // Exact per-glyph correction for the Apple row-spacing fix (TerminalView.css).
    term.element?.style.setProperty(
      "--terminal-letter-spacing",
      `${measured.width ? width - measured.width : 0}px`,
    );
    return { ...size, width };
  };
  service.measure();
}

/**
 * Fits a terminal to its parent on the WebGL renderer's device-pixel grid,
 * which the DOM renderer shares, so swapping renderers never resizes it.
 */
export class TerminalFit implements ITerminalAddon {
  private term: Terminal | null = null;

  activate(term: Terminal) {
    this.term = term;
  }

  dispose() {
    this.term = null;
  }

  proposeDimensions(): { cols: number; rows: number } | undefined {
    const term = this.term;
    const element = term?.element;
    const parent = element?.parentElement;
    const device = term?.dimensions?.device;
    if (!term || !parent || !device?.char.width || !device.cell.height) return;
    const view = element.ownerDocument.defaultView ?? window;
    const dpr = view.devicePixelRatio || 1;
    const px = (style: CSSStyleDeclaration, property: string) =>
      parseInt(style.getPropertyValue(property), 10) || 0;
    const own = view.getComputedStyle(element);
    const outer = view.getComputedStyle(parent);
    const { scrollback, scrollbar, letterSpacing = 0 } = term.options;
    const gutter =
      scrollback === 0 || !(scrollbar?.showScrollbar ?? true)
        ? 0
        : (scrollbar?.width ?? 14);
    const width =
      px(outer, "width") -
      px(own, "padding-left") -
      px(own, "padding-right") -
      gutter;
    const height =
      px(outer, "height") - px(own, "padding-top") - px(own, "padding-bottom");
    const cellWidth =
      (Math.floor(device.char.width) + Math.round(letterSpacing)) / dpr;
    return {
      cols: Math.max(2, Math.floor(width / cellWidth)),
      rows: Math.max(1, Math.floor(height / (device.cell.height / dpr))),
    };
  }

  fit() {
    const size = this.proposeDimensions();
    if (size) this.term?.resize(size.cols, size.rows);
  }
}

function addStylesheet(href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.terminalFont = "";
    link.onload = () => resolve();
    link.onerror = reject;
    document.head.append(link);
  });
}

let fontsLoading: Promise<boolean> | null = null;
let allFontsLoaded = false;
const allFontsListeners = new Set<() => void>();

/**
 * Adds the bundled font's core stylesheet once and loads its regular, bold
 * and italic Latin faces (which carry the ligature features), then adds the
 * CJK and icon chunks when idle. Resolves true once the faces loaded.
 */
function loadTerminalFonts(spec: string): Promise<boolean> {
  fontsLoading ??= addStylesheet(TERMINAL_FONT_CORE_STYLESHEET)
    // Wait for all: WebKit may cache glyphs from a fallback face and does not
    // always fire loadingdone for loads started here.
    .then(() =>
      Promise.all(
        ["", "bold ", "italic "].map((style) =>
          document.fonts.load(`${style}${spec}`),
        ),
      ),
    )
    .then(([regular]) => {
      bundledFontLoaded = regular.length > 0;
      const rest = () =>
        void addStylesheet(TERMINAL_FONT_STYLESHEET).then(
          () => {
            allFontsLoaded = true;
            for (const listener of allFontsListeners) listener();
          },
          () => {},
        );
      if ("requestIdleCallback" in window)
        requestIdleCallback(rest, { timeout: 5000 });
      else setTimeout(rest, 1000);
      return bundledFontLoaded;
    })
    .catch(() => false);
  return fontsLoading;
}

// Characters whose font chunk this page has already requested.
const requestedGlyphs = new Set<string>();

/** New non-ASCII characters in the visible rows, requested at most once. */
export function unrequestedGlyphs(lines: Iterable<string>): string {
  let found = "";
  for (const line of lines) {
    for (const char of line) {
      if (char.charCodeAt(0) < 0x80 || requestedGlyphs.has(char)) continue;
      requestedGlyphs.add(char);
      found += char;
    }
  }
  return found;
}

// iOS drops WebGL contexts of backgrounded pages; recover a few times per
// terminal, then keep the DOM renderer rather than flap.
const MAX_WEBGL_RECOVERIES = 3;

/**
 * Renders the terminal on the GPU when WebGL2 is available, with pixel-exact
 * box drawing and Powerline glyphs and programming ligatures. Falls back to
 * xterm's DOM renderer when WebGL is unavailable or its context is lost.
 *
 * The first output renders with the DOM renderer and fallback fonts; the
 * WebGL renderer and the bundled font load after it (startupGate.ts), on the
 * same cell grid (pinCellSize), so they never delay it or reflow it.
 */
export function attachTerminalRenderer(
  term: Terminal,
  onMetricsChange?: () => void,
): () => void {
  let disposed = false;
  let started = false;
  let addon: { dispose(): void; clearTextureAtlas(): void } | null = null;
  let joiner: number | null = null;
  let recoveries = 0;
  let loading: Promise<void> | null = null;

  const setGpu = (active: boolean) => {
    term.element?.classList.toggle("xterm-gpu", active);
    if (active && joiner === null) {
      joiner = term.registerCharacterJoiner(terminalLigatureRanges);
    } else if (!active && joiner !== null) {
      term.deregisterCharacterJoiner(joiner);
      joiner = null;
    }
  };

  const load = () => {
    if (disposed || !started || addon || loading) return;
    loading = import("@xterm/addon-webgl")
      .then(({ WebglAddon }) => {
        if (disposed || addon) return;
        const webgl = new WebglAddon({ customGlyphs: true });
        try {
          // Ligature font features must be in place before the atlas renders.
          setGpu(true);
          term.loadAddon(webgl);
        } catch {
          setGpu(false);
          return;
        }
        onMetricsChange?.();
        addon = webgl;
        webgl.onContextLoss(() => {
          webgl.dispose();
          if (addon === webgl) addon = null;
          setGpu(false);
          if (++recoveries <= MAX_WEBGL_RECOVERIES) {
            if (document.visibilityState === "visible") queueMicrotask(load);
          }
        });
      })
      .catch(() => {
        // The DOM renderer stays in place.
      })
      .finally(() => {
        loading = null;
      });
  };

  const onVisible = () => {
    if (
      document.visibilityState === "visible" &&
      recoveries <= MAX_WEBGL_RECOVERIES
    )
      load();
  };

  // Reapplying the family makes xterm rebuild glyphs with the loaded font;
  // the pinned cell size keeps the grid.
  const remeasure = () => {
    if (disposed) return;
    const family = term.options.fontFamily ?? "";
    term.options.fontFamily = `${family} `;
    term.options.fontFamily = family;
    addon?.clearTextureAtlas();
    onMetricsChange?.();
  };
  const fontSpec = () =>
    `${term.options.fontSize ?? 13}px "${TERMINAL_WEB_FONT_FAMILY}"`;
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  // The GPU renderer caches glyphs drawn with fallback fonts; once a CJK or
  // icon chunk arrives, rebuild the atlas so those cells use the real face.
  let atlasTimer: ReturnType<typeof setTimeout> | null = null;
  const onFontsLoaded = () => {
    if (disposed || atlasTimer) return;
    atlasTimer = setTimeout(() => {
      atlasTimer = null;
      if (disposed) return;
      addon?.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
    }, 120);
  };
  fonts?.addEventListener("loadingdone", onFontsLoaded);
  // Canvas text does not reliably trigger unicode-range downloads, so ask for
  // the chunks of characters that appear on screen.
  let scanQueued = false;
  const scanGlyphs = () => {
    scanQueued = false;
    if (disposed || !fonts || !allFontsLoaded) return;
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < term.rows; y++)
      lines.push(
        buffer.getLine(buffer.viewportY + y)?.translateToString() ?? "",
      );
    const glyphs = unrequestedGlyphs(lines);
    if (glyphs)
      void fonts
        .load(fontSpec(), glyphs)
        .then((faces) => {
          if (faces.length > 0) onFontsLoaded();
        })
        .catch(() => {});
  };
  const queueScan = () => {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scanGlyphs);
  };
  const written = term.onWriteParsed(queueScan);
  allFontsListeners.add(queueScan);

  pinCellSize(term);
  const cancelStartup = afterStartup(() => {
    started = true;
    load();
    if (fonts)
      void loadTerminalFonts(fontSpec()).then((loaded) => {
        if (loaded) remeasure();
      });
  });
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    disposed = true;
    cancelStartup();
    allFontsListeners.delete(queueScan);
    document.removeEventListener("visibilitychange", onVisible);
    fonts?.removeEventListener("loadingdone", onFontsLoaded);
    written.dispose();
    if (atlasTimer) clearTimeout(atlasTimer);
    if (joiner !== null) {
      try {
        term.deregisterCharacterJoiner(joiner);
      } catch {
        // The terminal may already be disposed.
      }
    }
    addon?.dispose();
    addon = null;
  };
}
