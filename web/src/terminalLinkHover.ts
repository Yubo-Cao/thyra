import type { TerminalLink, TerminalLinkProvider } from "./terminalEngine";

type Cell = { x: number; y: number };

const contains = (link: TerminalLink, { x, y }: Cell) =>
  link.range.start.y <= y &&
  link.range.end.y >= y &&
  (link.range.start.y < y || link.range.start.x <= x) &&
  (link.range.end.y > y || link.range.end.x >= x);

/**
 * xterm's linkifier on top of the canvas: links come from providers one row
 * at a time and stay cached until the row changes or `refresh()` drops them.
 * A repaint never asks again by itself, since a provider lookup can cost
 * Herdr a `terminal.link.resolve` (asking on every frame stalled scrolling).
 */
export class TerminalLinkHover {
  private providers = new Set<TerminalLinkProvider>();
  private row: { y: number; links: TerminalLink[] } | null = null;
  private pointer: { event: MouseEvent; cell: Cell } | null = null;
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
      this.leave(event);
      return;
    }
    this.pointer = { event, cell };
    if (this.hovered && contains(this.hovered, cell)) return;
    this.leave(event);
    if (this.row?.y === cell.y) {
      this.pick();
      return;
    }
    const row = { y: cell.y, links: [] as TerminalLink[] };
    this.row = row;
    for (const provider of this.providers)
      provider.provideLinks(cell.y, (links) => {
        if (this.row !== row || !links?.length) return;
        row.links.push(...links);
        this.pick();
      });
  }

  /** The cached row went stale (a repaint, scroll or resize). */
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
    this.providers.clear();
    this.refresh();
  }

  private pick() {
    const pointer = this.pointer;
    if (!pointer || this.hovered || this.row?.y !== pointer.cell.y) return;
    const link = this.row.links.find((item) => contains(item, pointer.cell));
    if (!link) return;
    this.hovered = link;
    link.hover?.(pointer.event, link.text);
    this.view.show(link);
  }
}
