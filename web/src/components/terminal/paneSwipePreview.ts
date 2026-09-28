import type { Terminal } from "@xterm/xterm";

// What a pane swipe shows of the pane it reveals, cheapest first: the screen
// that pane last rendered on this page, else the last lines of its text,
// fetched once per few seconds through the bridge's passive snapshot
// (`terminal.preview_text`). Neither attaches, resizes or focuses anything.

/** A terminal's text as it would be drawn, with the font to draw it in. */
export type PaneScreen = {
  text: string;
  /** Exact screen rows, or the last lines of the pane's output. */
  kind: "screen" | "lines";
  font: PaneFont;
  /** When it was taken, in ms. */
  at: number;
};

export type PaneFont = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
};

/** Screens kept for panes that have left the view. */
export const SCREEN_LIMIT = 6;
/** A kept screen older than this is refreshed from the bridge. */
export const SCREEN_MAX_AGE_MS = 60_000;
/** Fetched lines are reused for this long. */
export const LINES_TTL_MS = 5000;
/** A fetch waits this long for the drag to settle on a direction... */
export const FETCH_DEBOUNCE_MS = 60;
/** ...and gives up after this long. */
export const FETCH_TIMEOUT_MS = 1500;

/**
 * What to show for a pane now (null: its name card), and whether to fetch
 * its lines because nothing current is kept.
 */
export type PreviewSource = { use: PaneScreen | null; fetch: boolean };

export class PanePreviews {
  /** Kept screens by terminal, least recently used first. */
  private screens = new Map<string, PaneScreen>();
  /** Fetched lines (or a failure, as null) by terminal. */
  private lines = new Map<string, { screen: PaneScreen | null; at: number }>();
  private fetching = new Map<string, Promise<PaneScreen | null>>();

  /** Keeps a pane's screen as it leaves the view. */
  keep(key: string, screen: PaneScreen) {
    this.screens.delete(key);
    this.screens.set(key, screen);
    for (const old of this.screens.keys()) {
      if (this.screens.size <= SCREEN_LIMIT) break;
      this.screens.delete(old);
    }
  }

  source(key: string, now: number): PreviewSource {
    const screen = this.screens.get(key);
    if (screen && now - screen.at <= SCREEN_MAX_AGE_MS) {
      // Recently used screens stay longest.
      this.keep(key, screen);
      return { use: screen, fetch: false };
    }
    // A stale screen still beats the name card while its lines load.
    const fetched = this.lines.get(key);
    if (fetched && now - fetched.at <= LINES_TTL_MS)
      return { use: fetched.screen ?? screen ?? null, fetch: false };
    return { use: screen ?? null, fetch: true };
  }

  /**
   * Fetches a pane's lines once: concurrent requests share one call, and the
   * result (or its failure) is reused for `LINES_TTL_MS`.
   */
  fetch(
    key: string,
    load: () => Promise<PaneScreen | null>,
    now: () => number,
  ): Promise<PaneScreen | null> {
    const running = this.fetching.get(key);
    if (running) return running;
    const request = withTimeout(load(), FETCH_TIMEOUT_MS)
      .catch(() => null)
      .then((screen) => {
        this.fetching.delete(key);
        this.lines.set(key, { screen, at: now() });
        return screen;
      });
    this.fetching.set(key, request);
    return request;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The rows a terminal shows now, trailing blanks trimmed. */
export function terminalScreenText(term: Terminal): string {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y++)
    rows.push(
      buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "",
    );
  return rows.join("\n").replace(/\s+$/, "");
}

/**
 * The font a terminal draws in, as displayed: a view that follows another
 * device's size is scaled, and so is its preview.
 */
export function terminalFont(term: Terminal): PaneFont {
  const view = term.element?.closest<HTMLElement>(
    ".terminal-view.is-following",
  );
  const scale =
    Number.parseFloat(
      view?.style.getPropertyValue("--terminal-follow-scale") ?? "",
    ) || 1;
  return {
    fontFamily: term.options.fontFamily ?? "monospace",
    fontSize: (term.options.fontSize ?? 13) * scale,
    lineHeight: term.options.lineHeight ?? 1,
  };
}
