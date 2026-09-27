import { describe, expect, test } from "bun:test";
import {
  browserCountLabel,
  browserTransportPresentation,
} from "./browserTransport";

describe("browser transport presentation", () => {
  test("offers pause controls and counts only other connected browsers", () => {
    expect(browserTransportPresentation(false, "connected", 3)).toEqual({
      label: "Browser connected to bridge",
      clientCount: 3,
      countLabel: "3 browsers",
      pauseOthersLabel: "Pause other browsers (2)",
      needsResume: false,
      toggleLabel: "Pause browser sync",
    });
  });

  test("labels a single other browser and hides the action when alone", () => {
    expect(
      browserTransportPresentation(false, "connected", 2).pauseOthersLabel,
    ).toBe("Pause other browser");
    expect(
      browserTransportPresentation(false, "connected", 1).pauseOthersLabel,
    ).toBeNull();
  });

  test("offers resume while paused without exposing a stale client count", () => {
    expect(browserTransportPresentation(true, "connected", 3)).toEqual({
      label: "Browser sync paused",
      clientCount: null,
      countLabel: null,
      pauseOthersLabel: null,
      needsResume: true,
      toggleLabel: "Resume browser sync",
    });
  });

  test("offers reconnect after browser transport loss", () => {
    expect(browserTransportPresentation(false, "disconnected", 3)).toEqual({
      label: "Browser disconnected from bridge",
      clientCount: null,
      countLabel: null,
      pauseOthersLabel: null,
      needsResume: true,
      toggleLabel: "Reconnect browser",
    });
  });

  test("keeps connecting transport pausable", () => {
    expect(browserTransportPresentation(false, "connecting", null)).toEqual({
      label: "Browser connecting to bridge",
      clientCount: null,
      countLabel: null,
      pauseOthersLabel: null,
      needsResume: false,
      toggleLabel: "Pause browser sync",
    });
  });

  test("groups browsers by device and pauses every other browser", () => {
    const presentation = browserTransportPresentation(false, "connected", 3, 2);
    expect(presentation.countLabel).toBe("3 browsers on 2 devices");
    // Pausing still reaches each other browser, including this device's tabs.
    expect(presentation.pauseOthersLabel).toBe("Pause other browsers (2)");
    expect(browserCountLabel(2, 1)).toBe("2 browsers on 1 device");
    expect(browserCountLabel(1, 1)).toBe("1 browser");
    expect(browserCountLabel(2, undefined)).toBe("2 browsers");
  });
});
