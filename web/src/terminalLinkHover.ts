import type { TerminalLink, TerminalLinkProvider } from "./terminalEngine";

type Cell = { x: number; y: number };
type Row = {
  y: number;
  links: TerminalLink[];
  /** Provider replies still due; a lookup that never answers expires. */
  waiting: number;
  started: number;
  /** A repaint landed while this row's lookup was in flight. */
  stale: boolean;
};

/** A provider that has not answered by then is presumed superseded. */
const LOOKUP_EXPIRY_MS = 3000;
/** Repaints re-evaluate a hovered link at most this often. */
const REEVALUATE_MS = 200;

const contains = (link: TerminalLink, { x, y }: Cell) =>
  link.range.start.y <= y &&
  link.range.end.y >= y &&
  (link.range.start.y < y || link.range.start.x <= x) &&
  (link.range.end.y > y || link.range.end.x >= x);

const sameLink = (a: TerminalLink, b: TerminalLink) =>
  a.text === b.text &&
  a.range.start.x === b.range.start.x &&
  a.range.start.y === b.range.start.y &&
  a.range.end.x === b.range.end.x &&
  a.range.end.y === b.range.end.y;

/**
 * xterm's linkifier on top of the canvas: links come from providers one row
 * at a time. A repaint never looks a row up by itself, since a provider
 * lookup can cost Herdr a `terminal.link.resolve` (asking on every frame
 * stalled scrolling). Like xterm, though, a repaint under a hovered link
 * re-evaluates that link once the previous lookup has answered, and keeps
 * it until then: panes with live output (agent spinners, clocks) repaint
 * many times a second, and dropping the link on each repaint left nothing
 * for a click to activate.
 */
export class TerminalLinkHover {
  private providers = new Set<TerminalLinkProvider>();
  private row: Row | null = null;
  private pointer: { event: MouseEvent; cell: Cell } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  hovered: TerminalLink | null = null;

  constructor(
    private view: {
      /** The 1-based buffer cell under the pointer, or null off the grid. */
      cell(event: MouseEvent): Cell | null;
      show(link: TerminalLink): void;
      hide(): void;
    },
  ) {}

  register(provider: TerminalLinkProvider) {
    this.providers.add(provider);
    return {
      dispose: () => {
        this.providers.delete(provider);
        this.refresh();
      },
    };
  }

  move(event: MouseEvent) {
    const cell = this.view.cell(event);
    if (!cell || !this.providers.size) {
      this.pointer = null;
      this.row = null;
      this.leave(event);
      return;
    }
    this.pointer = { event, cell };
    if (this.row?.y === cell.y) {
      this.pick();
      return;
    }
    this.leave(event);
    this.lookup(cell.y);
  }

  /**
   * The screen repainted: re-evaluate a hovered link (keeping it meanwhile)
   * and keep an in-flight lookup, whose links check their own currency.
   */
  repaint() {
    const row = this.row;
    if (!row) return;
    if (!this.hovered) {
      if (!this.inFlight(row)) this.row = null;
      return;
    }
    if (this.inFlight(row)) {
      row.stale = true;
      return;
    }
    // At most one re-evaluation per interval, however fast the pane repaints.
    const wait = row.started + REEVALUATE_MS - performance.now();
    if (wait <= 0) this.lookup(row.y);
    else
      this.timer ??= setTimeout(() => {
        this.timer = null;
        if (this.row === row && this.hovered) this.lookup(row.y);
      }, wait);
  }

  /** The cached row went stale (a scroll or resize). */
  refresh() {
    this.row = null;
    this.leave();
  }

  leave(event?: MouseEvent) {
    const link = this.hovered;
    this.hovered = null;
    if (!link) return;
    this.view.hide();
    if (event) link.leave?.(event, link.text);
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.providers.clear();
    this.pointer = null;
    this.refresh();
  }

  private inFlight(row: Row) {
    return (
      row.waiting > 0 && performance.now() - row.started < LOOKUP_EXPIRY_MS
    );
  }

  private lookup(y: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const row: Row = {
      y,
      links: [],
      waiting: this.providers.size,
      started: performance.now(),
      stale: false,
    };
    this.row = row;
    const fresh: TerminalLink[] = [];
    for (const provider of this.providers) {
      let answered = false;
      provider.provideLinks(y, (links) => {
        if (this.row !== row || answered) return;
        answered = true;
        row.waiting--;
        if (links?.length) fresh.push(...links);
        // A re-evaluation swaps the row's links in only once complete.
        if (row.waiting > 0 && !this.hovered) row.links = [...fresh];
        if (row.waiting > 0) {
          this.pick();
          return;
        }
        row.links = fresh;
        this.pick(true);
        if (row.stale && this.hovered && this.pointer?.cell.y === row.y)
          this.repaint();
      });
    }
  }

  private pick(complete = false) {
    const pointer = this.pointer;
    const row = this.row;
    if (!pointer || row?.y !== pointer.cell.y) return;
    const current = this.hovered;
    if (current && contains(current, pointer.cell) && !complete) return;
    const link = row.links.find((item) => contains(item, pointer.cell));
    if (!link) {
      // Keep a hovered link until its row's lookup has answered.
      if (complete || !current || !contains(current, pointer.cell))
        this.leave(pointer.event);
      return;
    }
    if (current && sameLink(current, link)) {
      // The same link, re-evaluated: its fresh actions replace the old ones.
      this.hovered = link;
      if (current !== link) this.view.show(link);
      return;
    }
    this.leave(pointer.event);
    this.hovered = link;
    link.hover?.(pointer.event, link.text);
    this.view.show(link);
  }
}
