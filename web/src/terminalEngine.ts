import type { PtyTransport } from "restty";
import type { ResttyRuntime } from "restty/internal/runtime";
import { TERMINAL_FONT_FAMILY } from "./appearance";
import {
  addTerminalFontStylesheets,
  sortTerminalFontChunks,
  type TerminalFontChunk,
  type TerminalFontData,
  terminalFontChunksFor,
  terminalFontData,
  terminalFontManifest,
} from "./terminalFonts";

/**
 * Thyra's terminal surface: restty (libghostty-vt in WASM, drawn with WebGPU
 * or WebGL2) behind the small xterm-shaped API the views use. Herdr owns the
 * terminal state and streams full-screen repaints, so this surface renders,
 * selects and encodes input; it keeps no history of its own.
 *
 * restty loads lazily. Until it renders, the latest screen shows as plain text
 * so live output appears before the engine (about 0.5 MiB) has arrived.
 */

export type TerminalTheme = {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
};

export type TerminalEngineOptions = {
  fontSize: number;
  lineHeight: number;
  /** A local family to prefer over the bundled font; "" for the bundled one. */
  fontFamily: string;
  theme: TerminalTheme;
  disableStdin: boolean;
  /** Lines kept above the screen; Herdr owns live history, so 0 there. */
  scrollback: number;
  cursorBlink: boolean;
};

type Cell = { row: number; col: number };
export type RenderState = {
  rows: number;
  cols: number;
  codepoints: Uint32Array | null;
  wide: Uint8Array | null;
  styleFlags: Uint16Array | null;
  fgBytes: Uint8Array | null;
  bgBytes: Uint8Array | null;
  graphemeOffset: Uint32Array | null;
  graphemeLen: Uint32Array | null;
  graphemeBuffer: Uint32Array | null;
  cursor: { row: number; col: number; visible: number } | null;
};
/** The engine internals Thyra's restty patch exposes (patches/restty@*.patch). */
type ResttyHost = {
  grid(): { cols: number; rows: number; cellW: number; cellH: number };
  renderState(): RenderState | null;
  selection(): { anchor: Cell; focus: Cell; dragging: boolean } | null;
  select(anchor: Cell, focus: Cell): void;
  clearSelection(): void;
  selectionText(): string;
  linkUri(row: number, col: number): string;
  setLinkHandler(handler: (uri: string, event: PointerEvent) => void): void;
  onRender(listener: () => void): () => void;
  scrollbar(): { total: number; offset: number; len: number } | null;
  scrollViewport(delta: number): void;
  positionToCell(event: { clientX: number; clientY: number }): Cell;
  requestRender(): void;
  mouseActive(): boolean;
  bracketedPaste(): boolean;
  setLineHeight(value: number): void;
};
type Runtime = ResttyRuntime & { host: ResttyHost };

type Listener<T> = (value: T) => void;
export type Disposable = { dispose(): void };

class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T) {
    for (const listener of [...this.listeners]) listener(value);
  }
}

export type TerminalBufferCell = {
  getChars(): string;
  getCode(): number;
  /** 2 for a wide glyph, 0 for the cell it spills into. */
  getWidth(): number;
  isBold(): boolean;
  isItalic(): boolean;
  isDim(): boolean;
  isUnderline(): boolean;
  /** CSS colors, resolved against the theme. */
  foreground(): string;
  background(): string;
};

export type TerminalBufferLine = {
  readonly length: number;
  /** Always false here: repaints carry no soft-wrap metadata. */
  readonly isWrapped: boolean;
  getCell(x: number): TerminalBufferCell | undefined;
  translateToString(trimRight?: boolean, start?: number, end?: number): string;
};

export type TerminalBufferRange = {
  start: { x: number; y: number };
  end: { x: number; y: number };
};

/** xterm's link provider contract: 1-based cells, inclusive end. */
export type TerminalLink = {
  range: TerminalBufferRange;
  text: string;
  activate(event: MouseEvent, text: string): void;
  hover?(event: MouseEvent, text: string): void;
  leave?(event: MouseEvent, text: string): void;
};
export type TerminalLinkProvider = {
  provideLinks(
    bufferLineNumber: number,
    callback: (links: TerminalLink[] | undefined) => void,
  ): void;
};

/** Mode 2027: one cell cluster per grapheme, as Herdr lays frames out. */
export const GRAPHEME_CLUSTERING = "\x1b[?2027h";

const STYLE_BOLD = 1;
const STYLE_ITALIC = 2;
const STYLE_FAINT = 4;
const STYLE_UNDERLINE = 0x700;

// xterm's default ANSI colors, which the built-in dark theme keeps.
const DEFAULT_ANSI = [
  "#2e3436",
  "#cc0000",
  "#4e9a06",
  "#c4a000",
  "#3465a4",
  "#75507b",
  "#06989a",
  "#d3d7cf",
  "#555753",
  "#ef2929",
  "#8ae234",
  "#fce94f",
  "#729fcf",
  "#ad7fa8",
  "#34e2e2",
  "#eeeeec",
];
const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

type ThemeColor = { r: number; g: number; b: number; a?: number };

/** `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgb()/rgba()`, as 0-255 channels. */
export function parseTerminalColor(value?: string): ThemeColor | undefined {
  const text = value?.trim() ?? "";
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1];
  if (hex) {
    const full =
      hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const channel = (at: number) => Number.parseInt(full.slice(at, at + 2), 16);
    return full.length === 8
      ? { r: channel(0), g: channel(2), b: channel(4), a: channel(6) }
      : { r: channel(0), g: channel(2), b: channel(4) };
  }
  const rgb =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
      text,
    );
  if (!rgb) return undefined;
  const [, r, g, b, a] = rgb;
  return {
    r: Number(r),
    g: Number(g),
    b: Number(b),
    ...(a === undefined ? {} : { a: Math.round(Number(a) * 255) }),
  };
}

/** The Ghostty-style theme restty applies. */
export function resttyTheme(theme: TerminalTheme) {
  const palette = Array.from({ length: 256 }, (_, index) =>
    index < 16
      ? parseTerminalColor(theme[ANSI_KEYS[index]!] ?? DEFAULT_ANSI[index])
      : undefined,
  );
  return {
    colors: {
      background: parseTerminalColor(theme.background),
      foreground: parseTerminalColor(theme.foreground),
      cursor: parseTerminalColor(theme.cursor),
      cursorText: parseTerminalColor(theme.cursorAccent),
      selectionBackground: parseTerminalColor(theme.selectionBackground),
      selectionForeground: parseTerminalColor(theme.selectionForeground),
      palette,
    },
    raw: {},
  };
}

/** Plain text of Herdr's repaints (and of plain streams) before restty runs. */
export class TerminalTextScreen {
  rows: string[] = [""];
  private row = 0;

  write(text: string) {
    // CSI (with its parameters), OSC/DCS/APC strings, other escapes, text.
    const tokens =
      /\x1b\[([0-9;?]*)([ -/]*[@-~])|\x1b[\]P_^][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b.|([^\x1b]+)/g;
    for (const match of text.matchAll(tokens)) {
      const [, params = "", final, plain] = match;
      if (plain !== undefined) {
        for (const line of plain.split(/(\r?\n|\r)/)) {
          if (line === "\n" || line === "\r\n") {
            this.moveTo(this.row + 1);
            this.rows[this.row] = "";
          } else if (line !== "\r" && line)
            this.rows[this.row] =
              (this.rows[this.row] ?? "") + line.replace(/[\x00-\x1f]/g, "");
        }
      } else if (final === "H" || final === "f") {
        this.moveTo(Number(params.split(";")[0] || 1) - 1);
      } else if (final === "J" && params === "2") {
        this.rows = [""];
        this.row = 0;
      } else if (final === "K" && params === "2") {
        this.rows[this.row] = "";
      }
    }
  }

  private moveTo(row: number) {
    this.row = Math.max(0, Math.min(row, 500));
    while (this.rows.length <= this.row) this.rows.push("");
  }

  get text() {
    return this.rows.join("\n");
  }
}

let resttyModule: Promise<typeof import("restty/internal/runtime")> | null =
  null;
/** Starts fetching the engine; safe to call early (an idle prefetch). */
export function loadTerminalEngine() {
  resttyModule ??= import("restty/internal/runtime");
  return resttyModule;
}

/** Bundled chunks the screen has needed so far, shared by every terminal. */
const neededChunks = new Set<TerminalFontChunk>();
const seenCodePoints = new Set<number>();
const fontListeners = new Set<() => void>();
let lateChunksQueued = false;

function noteScreenText(text: string) {
  void terminalFontManifest().then((chunks) => {
    const before = neededChunks.size;
    for (const chunk of terminalFontChunksFor(chunks, text, seenCodePoints))
      neededChunks.add(chunk);
    if (!lateChunksQueued) {
      lateChunksQueued = true;
      // Bold and italic Latin faces follow the first screen.
      const add = () => {
        for (const chunk of chunks)
          if (chunk.core && !chunk.label) neededChunks.add(chunk);
        for (const listener of fontListeners) listener();
      };
      if ("requestIdleCallback" in window)
        requestIdleCallback(add, { timeout: 3000 });
      else setTimeout(add, 1000);
    }
    if (neededChunks.size !== before)
      for (const listener of fontListeners) listener();
  });
}

async function engineFonts(family: string) {
  const chunks = await terminalFontManifest();
  const regularCore = chunks.filter(
    (chunk) => chunk.core && chunk.weight < 700 && !chunk.italic,
  );
  const wanted = sortTerminalFontChunks(
    new Set([...regularCore, ...neededChunks]),
  );
  const data = (await Promise.all(wanted.map(terminalFontData))).filter(
    (font): font is TerminalFontData => font !== null,
  );
  return [
    ...(family ? [{ family, local: "prefer" as const, name: family }] : []),
    ...data,
  ];
}

export class TerminalEngine {
  readonly element: HTMLDivElement;
  /** The canvas; `screenBounds()` is the part the cell grid covers. */
  readonly screen: HTMLCanvasElement;
  /** The hidden input that takes keys, IME composition and paste. */
  readonly textarea: HTMLTextAreaElement;
  cols: number;
  rows: number;
  private runtime: Runtime | null = null;
  private host: ResttyHost | null = null;
  private opts: TerminalEngineOptions;
  private pending = "";
  // DEC private modes set by the output (DECCKM, alternate screen).
  private privateModes = new Set<number>();
  private preview: HTMLPreElement | null;
  private textScreen = new TerminalTextScreen();
  private previewQueued = false;
  private transportCallbacks: { onData?: (data: string) => void } | null = null;
  private disposed = false;
  private abort = new AbortController();
  private fixedSize: { cols: number; rows: number } | null = null;
  private selectionKey = "";
  private scrollOffset = 0;
  private keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  // Render state views die with the next write; reread once per change.
  private stateGeneration = 0;
  private stateCache: { generation: number; state: RenderState | null } | null =
    null;
  private linkProviders = new Set<TerminalLinkProvider>();
  private hoveredLink: TerminalLink | null = null;
  private linkGeneration = 0;
  private pointer: PointerEvent | null = null;
  private pointerDown: { x: number; y: number } | null = null;
  private linkUnderline: HTMLDivElement;
  private readonly dataEmitter = new Emitter<string>();
  private readonly renderEmitter = new Emitter<void>();
  private readonly writeEmitter = new Emitter<void>();
  private readonly resizeEmitter = new Emitter<{
    cols: number;
    rows: number;
  }>();
  private readonly scrollEmitter = new Emitter<number>();
  private readonly selectionEmitter = new Emitter<void>();
  /** Bytes the terminal sends: keys, IME text, paste, mouse reports. */
  readonly onData = this.dataEmitter.event;
  readonly onRender = this.renderEmitter.event;
  readonly onWriteParsed = this.writeEmitter.event;
  readonly onResize = this.resizeEmitter.event;
  readonly onScroll = this.scrollEmitter.event;
  readonly onSelectionChange = this.selectionEmitter.event;
  /** Handles a clicked OSC 8 hyperlink; restty opens it otherwise. */
  linkHandler: ((uri: string, event: PointerEvent) => void) | null = null;
  /** Resolves once restty draws, or rejects when it cannot start. */
  readonly ready: Promise<void>;

  constructor(parent: HTMLElement, options: Partial<TerminalEngineOptions>) {
    this.opts = {
      fontSize: 13,
      lineHeight: 1,
      fontFamily: "",
      theme: {},
      disableStdin: false,
      scrollback: 0,
      cursorBlink: true,
      ...options,
    };
    const doc = parent.ownerDocument;
    this.element = doc.createElement("div");
    this.element.className = "terminal-engine";
    this.screen = doc.createElement("canvas");
    this.screen.className = "terminal-engine-screen";
    this.screen.tabIndex = -1;
    this.textarea = doc.createElement("textarea");
    this.textarea.className = "terminal-engine-input";
    this.textarea.setAttribute("aria-label", "Terminal input");
    this.textarea.autocapitalize = "off";
    this.textarea.autocomplete = "off";
    this.textarea.spellcheck = false;
    this.textarea.readOnly = this.opts.disableStdin;
    this.preview = doc.createElement("pre");
    this.preview.className = "terminal-engine-preview";
    this.linkUnderline = doc.createElement("div");
    this.linkUnderline.className = "terminal-engine-link";
    this.linkUnderline.hidden = true;
    this.element.append(
      this.screen,
      this.preview,
      this.linkUnderline,
      this.textarea,
    );
    parent.append(this.element);
    addTerminalFontStylesheets();
    this.applyThemeColors();
    this.stylePreview();
    ({ cols: this.cols, rows: this.rows } = this.proposeSize());
    this.bindEvents();
    fontListeners.add(this.reloadFonts);
    this.ready = this.start();
    this.ready.catch(() => {});
  }

  get options(): Readonly<TerminalEngineOptions> {
    return this.opts;
  }

  /** The CSS font stack for DOM text drawn over or instead of the grid. */
  get cssFontFamily() {
    const family = this.opts.fontFamily;
    return family
      ? `"${family}", ${TERMINAL_FONT_FAMILY}`
      : TERMINAL_FONT_FAMILY;
  }

  /** The modes the screen's application set. */
  get modes() {
    return {
      applicationCursorKeysMode: this.privateModes.has(1),
      bracketedPasteMode: this.host?.bracketedPaste() ?? false,
      mouseTrackingMode: this.host?.mouseActive() ? "drag" : "none",
    };
  }

  private async start() {
    const [{ createResttyRuntime }, fonts] = await Promise.all([
      loadTerminalEngine(),
      engineFonts(this.opts.fontFamily),
    ]);
    if (this.disposed) return;
    const transport: PtyTransport = {
      connect: ({ callbacks }) => {
        this.transportCallbacks = callbacks;
        callbacks.onConnect?.();
      },
      disconnect: () => {
        this.transportCallbacks = null;
      },
      sendInput: (data) => {
        if (!this.disposed) this.dataEmitter.fire(data);
        return true;
      },
      resize: () => true,
      isConnected: () => this.transportCallbacks !== null,
    };
    const runtime = createResttyRuntime({
      mount: { canvas: this.screen, imeInput: this.textarea },
      terminal: {
        renderer: "auto",
        fontSize: this.opts.fontSize,
        fontSizeMode: "em",
        fonts,
        theme: resttyTheme(this.opts.theme),
        autoResize: false,
        showResizeOverlay: false,
        forwardTerminalReplies: false,
        touchSelectionMode: "off",
        maxScrollbackBytes: Math.max(64_000, this.opts.scrollback * 400),
      },
      services: { ptyTransport: transport },
    }) as Runtime;
    this.runtime = runtime;
    this.host = runtime.host;
    this.host.setLineHeight(this.opts.lineHeight);
    this.host.setLinkHandler((uri, event) => {
      if (this.linkHandler) this.linkHandler(uri, event);
      else window.open(uri, "_blank", "noopener,noreferrer");
    });
    let firstRender: () => void = () => {};
    const rendered = new Promise<void>((resolve) => (firstRender = resolve));
    this.host.onRender(() => {
      firstRender();
      this.rendered();
    });
    runtime.events.subscribe((event) => {
      if (event.type !== "term-size") return;
      if (event.cols === this.cols && event.rows === this.rows) return;
      this.cols = event.cols;
      this.rows = event.rows;
      this.resizeEmitter.fire({ cols: this.cols, rows: this.rows });
    });
    await runtime.lifecycle.init();
    if (this.disposed) return;
    runtime.io.connectPty("");
    this.transportCallbacks?.onData?.(GRAPHEME_CLUSTERING);
    if (this.fixedSize) this.resize(this.fixedSize.cols, this.fixedSize.rows);
    else this.fit();
    const pending = this.pending;
    this.pending = "";
    if (pending) this.transportCallbacks?.onData?.(pending);
    this.writeEmitter.fire();
    await rendered;
    this.preview?.remove();
    this.preview = null;
  }

  private reloadFonts = () => {
    const runtime = this.runtime;
    if (!runtime || this.disposed) return;
    void engineFonts(this.opts.fontFamily).then((fonts) => {
      if (!this.disposed) void runtime.terminal.setFonts(fonts);
    });
  };

  private rendered() {
    this.stateGeneration++;
    const key = JSON.stringify(this.host?.selection() ?? null);
    const offset = this.host?.scrollbar()?.offset ?? 0;
    queueMicrotask(() => {
      if (this.disposed) return;
      if (offset !== this.scrollOffset) {
        this.scrollOffset = offset;
        this.scrollEmitter.fire(offset);
      }
      if (key !== this.selectionKey) {
        this.selectionKey = key;
        this.selectionEmitter.fire();
      }
      this.renderEmitter.fire();
    });
  }

  write(text: string, callback?: () => void) {
    if (this.disposed) return;
    if (this.transportCallbacks) {
      this.transportCallbacks.onData?.(text);
    } else {
      this.pending += text;
      this.textScreen.write(text);
      this.queuePreview();
    }
    noteScreenText(text);
    this.trackModes(text);
    this.linkGeneration++;
    this.stateGeneration++;
    queueMicrotask(() => {
      if (this.disposed) return;
      callback?.();
      if (this.transportCallbacks) this.writeEmitter.fire();
    });
  }

  private trackModes(text: string) {
    if (!text.includes("\x1b")) return;
    if (text.includes("\x1bc")) this.privateModes.clear();
    for (const [, params = "", set] of text.matchAll(/\x1b\[\?([\d;]+)([hl])/g))
      for (const mode of params.split(";").map(Number))
        if (mode === 1 || mode === 47 || mode === 1047 || mode === 1049)
          if (set === "h") this.privateModes.add(mode);
          else this.privateModes.delete(mode);
  }

  private queuePreview() {
    if (this.previewQueued || !this.preview) return;
    this.previewQueued = true;
    requestAnimationFrame(() => {
      this.previewQueued = false;
      if (this.preview) this.preview.textContent = this.textScreen.text;
    });
  }

  /** Clears the screen and modes. */
  reset() {
    this.clearSelection();
    this.textScreen = new TerminalTextScreen();
    this.write(`\x1bc${GRAPHEME_CLUSTERING}`);
  }

  setOptions(options: Partial<TerminalEngineOptions>) {
    const previous = this.opts;
    this.opts = { ...previous, ...options };
    const runtime = this.runtime;
    if (options.disableStdin !== undefined)
      this.textarea.readOnly = options.disableStdin;
    this.stylePreview();
    if (options.theme && options.theme !== previous.theme) {
      this.applyThemeColors();
      runtime?.terminal.applyTheme(resttyTheme(options.theme) as never);
    }
    if (!runtime) return;
    if (
      options.fontSize !== undefined &&
      options.fontSize !== previous.fontSize
    )
      runtime.terminal.setFontSize(options.fontSize);
    if (
      options.lineHeight !== undefined &&
      options.lineHeight !== previous.lineHeight
    )
      this.host?.setLineHeight(options.lineHeight);
    if (
      options.fontFamily !== undefined &&
      options.fontFamily !== previous.fontFamily
    )
      this.reloadFonts();
  }

  private stylePreview() {
    if (!this.preview) return;
    Object.assign(this.preview.style, {
      fontFamily: this.cssFontFamily,
      fontSize: `${this.opts.fontSize}px`,
      lineHeight: `${this.cellSize().height}px`,
    });
  }

  private applyThemeColors() {
    const { background = "", foreground = "" } = this.opts.theme;
    this.element.style.setProperty("--terminal-canvas-foreground", foreground);
    if (background)
      this.element.style.setProperty(
        "--terminal-canvas-background",
        background,
      );
  }

  /** Cell size in CSS layout pixels, before the engine loads an estimate. */
  cellSize(): { width: number; height: number } {
    const grid = this.host?.grid();
    const scale =
      this.screen.width > 0 && this.screen.offsetWidth > 0
        ? this.screen.offsetWidth / this.screen.width
        : 1 / (window.devicePixelRatio || 1);
    if (grid?.cellW && grid.cellH)
      return { width: grid.cellW * scale, height: grid.cellH * scale };
    // The bundled font advances 600/1000 em and spans 1320/1000 em.
    const dpr = window.devicePixelRatio || 1;
    const px = Math.max(1, Math.round(Math.round(this.opts.fontSize) * dpr));
    return {
      width: Math.round(px * 0.6) / dpr,
      height: Math.round(px * 1.32 * this.opts.lineHeight) / dpr,
    };
  }

  /** The grid's area on screen (viewport pixels, after zoom and transforms). */
  screenBounds(): DOMRect {
    const rect = this.screen.getBoundingClientRect();
    const scale =
      this.screen.offsetWidth > 0 ? rect.width / this.screen.offsetWidth : 1;
    const cell = this.cellSize();
    return new DOMRect(
      rect.left,
      rect.top,
      Math.min(rect.width, this.cols * cell.width * scale),
      Math.min(rect.height, this.rows * cell.height * scale),
    );
  }

  /** The grid's layout size in CSS pixels, unaffected by transforms. */
  screenSize() {
    const cell = this.cellSize();
    return { width: this.cols * cell.width, height: this.rows * cell.height };
  }

  private proposeSize() {
    const cell = this.cellSize();
    const width = this.screen.offsetWidth || this.element.clientWidth;
    const height = this.screen.offsetHeight || this.element.clientHeight;
    return {
      cols: Math.max(2, Math.floor(width / cell.width) || 80),
      rows: Math.max(1, Math.floor(height / cell.height) || 24),
    };
  }

  /** Fills the element with whole cells. */
  fit() {
    this.fixedSize = null;
    this.screen.style.removeProperty("width");
    this.screen.style.removeProperty("height");
    if (this.runtime) {
      this.runtime.interaction.updateSize(true);
      const grid = this.host?.grid();
      if (grid?.cols && grid.rows) this.setSize(grid.cols, grid.rows);
      return;
    }
    const size = this.proposeSize();
    this.setSize(size.cols, size.rows);
  }

  /** Pins the grid to a size (another device's), whatever the element's. */
  resize(cols: number, rows: number) {
    this.fixedSize = { cols, rows };
    const cell = this.cellSize();
    this.screen.style.width = `${cols * cell.width}px`;
    this.screen.style.height = `${rows * cell.height}px`;
    this.runtime?.interaction.resize(cols, rows);
    this.setSize(cols, rows);
  }

  private setSize(cols: number, rows: number) {
    this.stateGeneration++;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.resizeEmitter.fire({ cols, rows });
  }

  focus() {
    if (this.runtime) this.runtime.interaction.focus();
    else this.textarea.focus({ preventScroll: true });
  }

  blur() {
    this.runtime?.interaction.blur();
    this.textarea.blur();
  }

  /** Repaints and rereads links. */
  refresh() {
    this.linkGeneration++;
    this.host?.requestRender();
    if (this.pointer) this.hoverAt(this.pointer);
  }

  /** Like xterm's: sends text as a paste, bracketed when the app asked. */
  paste(text: string) {
    const body = text.replace(/\r?\n/g, "\r");
    this.dataEmitter.fire(
      this.modes.bracketedPasteMode ? `\x1b[200~${body}\x1b[201~` : body,
    );
  }

  /** Runs before the engine's own key handling; false stops it there. */
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
  }

  // Selection, in xterm's absolute buffer coordinates.

  hasSelection() {
    return !!this.host?.selection();
  }

  getSelection() {
    return this.host?.selection() ? this.host.selectionText() : "";
  }

  getSelectionPosition(): TerminalBufferRange | undefined {
    const selection = this.host?.selection();
    if (!selection) return undefined;
    const [start, end] = [selection.anchor, selection.focus].sort(
      (a, b) => a.row - b.row || a.col - b.col,
    ) as [Cell, Cell];
    const top = this.buffer.active.viewportY;
    return {
      start: { x: start.col, y: top + start.row },
      end: { x: end.col + 1, y: top + end.row },
    };
  }

  select(column: number, row: number, length: number) {
    if (!this.host || length <= 0) return;
    const start = (row - this.buffer.active.viewportY) * this.cols + column;
    const end = start + length - 1;
    const cell = (index: number) => ({
      row: Math.floor(index / this.cols),
      col: index % this.cols,
    });
    this.host.select(cell(start), cell(end));
  }

  clearSelection() {
    this.host?.clearSelection();
  }

  scrollLines(lines: number) {
    this.host?.scrollViewport(lines);
    this.stateGeneration++;
  }

  scrollToTop() {
    this.scrollLines(-(this.host?.scrollbar()?.total ?? 0));
  }

  scrollToBottom() {
    this.scrollLines(this.host?.scrollbar()?.total ?? 0);
  }

  /** The visible screen, in xterm's buffer shape. */
  get buffer() {
    const host = this.host;
    const bar = host?.scrollbar();
    const viewportY = bar?.offset ?? 0;
    const baseY = bar ? Math.max(0, bar.total - bar.len) : 0;
    if (this.stateCache?.generation !== this.stateGeneration)
      this.stateCache = {
        generation: this.stateGeneration,
        state: host?.renderState() ?? null,
      };
    const state = this.stateCache.state;
    const preview = state ? null : this.textScreen.rows;
    const cols = this.cols;
    const line = (y: number): TerminalBufferLine | undefined => {
      const row = y - viewportY;
      if (row < 0 || row >= this.rows) return undefined;
      if (!state) {
        const text = [...(preview?.[row] ?? "")];
        return textLine(text, cols);
      }
      if (row >= state.rows) return undefined;
      return stateLine(state, row);
    };
    return {
      active: {
        type: [47, 1047, 1049].some((mode) => this.privateModes.has(mode))
          ? ("alternate" as const)
          : ("normal" as const),
        viewportY,
        baseY,
        length: bar?.total ?? this.rows,
        cursorX: state?.cursor?.col ?? 0,
        cursorY: state?.cursor?.row ?? 0,
        getLine: line,
      },
    };
  }

  // Links: xterm's provider contract on top of the canvas.

  registerLinkProvider(provider: TerminalLinkProvider): Disposable {
    this.linkProviders.add(provider);
    return {
      dispose: () => {
        this.linkProviders.delete(provider);
        if (this.hoveredLink) this.leaveLink();
      },
    };
  }

  private hoverAt(event: PointerEvent) {
    const host = this.host;
    if (!host || !this.linkProviders.size) return;
    const cell = host.positionToCell(event);
    if (cell.row < 0 || cell.row >= this.rows) return this.leaveLink(event);
    const y = this.buffer.active.viewportY + cell.row + 1;
    const x = cell.col + 1;
    const contains = (link: TerminalLink) =>
      link.range.start.y <= y &&
      link.range.end.y >= y &&
      (link.range.start.y < y || link.range.start.x <= x) &&
      (link.range.end.y > y || link.range.end.x >= x);
    if (this.hoveredLink && contains(this.hoveredLink)) return;
    this.leaveLink(event);
    const generation = this.linkGeneration;
    for (const provider of this.linkProviders) {
      provider.provideLinks(y, (links) => {
        if (
          this.disposed ||
          generation !== this.linkGeneration ||
          this.pointer !== event ||
          this.hoveredLink
        )
          return;
        const link = links?.find(contains);
        if (link) this.enterLink(link, event);
      });
    }
  }

  private enterLink(link: TerminalLink, event: PointerEvent) {
    this.hoveredLink = link;
    link.hover?.(event, link.text);
    const bounds = this.screenBounds();
    const rect = this.element.getBoundingClientRect();
    const scale = rect.width / (this.element.offsetWidth || rect.width || 1);
    const cellW = bounds.width / this.cols / scale;
    const cellH = bounds.height / this.rows / scale;
    const top = this.buffer.active.viewportY;
    const style = this.linkUnderline.style;
    // One underline under the hovered row's part of the link.
    const row = link.range.start.y - 1 - top;
    const endRow = link.range.end.y - 1 - top;
    const startX = link.range.start.x - 1;
    const endX = endRow === row ? link.range.end.x : this.cols;
    style.left = `${(bounds.left - rect.left) / scale + startX * cellW}px`;
    style.top = `${(bounds.top - rect.top) / scale + (row + 1) * cellH - 1}px`;
    style.width = `${(endX - startX) * cellW}px`;
    this.linkUnderline.hidden = false;
    this.screen.style.cursor = "pointer";
  }

  private leaveLink(event?: PointerEvent) {
    const link = this.hoveredLink;
    this.hoveredLink = null;
    this.linkUnderline.hidden = true;
    if (!link) return;
    this.screen.style.cursor = "";
    if (event) link.leave?.(event, link.text);
  }

  private bindEvents() {
    const { signal } = this.abort;
    const capture = { capture: true, signal };
    // Thyra's handler sees keys before restty's window listener.
    const onKey = (event: KeyboardEvent) => {
      if (this.keyHandler && this.keyHandler(event) === false)
        event.stopPropagation();
    };
    this.element.addEventListener("keydown", onKey, capture);
    this.element.addEventListener("keyup", onKey, capture);
    this.screen.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerType === "touch") return;
        this.pointer = event;
        if (event.buttons === 0) this.hoverAt(event);
        else if (this.hoveredLink) this.leaveLink(event);
      },
      { signal },
    );
    this.screen.addEventListener(
      "pointerleave",
      (event) => {
        this.pointer = null;
        this.leaveLink(event);
      },
      { signal },
    );
    this.screen.addEventListener(
      "pointerdown",
      (event) => {
        this.pointerDown = { x: event.clientX, y: event.clientY };
      },
      capture,
    );
    this.screen.addEventListener(
      "pointerup",
      (event) => {
        const down = this.pointerDown;
        this.pointerDown = null;
        const link = this.hoveredLink;
        if (
          !link ||
          event.button !== 0 ||
          !down ||
          Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4 ||
          this.hasSelection()
        )
          return;
        link.activate(event, link.text);
      },
      { signal },
    );
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    fontListeners.delete(this.reloadFonts);
    this.abort.abort();
    this.leaveLink();
    this.linkProviders.clear();
    this.runtime?.lifecycle.destroy();
    this.runtime = null;
    this.host = null;
    this.element.remove();
  }
}

function textLine(chars: string[], cols: number): TerminalBufferLine {
  const cell = (x: number): TerminalBufferCell | undefined =>
    x < 0 || x >= cols
      ? undefined
      : {
          getChars: () => chars[x] ?? "",
          getCode: () => chars[x]?.codePointAt(0) ?? 0,
          getWidth: () => 1,
          isBold: () => false,
          isItalic: () => false,
          isDim: () => false,
          isUnderline: () => false,
          foreground: () => "",
          background: () => "",
        };
  return {
    length: cols,
    isWrapped: false,
    getCell: cell,
    translateToString(trimRight = false, start = 0, end = cols) {
      const text = chars
        .slice(start, end)
        .join("")
        .padEnd(end - start, " ");
      return trimRight ? text.trimEnd() : text;
    },
  };
}

/** One row of an engine render state (also a headless snapshot). */
export function stateLine(state: RenderState, row: number): TerminalBufferLine {
  const { cols } = state;
  const base = row * cols;
  const chars = (x: number) => {
    const index = base + x;
    const code = state.codepoints?.[index] ?? 0;
    if (!code) return "";
    const extra = state.graphemeLen?.[index] ?? 0;
    if (!extra || !state.graphemeOffset || !state.graphemeBuffer)
      return String.fromCodePoint(code);
    const offset = state.graphemeOffset[index] ?? 0;
    return String.fromCodePoint(
      code,
      ...state.graphemeBuffer.subarray(offset, offset + extra),
    );
  };
  const width = (x: number) => {
    const wide = state.wide?.[base + x] ?? 0;
    return wide === 1 ? 2 : wide === 2 ? 0 : 1;
  };
  const color = (bytes: Uint8Array | null, x: number) => {
    if (!bytes) return "";
    const at = (base + x) * 4;
    return `rgb(${bytes[at]} ${bytes[at + 1]} ${bytes[at + 2]})`;
  };
  const style = (x: number) => state.styleFlags?.[base + x] ?? 0;
  return {
    length: cols,
    isWrapped: false,
    getCell: (x) =>
      x < 0 || x >= cols
        ? undefined
        : {
            getChars: () => chars(x),
            getCode: () => state.codepoints?.[base + x] ?? 0,
            getWidth: () => width(x),
            isBold: () => (style(x) & STYLE_BOLD) !== 0,
            isItalic: () => (style(x) & STYLE_ITALIC) !== 0,
            isDim: () => (style(x) & STYLE_FAINT) !== 0,
            isUnderline: () => (style(x) & STYLE_UNDERLINE) !== 0,
            foreground: () => color(state.fgBytes, x),
            background: () => color(state.bgBytes, x),
          },
    translateToString(trimRight = false, start = 0, end = cols) {
      let text = "";
      for (let x = Math.max(0, start); x < Math.min(cols, end); x++) {
        if (width(x) === 0) continue;
        text += chars(x) || " ";
      }
      return trimRight ? text.trimEnd() : text;
    },
  };
}
