export const OVERLAY_SCROLLBAR_EXCLUDED_SELECTOR = [
  ".popover-content",
  ".config-dropdown",
  ".context-menu",
  ".pane-jump-popover",
  ".terminal-mobile-keys-panel",
  ".terminal-composer-shortcuts",
  "[role=dialog]",
  "[role=menu]",
  "[role=listbox]",
].join(", ");

export function overlayScrollbarExcludedElement(
  element: Pick<Element, "closest">,
): boolean {
  return Boolean(element.closest(OVERLAY_SCROLLBAR_EXCLUDED_SELECTOR));
}

export type OverlayThumbGeometry = {
  start: number;
  size: number;
  trackLength: number;
  maxScroll: number;
};

export function calculateOverlayThumb({
  viewportStart,
  viewportSize,
  clientSize,
  scrollSize,
  scrollOffset,
  inset = 3,
  minSize = 28,
}: {
  viewportStart: number;
  viewportSize: number;
  clientSize: number;
  scrollSize: number;
  scrollOffset: number;
  inset?: number;
  minSize?: number;
}): OverlayThumbGeometry | null {
  if (viewportSize <= 0 || clientSize <= 0 || scrollSize <= clientSize + 1) {
    return null;
  }

  const trackLength = Math.max(0, viewportSize - inset * 2);
  const proportionalSize = trackLength * (clientSize / scrollSize);
  const size = Math.min(trackLength, Math.max(minSize, proportionalSize));
  const maxScroll = Math.max(0, scrollSize - clientSize);
  const scrollRatio = Math.min(1, Math.max(0, scrollOffset / maxScroll));
  const travel = Math.max(0, trackLength - size);

  return {
    start: viewportStart + inset + travel * scrollRatio,
    size,
    trackLength,
    maxScroll,
  };
}

/**
 * Remembers what one wheel gesture resolved to. A gesture fires many events
 * at the same target, and resolving one walks its ancestors reading styles
 * and scroll sizes; the answer holds until the pointer moves to another
 * target, the gesture pauses for `idleMs`, or `clear` is called (on resize).
 */
export function createWheelTargetCache<Target extends object, Resolved>(
  resolve: (target: Target) => Resolved | null,
  now: () => number = () => performance.now(),
  idleMs = 250,
) {
  let cached: { target: Target; resolved: Resolved | null; at: number } | null =
    null;
  return {
    get(target: Target): Resolved | null {
      const time = now();
      if (cached && cached.target === target && time - cached.at <= idleMs) {
        cached.at = time;
        return cached.resolved;
      }
      cached = { target, resolved: resolve(target), at: time };
      return cached.resolved;
    },
    clear() {
      cached = null;
    },
  };
}

/**
 * Collects the scrollbar refreshes asked for within a frame so the layout
 * reads behind them happen once, when the frame runs. `take` resolves the
 * newest request that still yields a target, as resolving each on arrival
 * and keeping the last hit did.
 */
export function createRefreshQueue<Kind extends string, Target>() {
  let requests: { kind: Kind; target: Target }[] = [];
  return {
    add(kind: Kind, target: Target) {
      const last = requests[requests.length - 1];
      if (last && last.kind === kind && last.target === target) return;
      requests.push({ kind, target });
    },
    take<Resolved>(
      resolve: (kind: Kind, target: Target) => Resolved | null,
    ): Resolved | null {
      const taken = requests;
      requests = [];
      for (let index = taken.length - 1; index >= 0; index--) {
        const request = taken[index]!;
        const resolved = resolve(request.kind, request.target);
        if (resolved !== null) return resolved;
      }
      return null;
    },
  };
}
