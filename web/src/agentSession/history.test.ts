import { describe, expect, test } from "bun:test";
import { AGENT_SESSION_HISTORY_LIMIT } from "../../../shared/agentSession";
import { installCatalog } from "../i18n";
import { storedSessionAge, storedSessions } from "./history";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("stored agent conversations", () => {
  test("a history reply keeps its usable entries in order", () => {
    const a = { id: "a", title: "First", updated_at: 2 };
    const b = { id: "b", title: "", updated_at: 1 };
    expect(
      storedSessions({
        sessions: [
          a,
          null,
          { id: 3, title: "no ID", updated_at: 1 },
          { id: "c", updated_at: 1 },
          { id: "d", title: "no time", updated_at: "yesterday" },
          b,
        ],
      }),
    ).toEqual([a, b]);
  });

  test("a reply without a list has no conversations", () => {
    expect(storedSessions(undefined)).toEqual([]);
    expect(storedSessions(null)).toEqual([]);
    expect(storedSessions({})).toEqual([]);
    expect(storedSessions({ sessions: "none" })).toEqual([]);
  });

  test("a reply longer than the limit is cut to it", () => {
    const sessions = Array.from(
      { length: AGENT_SESSION_HISTORY_LIMIT + 5 },
      (_, index) => ({ id: `s${index}`, title: "x", updated_at: index }),
    );
    const kept = storedSessions({ sessions });
    expect(kept).toHaveLength(AGENT_SESSION_HISTORY_LIMIT);
    expect(kept[0].id).toBe("s0");
  });

  test("an age reads in whole units of the largest that fits", () => {
    const now = Date.UTC(2026, 5, 12, 12);
    const age = (ms: number) => storedSessionAge(now - ms, now);
    expect(age(0)).toBe("now");
    expect(age(59_000)).toBe("now");
    expect(age(MINUTE)).toBe("1 minute ago");
    expect(age(59 * MINUTE + 59_000)).toBe("59 minutes ago");
    expect(age(HOUR)).toBe("1 hour ago");
    expect(age(23 * HOUR + 59 * MINUTE)).toBe("23 hours ago");
    expect(age(DAY)).toBe("yesterday");
    expect(age(6 * DAY + 23 * HOUR)).toBe("6 days ago");
    expect(age(7 * DAY)).toBe("last week");
    expect(age(29 * DAY)).toBe("4 weeks ago");
    expect(age(30 * DAY)).toBe("last month");
    expect(age(364 * DAY)).toBe("12 months ago");
    expect(age(365 * DAY)).toBe("last year");
    expect(age(800 * DAY)).toBe("2 years ago");
  });

  test("a time ahead of this clock reads as now", () => {
    expect(storedSessionAge(5000, 1000)).toBe("now");
  });

  test("ages follow the interface language", () => {
    installCatalog("zh-CN", {});
    try {
      expect(storedSessionAge(0, 3 * HOUR)).toBe("3小时前");
      expect(storedSessionAge(0, DAY)).toBe("昨天");
    } finally {
      installCatalog("en", {});
    }
  });
});
