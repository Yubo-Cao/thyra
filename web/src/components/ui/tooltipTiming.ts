// Shared hover timing for every Tooltip: the first tooltip waits, and moving
// between triggers while one is open (or just closed) shows the next at once.

export const TOOLTIP_DELAY_MS = 500;
export const TOOLTIP_WARM_WINDOW_MS = 400;

export class TooltipTiming {
  private open = 0;
  private lastClosedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly delay = TOOLTIP_DELAY_MS,
    private readonly warmWindow = TOOLTIP_WARM_WINDOW_MS,
  ) {}

  /** Delay before a hover-triggered tooltip opens at time `now`. */
  showDelay(now: number): number {
    if (this.open > 0 || now - this.lastClosedAt < this.warmWindow) return 0;
    return this.delay;
  }

  opened(): void {
    this.open += 1;
  }

  closed(now: number): void {
    this.open = Math.max(0, this.open - 1);
    this.lastClosedAt = now;
  }
}

export const tooltipTiming = new TooltipTiming();
