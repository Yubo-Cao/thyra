import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { GuiSettings } from "../config/gui-settings";
import { createSettingsRpcHandler } from "./settings-rpc";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("terminal transport settings validate input, persist by connection, and reconnect only on change", async () => {
  let settings: GuiSettings = {
    version: 1,
    custom: { keep: true },
    terminal_transport: { beta: { surface_codecs: false } },
  };
  const changed: boolean[] = [];
  const messages: any[] = [];
  let writes = 0;
  let failWrite = false;
  let cancelAfterWrite = false;
  let valid = true;
  const handler = createSettingsRpcHandler({
    connectionId: "alpha",
    connectionGeneration: 3,
    readSettings: async () => settings,
    updateSettings: async (update, isCurrent) => {
      expect(isCurrent?.()).toBe(true);
      if (failWrite) throw new Error("write failed");
      settings = await update(settings);
      writes++;
      if (cancelAfterWrite) valid = false;
      return settings;
    },
    onTerminalTransportSettingsChanged: (value) => {
      expect(settings.terminal_transport?.alpha.surface_codecs).toBe(value);
      changed.push(value);
    },
    safeSend: (_ws, payload) => {
      messages.push(JSON.parse(payload));
      return true;
    },
    markRpcError: () => {},
  });
  const call = (
    method: string,
    params: Record<string, unknown> = {},
    current = true,
  ) =>
    handler(
      {} as ServerWebSocket<unknown>,
      "settings",
      `settings.terminal_transport.${method}`,
      params,
      () => current && valid,
    );
  await call("get");
  expect(messages.at(-1)).toMatchObject({
    connection_id: "alpha",
    connection_generation: 3,
    result: { surface_codecs: true },
  });
  for (const params of [
    {},
    { surface_codecs: "false" },
    { surface_codecs: false, connection_id: "beta" },
  ]) {
    await call("update", params);
    expect(messages.at(-1).error.message).toContain("boolean surface_codecs");
  }
  expect(writes).toBe(0);
  await call("update", { surface_codecs: false });
  await call("get");
  expect(messages.at(-1).result).toEqual({ surface_codecs: false });
  await call("update", { surface_codecs: false });
  expect(changed).toEqual([false]);
  await call("update", { surface_codecs: true });
  expect(changed).toEqual([false, true]);
  expect(settings.terminal_transport?.beta.surface_codecs).toBe(false);
  expect(settings.custom).toEqual({ keep: true });
  failWrite = true;
  await call("update", { surface_codecs: false });
  expect(messages.at(-1).error.message).toBe("write failed");
  expect(changed).toEqual([false, true]);
  const before = writes;
  await call("update", { surface_codecs: false }, false);
  expect(writes).toBe(before);
  expect(changed).toEqual([false, true]);
  failWrite = false;
  cancelAfterWrite = true;
  await call("update", { surface_codecs: false });
  expect(changed).toEqual([false, true, false]);
  expect(messages.at(-1).error).toBeDefined();
});

test("settings RPC errors carry their runtime connection identity", async () => {
  const messages: string[] = [];
  const handler = createSettingsRpcHandler({
    connectionId: "remote-dev",
    connectionGeneration: 6,
    safeSend: (_ws, payload) => {
      messages.push(payload);
      return true;
    },
    markRpcError: () => undefined,
  });

  await handler(
    {} as ServerWebSocket<unknown>,
    "settings-id",
    "settings.unknown",
    {},
  );

  expect(messages.map((message) => JSON.parse(message))).toEqual([
    {
      connection_id: "remote-dev",
      connection_generation: 6,
      id: "settings-id",
      error: { message: "unknown settings method: settings.unknown" },
    },
  ]);
});

test("settings RPC suppresses a delayed result after replacement", async () => {
  const settings = deferred<GuiSettings>();
  const messages: string[] = [];
  let current = true;
  const handler = createSettingsRpcHandler({
    connectionId: "remote-dev",
    readSettings: () => settings.promise,
    safeSend: (_ws, payload) => {
      messages.push(payload);
      return true;
    },
    markRpcError: () => undefined,
  });

  const pending = handler(
    {} as ServerWebSocket<unknown>,
    "settings-delayed",
    "settings.terminal_transport.get",
    {},
    () => current,
  );
  current = false;
  settings.resolve({ version: 1, custom: {} });
  await pending;

  expect(messages.map((message) => JSON.parse(message))).toEqual([
    {
      connection_id: "remote-dev",
      id: "settings-delayed",
      error: { message: "connection changed during request" },
    },
  ]);
});

test("settings RPC cancels a queued mutation after replacement", async () => {
  const mutationGate = deferred<void>();
  let current = true;
  let notifications = 0;
  let settings: GuiSettings = {
    version: 1,
    terminal_transport: { alpha: { surface_codecs: true } },
    custom: {},
  };
  const messages: string[] = [];
  const handler = createSettingsRpcHandler({
    connectionId: "alpha",
    readSettings: async () => settings,
    updateSettings: async (update, shouldCommit = () => true) => {
      await mutationGate.promise;
      if (!shouldCommit()) throw new Error("settings update cancelled");
      settings = await update(settings);
      return settings;
    },
    onTerminalTransportSettingsChanged: () => {
      notifications += 1;
    },
    safeSend: (_ws, payload) => {
      messages.push(payload);
      return true;
    },
    markRpcError: () => undefined,
  });

  const pending = handler(
    {} as ServerWebSocket<unknown>,
    "stale-mutation",
    "settings.terminal_transport.update",
    { surface_codecs: false },
    () => current,
  );
  current = false;
  mutationGate.resolve(undefined);
  await pending;

  expect(settings.terminal_transport?.alpha.surface_codecs).toBe(true);
  expect(notifications).toBe(0);
  expect(JSON.parse(messages[0])).toMatchObject({
    connection_id: "alpha",
    id: "stale-mutation",
    error: { message: "connection changed during request" },
  });
});
