import { describe, expect, jest, test } from "bun:test";
import type { TerminalEngine } from "../../terminalEngine";
import {
  FETCH_TIMEOUT_MS,
  LINES_TTL_MS,
  type PaneScreen,
  PanePreviews,
  SCREEN_LIMIT,
  SCREEN_MAX_AGE_MS,
  terminalScreenText,
} from "./paneSwipePreview";

const font = { fontFamily: "mono", fontSize: 12, lineHeight: 1.1 };
const screen = (text: string, at = 0): PaneScreen => ({
  text,
  kind: "screen",
  font,
  at,
});
const lines = (text: string): PaneScreen => ({
  text,
  kind: "lines",
  font,
  at: 0,
});

describe("pane swipe preview source", () => {
  test("a kept screen is used as is, without a fetch", () => {
    const previews = new PanePreviews();
    previews.keep("a", screen("$ ls", 1000));
    expect(previews.source("a", 1000 + SCREEN_MAX_AGE_MS)).toEqual({
      use: screen("$ ls", 1000),
      fetch: false,
    });
  });

  test("without a current screen the lines are fetched once", async () => {
    const previews = new PanePreviews();
    expect(previews.source("a", 0)).toEqual({ use: null, fetch: true });
    let calls = 0;
    const load = async () => {
      calls++;
      return lines("hello");
    };
    const [first, second] = await Promise.all([
      previews.fetch("a", load, () => 10),
      previews.fetch("a", load, () => 10),
    ]);
    expect(calls).toBe(1);
    expect(first).toEqual(lines("hello"));
    expect(second).toBe(first);
    // Reused for a few seconds, then fetched again.
    expect(previews.source("a", 10 + LINES_TTL_MS)).toEqual({
      use: lines("hello"),
      fetch: false,
    });
    expect(previews.source("a", 11 + LINES_TTL_MS).fetch).toBe(true);
  });

  test("a stale screen shows while fresh lines load", async () => {
    const previews = new PanePreviews();
    previews.keep("a", screen("old", 0));
    const later = SCREEN_MAX_AGE_MS + 1;
    expect(previews.source("a", later)).toEqual({
      use: screen("old", 0),
      fetch: true,
    });
    await previews.fetch(
      "a",
      async () => lines("new"),
      () => later,
    );
    expect(previews.source("a", later).use?.text).toBe("new");
  });

  test("a failed or slow fetch is not retried for a few seconds", async () => {
    const previews = new PanePreviews();
    let calls = 0;
    const fail = async (): Promise<PaneScreen | null> => {
      calls++;
      throw new Error("offline");
    };
    expect(await previews.fetch("a", fail, () => 0)).toBeNull();
    expect(previews.source("a", 100)).toEqual({ use: null, fetch: false });
    expect(calls).toBe(1);

    jest.useFakeTimers();
    try {
      let settled = false;
      const never = new Promise<PaneScreen | null>(() => undefined);
      const slow = previews.fetch(
        "b",
        () => never,
        () => 0,
      );
      void slow.then(() => {
        settled = true;
      });
      jest.advanceTimersByTime(FETCH_TIMEOUT_MS - 1);
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      expect(await slow).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("keeps the few most recently used screens", () => {
    const previews = new PanePreviews();
    for (let i = 0; i <= SCREEN_LIMIT; i++)
      previews.keep(`t${i}`, screen(`${i}`));
    // The oldest is gone; using one makes it the most recent.
    expect(previews.source("t0", 0).fetch).toBe(true);
    expect(previews.source("t1", 0).use?.text).toBe("1");
    previews.keep("extra", screen("x"));
    expect(previews.source("t1", 0).use?.text).toBe("1");
    expect(previews.source("t2", 0).fetch).toBe(true);
  });
});

test("a terminal's screen is its visible rows, trailing blanks trimmed", () => {
  const rows = ["old", "$ echo hi", "hi", "$ ", "", ""];
  const term = {
    rows: 4,
    buffer: {
      active: {
        viewportY: 1,
        getLine: (y: number) =>
          y < rows.length
            ? { translateToString: () => rows[y].trimEnd() }
            : undefined,
      },
    },
  } as unknown as TerminalEngine;
  expect(terminalScreenText(term)).toBe("$ echo hi\nhi\n$");
});
