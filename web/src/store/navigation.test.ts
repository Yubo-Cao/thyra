import { describe, expect, test } from "bun:test";
import {
  __storeTesting,
  navigateProgrammatically,
  onUserNavigation,
  store,
} from "./index";

describe("user navigation signal", () => {
  test("fires for the user's navigation, not for programmatic navigation", async () => {
    const previous = store.get();
    __storeTesting.replaceState({
      ...previous,
      workspaces: [],
      tabs: [],
      panes: [],
    });
    let count = 0;
    const off = onUserNavigation(() => {
      count += 1;
    });
    try {
      await store.focusWorkspace("missing");
      await store.focusTab("missing");
      await store.focusPane("missing");
      expect(count).toBe(3);
      await navigateProgrammatically(() => store.focusPane("missing"));
      expect(count).toBe(3);
    } finally {
      off();
      __storeTesting.replaceState(previous);
    }
  });
});
