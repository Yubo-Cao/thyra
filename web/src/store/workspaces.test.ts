import { describe, expect, test } from "bun:test";
import { numberedCreatedTabRename } from "./workspaces";

describe("numbered tab creation", () => {
  test("uses the authoritative number returned by Herdr", () => {
    expect(
      numberedCreatedTabRename({
        type: "tab_created",
        tab: { tab_id: "w1:t7", number: 7, label: "7" },
      }),
    ).toEqual({ tabId: "w1:t7", label: "Tab 7" });
  });

  test("rejects malformed or unrelated responses", () => {
    expect(numberedCreatedTabRename(null)).toBeNull();
    expect(
      numberedCreatedTabRename({
        type: "tab_info",
        tab: { tab_id: "w1:t2", number: 2 },
      }),
    ).toBeNull();
    expect(
      numberedCreatedTabRename({
        type: "tab_created",
        tab: { tab_id: "w1:t2" },
      }),
    ).toBeNull();
    expect(
      numberedCreatedTabRename({
        type: "tab_created",
        tab: { tab_id: "w1:t2", number: 0 },
      }),
    ).toBeNull();
  });
});
