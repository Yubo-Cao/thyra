import { expect, test } from "bun:test";
import { singleFlight } from "./single-flight";

test("concurrent callers share one call and later callers start a new one", async () => {
  const pending: Array<{
    resolve: (value: number) => void;
    reject: (error: Error) => void;
  }> = [];
  const list = singleFlight(
    () =>
      new Promise<number>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );

  const first = list();
  const second = list();
  expect(pending).toHaveLength(1);
  pending[0]?.resolve(1);
  expect(await Promise.all([first, second])).toEqual([1, 1]);

  const failed = list();
  expect(pending).toHaveLength(2);
  pending[1]?.reject(new Error("unreachable"));
  await expect(failed).rejects.toThrow("unreachable");

  const third = list();
  expect(pending).toHaveLength(3);
  pending[2]?.resolve(3);
  expect(await third).toBe(3);
});
