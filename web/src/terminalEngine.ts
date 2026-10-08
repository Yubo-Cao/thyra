import type { PtyTransport } from "restty";
import type { ResttyRuntime } from "restty/internal/runtime";
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_OPTIONS } from "./appearance";
import { TerminalLinkHover } from "./terminalLinkHover";
import { afterStartup, holdStartup } from "./startupGate";
import { redirectScreenFocus } from "./terminalFocus";
import {
  addTerminalFontStylesheets,
  sortTerminalFontChunks,
  type TerminalFontChunk,
  type TerminalFontData,
  terminalFontChunksFor,
  terminalCoreCovers,
  terminalCoreFontManifest,
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
  /** A self-hosted font preset (appearance.ts); "" for the bundled font. */
  fontPreset: string;
  theme: TerminalTheme;
  disableStdin: boolean;
  /** Lines kept above the screen; Herdr owns live history, so 0 there. */
  scrollback: number;
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
  grid(): {
    cols: number;
    rows: number;
    cellW: number;
    cellH: number;
    dpr: number;
  };
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

type ResttyModule = typeof import("restty/internal/runtime");
type EngineModules = {
  createRuntime: ResttyModule["createResttyRuntime"];
  session: ReturnType<ResttyModule["createResttyRuntimeSession"]>;
};
let engineModules: Promise<EngineModules> | null = null;

/** The WASM core, compiled while it streams in (vite.restty.ts ships it). */
async function compileTerminalCore(): Promise<WebAssembly.Module> {
  const { default: url } = await import("virtual:restty-wasm");
  try {
    return await WebAssembly.compileStreaming(fetch(url));
  } catch {
    // A proxy that rewrites the MIME type still serves the bytes.
    return WebAssembly.compile(await (await fetch(url)).arrayBuffer());
  }
}

/** Starts fetching the engine, its WASM core in parallel; safe to call early. */
export function loadTerminalEngine(): Promise<EngineModules> {
  engineModules ??= (async () => {
    const core = compileTerminalCore();
    core.catch(() => {});
    const restty = await import("restty/internal/runtime");
    const createSession = restty.createResttyRuntimeSession as (options: {
      wasmModule: () => Promise<WebAssembly.Module>;
    }) => EngineModules["session"];
    return {
      createRuntime: restty.createResttyRuntime,
      session: createSession({ wasmModule: () => core }),
    };
  })();
  return engineModules;
}

/** Bundled chunks the screen has needed so far, shared by every terminal. */
const neededChunks = new Set<TerminalFontChunk>();
const seenCodePoints = new Set<number>();
// Characters outside the core slices, waiting for the full manifest.
let unresolved = "";
const fontListeners = new Set<() => void>();
let lateFonts: Promise<void> | null = null;
// Whether startup has settled, so preset faces may use the network.
let presetDownloads = false;

function notifyFonts() {
  for (const listener of fontListeners) listener();
}

/** Resolves characters outside the core slices to their font chunks. */
function resolveLateFonts(): Promise<void> {
  if (!unresolved) return Promise.resolve();
  const text = unresolved;
  unresolved = "";
  return terminalFontManifest().then((chunks) => {
    for (const chunk of terminalFontChunksFor(chunks, text, new Set()))
      neededChunks.add(chunk);
    notifyFonts();
  });
}

function noteScreenText(text: string) {
  if (!/[^\x00-\x7f]/.test(text)) return;
  let fresh = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint < 0x80 || seenCodePoints.has(codePoint)) continue;
    seenCodePoints.add(codePoint);
    fresh += char;
  }
  if (!fresh) return;
  void terminalCoreFontManifest().then((core) => {
    for (const char of fresh) {
      if (terminalCoreCovers(core, char)) continue;
      unresolved += char;
    }
    // Before the engine has drawn, the slices wait so the first frame needs
    // only the core; afterwards they load as they appear.
    if (lateFonts) void resolveLateFonts();
  });
}

/**
 * After the first frame: bold and italic faces, slices for what is on screen,
 * and (when idle) the full stylesheet for DOM text over the terminal.
 */
function startLateFonts(): Promise<void> {
  lateFonts ??= terminalCoreFontManifest().then(async (core) => {
    await resolveLateFonts();
    // Bold, italic and the full stylesheet wait for startup to settle (the
    // first frame is in) and an idle moment.
    afterStartup(() => {
      const load = () => {
        for (const chunk of core) if (chunk.core) neededChunks.add(chunk);
        presetDownloads = true;
        notifyFonts();
        void terminalFontManifest();
      };
      if ("requestIdleCallback" in window)
        requestIdleCallback(load, { timeout: 5000 });
      else setTimeout(load, 1000);
    });
  });
  return lateFonts;
}

/**
 * The font list. The first frame waits for every face in it, so it takes only
 * the regular Latin faces and slices already known; the rest, and the
 * coverage fonts (emoji, system fallback), join once it has drawn.
 *
 * A selected preset leads the list. Its faces download only once startup has
 * settled; until then the bundled font draws, unless the preset is already in
 * this page or the service worker's cache.
 */
async function engineFonts(preset: string, coverage: boolean) {
  const [chunks, presetFaces] = await Promise.all([
    terminalCoreFontManifest(),
    preset
      ? import("./terminalFontPresets").then((presets) =>
          presets.terminalPresetFontData(preset, presetDownloads),
        )
      : [],
  ]);
  // Without the preset's regular face the bundled font sets the grid.
  const faces =
    presetFaces[0]?.weight === 400 && presetFaces[0].style === "normal"
      ? coverage
        ? presetFaces
        : presetFaces.slice(0, 1)
      : [];
  // Italic text stays upright in a preset that has no italic face.
  const italic = !faces.length || faces.some((face) => face.style === "italic");
  const regularCore = chunks.filter(
    (chunk) => chunk.core && chunk.weight < 700 && !chunk.italic,
  );
  const wanted = sortTerminalFontChunks(
    [...new Set([...regularCore, ...neededChunks])].filter(
      (chunk) => (coverage || !chunk.label) && (italic || !chunk.italic),
    ),
  );
  const data = (await Promise.all(wanted.map(terminalFontData))).filter(
    (font): font is TerminalFontData => font !== null,
  );
  return [...faces, ...data];
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
  private preEngineInput = new AbortController();
  private fixedSize: { cols: number; rows: number } | null = null;
  private selectionKey = "";
  private scrollOffset = 0;
  private keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  // Render state views die with the next write; reread once per change.
  private stateGeneration = 0;
  private stateCache: { generation: number; state: RenderState | null } | null =
    null;
  private links: TerminalLinkHover;
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
  private readonly metricsEmitter = new Emitter<void>();
  private metrics = "";
  /** Bytes the terminal sends: keys, IME text, paste, mouse reports. */
  readonly onData = this.dataEmitter.event;
  readonly onRender = this.renderEmitter.event;
  readonly onWriteParsed = this.writeEmitter.event;
  readonly onResize = this.resizeEmitter.event;
  readonly onScroll = this.scrollEmitter.event;
  readonly onSelectionChange = this.selectionEmitter.event;
  /**
   * The cell size changed with the font (a preset loaded or was switched):
   * the grid has refit, and the session sends the new size.
   */
  readonly onMetricsChange = this.metricsEmitter.event;
  /** Handles a clicked OSC 8 hyperlink; restty opens it otherwise. */
  linkHandler: ((uri: string, event: PointerEvent) => void) | null = null;
  /** Resolves once restty draws, or rejects when it cannot start. */
  readonly ready: Promise<void>;

  constructor(parent: HTMLElement, options: Partial<TerminalEngineOptions>) {
    this.opts = {
      fontSize: 13,
      lineHeight: 1,
      fontPreset: "",
      theme: {},
      disableStdin: false,
      scrollback: 0,
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
    this.links = new TerminalLinkHover({
      cell: (event) => this.linkCell(event),
      show: (link) => this.underline(link),
      hide: () => {
        this.linkUnderline.hidden = true;
        this.screen.style.cursor = "";
      },
    });
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
    const estimate = this.cellSize();
    this.metrics = `${estimate.width}x${estimate.height}`;
    this.bindEvents();
    this.bindPreEngineInput();
    fontListeners.add(this.reloadFonts);
    this.ready = this.start();
    this.ready.catch(() => {});
    // Startup warmups wait for the engine, which needs the bandwidth more.
    holdStartup(this.ready);
  }

  get options(): Readonly<TerminalEngineOptions> {
    return this.opts;
  }

  /** The CSS font stack for DOM text drawn over or instead of the grid. */
  get cssFontFamily() {
    const family = TERMINAL_FONT_OPTIONS.find(
      (option) => option.value === this.opts.fontPreset,
    )?.fontFamily;
    return family ? `${family}, ${TERMINAL_FONT_FAMILY}` : TERMINAL_FONT_FAMILY;
  }

  /** The active renderer ("webgpu" or "webgl2"), once the engine runs. */
  get renderer(): string {
    return this.runtime?.render.getBackend() ?? "";
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
    const [{ createRuntime, session }, fonts] = await Promise.all([
      loadTerminalEngine(),
      engineFonts(this.opts.fontPreset, false),
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
    const runtime = createRuntime({
      mount: { canvas: this.screen, imeInput: this.textarea, session },
      terminal: {
        renderer: "auto",
        fontSize: this.opts.fontSize,
        fontSizeMode: "em",
        fonts,
        theme: resttyTheme(this.opts.theme),
        autoResize: false,
        showResizeOverlay: false,
        forwardTerminalReplies: false,
        // Herdr owns the scrollback and Thyra the wheel; restty's native
        // scroller would also keep the canvas on a sticky, will-change layer
        // that it shifts by fractional pixels, which blurs the text.
        nativeScrollbar: false,
        // Blend glyph edges in sRGB like browser text on both backends.
        alphaBlending: "native",
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
      // Not every pixel ratio change reports a media query change.
      if (this.host?.grid().dpr !== window.devicePixelRatio)
        requestAnimationFrame(this.refit);
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
    // The engine reads the input from here on.
    this.preEngineInput.abort();
    runtime.io.connectPty("");
    this.transportCallbacks?.onData?.(GRAPHEME_CLUSTERING);
    if (this.fixedSize) this.resize(this.fixedSize.cols, this.fixedSize.rows);
    else this.fit();
    this.checkMetrics();
    this.watchPixelRatio();
    const pending = this.pending;
    this.pending = "";
    if (pending) this.transportCallbacks?.onData?.(pending);
    this.writeEmitter.fire();
    await rendered;
    // Characters beyond the core slices keep the text preview up until
    // their fonts are in; plain screens swap at once.
    const lateSlices = unresolved
      ? startLateFonts().then(this.reloadFonts)
      : null;
    void startLateFonts();
    await lateSlices;
    this.preview?.remove();
    this.preview = null;
  }

  /**
   * Until the engine runs, typing still reaches the pane: hardware keys go
   * through terminalKeyEvents and paste through Thyra's own handler; this
   * sends what on-screen keyboards and IME commit into the input.
   */
  private bindPreEngineInput() {
    const { signal } = this.preEngineInput;
    // A click focuses the canvas; text has to land in the input.
    redirectScreenFocus(
      this.screen,
      this.textarea,
      () => !this.runtime,
      signal,
    );
    const send = (text: string) => {
      if (text && !this.disposed) this.dataEmitter.fire(text);
    };
    const keys: Record<string, string> = {
      Enter: "\r",
      Backspace: "\x7f",
      Tab: "\t",
      Escape: "\x1b",
      ArrowUp: "\x1b[A",
      ArrowDown: "\x1b[B",
      ArrowRight: "\x1b[C",
      ArrowLeft: "\x1b[D",
    };
    this.textarea.addEventListener(
      "keydown",
      (event) => {
        const key = keys[event.key];
        if (!key || event.isComposing || event.defaultPrevented) return;
        event.preventDefault();
        send(key);
      },
      { signal },
    );
    this.textarea.addEventListener(
      "input",
      (event) => {
        const input = event as InputEvent;
        if (input.isComposing) return;
        if (input.inputType === "insertLineBreak") send("\r");
        else if (input.inputType === "deleteContentBackward") send("\x7f");
        else if (input.inputType.startsWith("insert") && input.data)
          send(input.data);
        this.textarea.value = "";
      },
      { signal },
    );
    this.textarea.addEventListener(
      "compositionend",
      (event) => {
        send(event.data);
        this.textarea.value = "";
      },
      { signal },
    );
  }

  private fontReload: Promise<void> | null = null;
  private fontsDirty = false;

  /** Loads the current font list, once more if it changed meanwhile. */
  private reloadFonts = (): Promise<void> => {
    if (!this.runtime || this.disposed) return Promise.resolve();
    if (this.fontReload) {
      this.fontsDirty = true;
      return this.fontReload;
    }
    const run = async () => {
      do {
        this.fontsDirty = false;
        const preset = this.opts.fontPreset;
        if (preset && presetDownloads)
          void import("./terminalFontPresets").then((presets) =>
            presets.addTerminalPresetFaces(preset),
          );
        const fonts = await engineFonts(preset, true);
        if (this.disposed || !this.runtime) return;
        await this.runtime.terminal.setFonts(fonts);
        this.checkMetrics();
      } while (this.fontsDirty);
    };
    this.fontReload = run()
      .catch(() => {})
      .finally(() => {
        this.fontReload = null;
      });
    return this.fontReload;
  };

  /** Refits and reports a cell size that differs from the last one. */
  private checkMetrics() {
    const { width, height } = this.cellSize();
    const metrics = `${width}x${height}`;
    if (metrics === this.metrics) return;
    this.metrics = metrics;
    if (this.fixedSize) this.resize(this.fixedSize.cols, this.fixedSize.rows);
    else this.fit();
    this.metricsEmitter.fire();
  }

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
    // Links stay until refresh(): providers check their own frame currency.
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
      options.fontPreset !== undefined &&
      options.fontPreset !== previous.fontPreset
    ) {
      // A choice made now downloads now.
      presetDownloads = true;
      this.reloadFonts();
    }
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
    if (grid?.cellW && grid.cellH) {
      const dpr = grid.dpr || window.devicePixelRatio || 1;
      return { width: grid.cellW / dpr, height: grid.cellH / dpr };
    }
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
    // The layout size, fractional and before transforms (a follow scale).
    const shown = this.screen.offsetWidth > 0;
    const style = shown ? getComputedStyle(this.screen) : null;
    const width =
      Number.parseFloat(style?.width ?? "") || this.element.clientWidth;
    const height =
      Number.parseFloat(style?.height ?? "") || this.element.clientHeight;
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
    // Cell metrics follow the pixel ratio; remeasure when it moved.
    const grid = this.host?.grid();
    if (this.runtime && (!grid?.cellW || grid.dpr !== window.devicePixelRatio))
      this.runtime.interaction.updateSize(true);
    const size = this.proposeSize();
    if (this.runtime) this.sizeScreen(size.cols, size.rows);
    this.setSize(size.cols, size.rows);
  }

  /** Pins the grid to a size (another device's), whatever the element's. */
  resize(cols: number, rows: number) {
    this.fixedSize = { cols, rows };
    this.sizeScreen(cols, rows);
    this.setSize(cols, rows);
  }

  /**
   * Sizes the canvas to whole cells on the device-pixel grid: its backing
   * store is exactly its CSS size times the pixel ratio, so the compositor
   * shows it 1:1 instead of resampling (and blurring) every glyph.
   */
  private sizeScreen(cols: number, rows: number) {
    this.runtime?.interaction.resize(cols, rows);
    const cell = this.cellSize();
    this.screen.style.width = `${cols * cell.width}px`;
    this.screen.style.height = `${rows * cell.height}px`;
  }

  /** Refits when the pixel ratio changes (another display, page zoom). */
  private watchPixelRatio() {
    const query = window.matchMedia?.(
      `(resolution: ${window.devicePixelRatio || 1}dppx)`,
    );
    query?.addEventListener(
      "change",
      () => {
        this.watchPixelRatio();
        this.refit();
      },
      { once: true, signal: this.abort.signal },
    );
  }

  /**
   * Moves the canvas to the current device-pixel grid at the same size, then
   * lets the view refit (cell sizes round differently per pixel ratio).
   */
  private refit = () => {
    if (this.disposed || !this.runtime) return;
    if (this.host?.grid().dpr === window.devicePixelRatio) return;
    this.sizeScreen(this.cols, this.rows);
    const { width, height } = this.cellSize();
    this.metrics = `${width}x${height}`;
    this.metricsEmitter.fire();
  };

  private setSize(cols: number, rows: number) {
    this.stateGeneration++;
    this.links?.refresh();
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

  /**
   * Repaints and drops the hovered link; as in xterm, links are looked up
   * again on the next pointer move, never per repaint (each lookup may cost
   * Herdr a `terminal.link.resolve`).
   */
  refresh() {
    this.host?.requestRender();
    this.links.refresh();
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
    this.links.refresh();
  }

  scrollToTop() {
    this.scrollLines(-(this.host?.scrollbar()?.total ?? 0));
  }

  scrollToBottom() {
    this.scrollLines(this.host?.scrollbar()?.total ?? 0);
  }

  /**
   * The visible screen, in xterm's buffer shape. As in xterm, each screen
   * (normal, alternate) keeps one identity while its contents change.
   */
  get buffer() {
    const alternate = [47, 1047, 1049].some((mode) =>
      this.privateModes.has(mode),
    );
    return { active: alternate ? this.alternateBuffer : this.normalBuffer };
  }

  private normalBuffer = this.screenBuffer("normal");
  private alternateBuffer = this.screenBuffer("alternate");

  private screenBuffer(type: "normal" | "alternate") {
    const state = () => {
      if (this.stateCache?.generation !== this.stateGeneration)
        this.stateCache = {
          generation: this.stateGeneration,
          state: this.host?.renderState() ?? null,
        };
      return this.stateCache.state;
    };
    const bar = () => this.host?.scrollbar() ?? null;
    const viewportY = () => bar()?.offset ?? 0;
    const line = (y: number): TerminalBufferLine | undefined => {
      const row = y - viewportY();
      if (row < 0 || row >= this.rows) return undefined;
      const screen = state();
      if (!screen)
        return textLine([...(this.textScreen.rows[row] ?? "")], this.cols);
      return row < screen.rows ? stateLine(screen, row) : undefined;
    };
    const rows = () => this.rows;
    return {
      type,
      get viewportY() {
        return viewportY();
      },
      get baseY() {
        const scroll = bar();
        return scroll ? Math.max(0, scroll.total - scroll.len) : 0;
      },
      get length() {
        return bar()?.total ?? rows();
      },
      get cursorX() {
        return state()?.cursor?.col ?? 0;
      },
      get cursorY() {
        return state()?.cursor?.row ?? 0;
      },
      getLine: line,
    };
  }

  // Links: xterm's provider contract on top of the canvas.

  registerLinkProvider(provider: TerminalLinkProvider): Disposable {
    return this.links.register(provider);
  }

  /** The 1-based buffer cell under a pointer, or null off the grid. */
  private linkCell(event: MouseEvent) {
    const host = this.host;
    if (!host) return null;
    const cell = host.positionToCell(event);
    if (cell.row < 0 || cell.row >= this.rows) return null;
    return { x: cell.col + 1, y: this.buffer.active.viewportY + cell.row + 1 };
  }

  /** One underline under the hovered row's part of the link. */
  private underline(link: TerminalLink) {
    const bounds = this.screenBounds();
    const rect = this.element.getBoundingClientRect();
    const scale = rect.width / (this.element.offsetWidth || rect.width || 1);
    const cellW = bounds.width / this.cols / scale;
    const cellH = bounds.height / this.rows / scale;
    const top = this.buffer.active.viewportY;
    const style = this.linkUnderline.style;
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
        if (event.buttons === 0) this.links.move(event);
        else this.links.leave(event);
      },
      { signal },
    );
    this.screen.addEventListener(
      "pointerleave",
      (event) => this.links.leave(event),
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
        const link = this.links.hovered;
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
    this.preEngineInput.abort();
    this.links.dispose();
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
