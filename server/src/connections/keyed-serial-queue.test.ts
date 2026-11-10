import { expect, test } from "bun:test";
import { createKeyedSerialQueue } from "./keyed-serial-queue";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a slow task cannot be overtaken by a later one for the same key", async () => {
  const queue = createKeyedSerialQueue();
  const slow = deferred();
  const order: string[] = [];
  const first = queue.run("pane", async () => {
    order.push("first:start");
    await slow.promise;
    order.push("first:end");
  });
  const second = queue.run("pane", async () => {
    order.push("second");
  });
  const other = queue.run("other", async () => {
    order.push("other");
  });
  await other;
  expect(order).toEqual(["first:start", "other"]);
  slow.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(["first:start", "other", "first:end", "second"]);
});

test("a failed task does not block its successors and idle keys are dropped", async () => {
  const queue = createKeyedSerialQueue();
  const gate = deferred();
  const failed = queue.run("pane", () => gate.promise);
  const next = queue.run("pane", async () => "ran");
  gate.reject(new Error("boom"));
  await expect(failed).rejects.toThrow("boom");
  expect(await next).toBe("ran");
  await Promise.resolve();
  await Promise.resolve();
  expect(queue.size).toBe(0);
});
