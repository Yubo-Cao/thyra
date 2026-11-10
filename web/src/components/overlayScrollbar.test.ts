import { describe, expect, test } from "bun:test";
import {
  calculateOverlayThumb,
  createRefreshQueue,
  createWheelTargetCache,
  overlayScrollbarExcludedElement,
} from "./overlayScrollbar";

describe("overlay scrollbar exclusions", () => {
  test("excludes dialogs, popovers, menus, and mobile shortcut panels", () => {
    for (const match of [
      ".popover-content",
      ".config-dropdown",
      ".context-menu",
      ".pane-jump-popover",
      ".terminal-mobile-keys-panel",
      ".terminal-composer-shortcuts",
      "[role=dialog]",
      "[role=menu]",
      "[role=listbox]",
    ]) {
      expect(
        overlayScrollbarExcludedElement({
          closest: () => ({ match }) as unknown as Element,
        }),
      ).toBe(true);
    }
  });

  test("keeps ordinary application scroll regions eligible", () => {
    expect(overlayScrollbarExcludedElement({ closest: () => null })).toBe(
      false,
    );
  });
});

describe("overlay scrollbar geometry", () => {
  test("does not render when content fits", () => {
    expect(
      calculateOverlayThumb({
        viewportStart: 10,
        viewportSize: 200,
        clientSize: 200,
        scrollSize: 200,
        scrollOffset: 0,
      }),
    ).toBeNull();
  });

  test("positions a proportional thumb along the track", () => {
    const thumb = calculateOverlayThumb({
      viewportStart: 10,
      viewportSize: 206,
      clientSize: 200,
      scrollSize: 800,
      scrollOffset: 300,
      inset: 3,
      minSize: 28,
    });

    expect(thumb).not.toBeNull();
    expect(thumb!.trackLength).toBe(200);
    expect(thumb!.size).toBe(50);
    expect(thumb!.maxScroll).toBe(600);
    expect(thumb!.start).toBe(88);
  });

  test("clamps small thumbs and out-of-range scroll offsets", () => {
    const thumb = calculateOverlayThumb({
      viewportStart: 0,
      viewportSize: 100,
      clientSize: 100,
      scrollSize: 10_000,
      scrollOffset: 20_000,
      inset: 2,
      minSize: 24,
    });

    expect(thumb).not.toBeNull();
    expect(thumb!.size).toBe(24);
    expect(thumb!.start).toBe(74);
  });
});

describe("overlay scrollbar wheel target cache", () => {
  test("resolves a gesture's target once", () => {
    let time = 0;
    const resolved: object[] = [];
    const cache = createWheelTargetCache(
      (target: { scrolls: string | null }) => {
        resolved.push(target);
        return target.scrolls;
      },
      () => time,
      250,
    );
    const list = { scrolls: "list" };
    const terminal = { scrolls: null };
    for (let event = 0; event < 100; event++) {
      time += 8;
      expect(cache.get(list)).toBe("list");
    }
    expect(resolved).toEqual([list]);
    // A target that does not scroll is remembered too.
    expect(cache.get(terminal)).toBeNull();
    time += 8;
    expect(cache.get(terminal)).toBeNull();
    expect(resolved).toEqual([list, terminal]);
  });

  test("resolves again after a pause, another target, or a clear", () => {
    let time = 0;
    let resolves = 0;
    const cache = createWheelTargetCache(
      (target: { name: string }) => {
        resolves++;
        return target.name;
      },
      () => time,
      250,
    );
    const a = { name: "a" };
    const b = { name: "b" };
    cache.get(a);
    time += 250;
    cache.get(a);
    expect(resolves).toBe(1);
    time += 251;
    cache.get(a);
    expect(resolves).toBe(2);
    expect(cache.get(b)).toBe("b");
    expect(cache.get(a)).toBe("a");
    expect(resolves).toBe(4);
    cache.clear();
    cache.get(a);
    expect(resolves).toBe(5);
  });
});

describe("overlay scrollbar refresh queue", () => {
  test("takes the newest request that resolves and empties the queue", () => {
    const queue = createRefreshQueue<"scroll" | "wheel", string>();
    const asked: string[] = [];
    const resolve = (kind: string, target: string) => {
      asked.push(`${kind}:${target}`);
      return target === "terminal" ? null : target;
    };
    queue.add("scroll", "sidebar");
    queue.add("wheel", "terminal");
    queue.add("wheel", "terminal");
    expect(queue.take(resolve)).toBe("sidebar");
    expect(asked).toEqual(["wheel:terminal", "scroll:sidebar"]);
    expect(queue.take(resolve)).toBeNull();
    queue.add("scroll", "sidebar");
    queue.add("wheel", "files");
    expect(queue.take(resolve)).toBe("files");
    expect(asked).toHaveLength(3);
  });
});
