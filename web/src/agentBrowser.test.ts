import { expect, test } from "bun:test";
import { keysymOf } from "./agentBrowser";
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
