import { describe, expect, test } from "bun:test";
import { bridge } from "../api";
import { __storeTesting, store } from "./index";
import { action, noticeFor } from "./actions";

/** Runs `body` with a fake connection whose liveness the test controls. */
async function withConnection(
  body: (connection: { current: boolean }) => Promise<void>,
) {
  const originalConnection = bridge.connection;
  const previous = store.get();
  const connection = { current: true };
  bridge.connection = ((connectionId: string) => ({
    connectionId,
    generation: 1,
    isCurrent: () => connection.current,
  })) as unknown as typeof bridge.connection;
  try {
    __storeTesting.replaceState({
      ...previous,
      status: "connected",
      connectionPaused: false,
      error: null,
      notice: null,
    });
    await body(connection);
  } finally {
    bridge.connection = originalConnection;
    __storeTesting.replaceState(previous);
  }
}

const progress = { kind: "info", message: "Working", loading: true } as const;
const failed = (error: Error) =>
  ({ kind: "error", message: "Failed", detail: error.message }) as const;

describe("action progress notices", () => {
  test("a rejection after the connection dropped ends the progress notice", () =>
    withConnection(async (connection) => {
      const call = Promise.withResolvers<void>();
      const running = action(
        async (lease) => {
          noticeFor(lease, progress);
          await call.promise;
        },
        { failureNotice: failed },
      );
      expect(store.get().notice).toMatchObject(progress);
      connection.current = false;
      call.reject(new Error("bridge disconnected"));
      expect(await running).toBeUndefined();
      expect(store.get().notice).toMatchObject({
        kind: "error",
        message: "Failed",
        detail: "bridge disconnected",
      });
      expect(store.get().notice?.loading).toBeUndefined();
    }));

  test("a reply for a dropped connection clears the progress notice", () =>
    withConnection(async (connection) => {
      const call = Promise.withResolvers<string>();
      const running = action(async (lease) => {
        noticeFor(lease, progress);
        return call.promise;
      });
      connection.current = false;
      call.resolve("late");
      expect(await running).toBeUndefined();
      expect(store.get().notice).toBeNull();
    }));

  test("a newer notice is left alone", () =>
    withConnection(async (connection) => {
      const call = Promise.withResolvers<void>();
      const running = action(
        async (lease) => {
          noticeFor(lease, progress);
          await call.promise;
        },
        { failureNotice: failed },
      );
      store.notify({ kind: "info", message: "Reconnecting", loading: true });
      connection.current = false;
      call.reject(new Error("bridge disconnected"));
      await running;
      expect(store.get().notice).toMatchObject({ message: "Reconnecting" });
    }));

  test("a failure without its own notice still ends the progress notice", () =>
    withConnection(async () => {
      const running = action(async (lease) => {
        noticeFor(lease, progress);
        throw new Error("refused");
      });
      await running;
      expect(store.get().notice).toBeNull();
      expect(store.get().error).toBe("refused");
    }));
});
