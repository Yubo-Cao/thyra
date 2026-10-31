import { expect, test } from "bun:test";
import { keysymOf, viewerScale } from "./agentBrowser";
import { isTaskNotificationTarget } from "./taskNotifications";

test("typed characters map to X11 keysyms", () => {
  expect(keysymOf("a")).toBe(0x61);
  expect(keysymOf("é")).toBe(0xe9);
  expect(keysymOf("中")).toBe(0x01004e2d);
  expect(keysymOf("😀")).toBe(0x0101f600);
});

test("notification targets may ask for the agent browser view", () => {
  const target = {
    connectionId: "c",
    runtimeGeneration: 1,
    workspaceId: "w",
    paneId: "w:p1",
  };
  expect(isTaskNotificationTarget({ ...target, view: "browser" })).toBe(true);
  expect(isTaskNotificationTarget({ ...target, view: "other" })).toBe(false);
});

test("draws the remote at the screen's pixel density, 1 to 3", () => {
  expect(viewerScale(1)).toBe(1);
  expect(viewerScale(1.25)).toBe(1.25);
  expect(viewerScale(1.1)).toBe(1);
  expect(viewerScale(2)).toBe(2);
  expect(viewerScale(3.5)).toBe(3);
  expect(viewerScale(0.9)).toBe(1);
});
