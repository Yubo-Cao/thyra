import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NOTICE_AUTO_DISMISS_MS,
  nextRecentPaneIds,
  noticeAutoDismissDelay,
} from "./core";

describe("notice dismissal policy", () => {
  test("uses 15 seconds for an ordinary toast", () => {
    expect(DEFAULT_NOTICE_AUTO_DISMISS_MS).toBe(15_000);
    expect(noticeAutoDismissDelay({ kind: "info", message: "Saved" })).toBe(
      15_000,
    );
  });

  test("honors explicit durations and keeps loading notices visible", () => {
    expect(
      noticeAutoDismissDelay({
        kind: "success",
        message: "Copied",
        autoDismissMs: 5_000,
      }),
    ).toBe(5_000);
    expect(
      noticeAutoDismissDelay({
        kind: "info",
        message: "Working",
        loading: true,
      }),
    ).toBeNull();
  });
});

describe("recent pane history", () => {
  const panes = Array.from({ length: 14 }, (_, index) => ({
    pane_id: `pane-${index + 1}`,
  }));

  test("moves the selected pane to the front without duplicates", () => {
    expect(
      nextRecentPaneIds("pane-2", ["pane-1", "pane-2", "pane-3"], panes),
    ).toEqual(["pane-2", "pane-1", "pane-3"]);
  });

  test("prunes missing panes and keeps the history bounded", () => {
    expect(
      nextRecentPaneIds(
        "pane-14",
        ["missing", ...panes.map((pane) => pane.pane_id)],
        panes,
      ),
    ).toEqual([
      "pane-14",
      "pane-1",
      "pane-2",
      "pane-3",
      "pane-4",
      "pane-5",
      "pane-6",
      "pane-7",
      "pane-8",
      "pane-9",
      "pane-10",
      "pane-11",
    ]);
  });

  test("does not add a pane that is no longer live", () => {
    expect(nextRecentPaneIds("missing", ["pane-1", "missing"], panes)).toEqual([
      "pane-1",
    ]);
  });
});
