import { expect, test } from "bun:test";
import {
  lastStepCompletionKey,
  lastStepCompletions,
  publishLastStepCompletion,
} from "./lastStepCompletionStore";

test("publishes non-collapsible workspace completion revisions", () => {
  const key = lastStepCompletionKey("local", "workspace");
  const otherKey = lastStepCompletionKey("remote", "workspace");
  let notifications = 0;
  const unsubscribe = lastStepCompletions.subscribe(() => {
    notifications += 1;
  });

  publishLastStepCompletion("local", "workspace");
  publishLastStepCompletion("local", "workspace");
  unsubscribe();

  expect(lastStepCompletions.getState()[key]).toBe(2);
  expect(lastStepCompletions.getState()[otherKey]).toBeUndefined();
  expect(notifications).toBe(2);
});
