import { expect, test } from "bun:test";
import {
  acknowledgeTerminalFrame,
  requestTerminalResync,
} from "./terminalFrameAck";

function fakeClient(options: { capability: boolean; notifySends?: boolean }) {
  const calls: unknown[][] = [];
  const notes: unknown[][] = [];
  return {
    calls,
    notes,
    client: {
      call: async (method: string, params?: Record<string, unknown>) => {
        calls.push([method, params]);
        return { ok: true };
      },
      supports: () => options.capability,
      notify: (method: string, params?: Record<string, unknown>) => {
        notes.push([method, params]);
        return options.notifySends ?? true;
      },
    },
  };
}

test("a frame is acknowledged one-way when the bridge accepts that", () => {
  const { client, calls, notes } = fakeClient({ capability: true });
  acknowledgeTerminalFrame(client, "t1", 12);
  expect(notes).toEqual([
    ["terminal.frame_ack", { terminal_id: "t1", seq: 12 }],
  ]);
  expect(calls).toEqual([]);
});

test("an older bridge gets the acknowledgement as a request", () => {
  const { client, calls, notes } = fakeClient({ capability: false });
  acknowledgeTerminalFrame(client, "t1", 12);
  expect(notes).toEqual([]);
  expect(calls).toEqual([
    ["terminal.frame_ack", { terminal_id: "t1", seq: 12 }],
  ]);
});

test("a client without one-way messages acknowledges by request", () => {
  const calls: unknown[][] = [];
  acknowledgeTerminalFrame(
    {
      call: async (method, params) => {
        calls.push([method, params]);
      },
    },
    "t1",
    12,
  );
  expect(calls).toHaveLength(1);
});

test("an acknowledgement that could not be sent one-way falls back to a request", () => {
  const { client, calls } = fakeClient({
    capability: true,
    notifySends: false,
  });
  acknowledgeTerminalFrame(client, "t1", 12);
  expect(calls).toHaveLength(1);
});

test("a failed acknowledgement request is not an unhandled rejection", async () => {
  acknowledgeTerminalFrame(
    { call: () => Promise.reject(new Error("timeout")) },
    "t1",
    12,
  );
  await Bun.sleep(0);
});

test("a resync is requested with a reply on every bridge", () => {
  const { client, calls, notes } = fakeClient({ capability: true });
  requestTerminalResync(client, "t1");
  expect(notes).toEqual([]);
  expect(calls).toEqual([
    ["terminal.frame_ack", { terminal_id: "t1", resync: true }],
  ]);
});
