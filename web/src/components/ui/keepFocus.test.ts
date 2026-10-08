import { expect, test } from "bun:test";
import { keepFocus } from "./keepFocus";

test("keepFocus cancels the event's default action", () => {
  let cancelled = 0;
  keepFocus({ preventDefault: () => cancelled++ });
  expect(cancelled).toBe(1);
});
