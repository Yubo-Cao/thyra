import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { LOCAL_PRINCIPAL } from "../auth/principal";
import type { RpcServices } from "./context";
import { createRpcDispatcher } from "./dispatch";

type Ws = ServerWebSocket<unknown>;

/** A dispatcher over one ready connection with scripted collaborators. */
function harness() {
  const sent: any[] = [];
  const acks: unknown[][] = [];
  const terminalRpcs: unknown[][] = [];
  const forgotten: string[] = [];
  const leave = { fail: false, calls: 0 };
  let current = true;
  const collaboration = {
    call: async (method: string) => {
      if (method === "collaboration.leave") {
        leave.calls += 1;
        if (leave.fail) throw new Error("herdr unavailable");
      }
      return { ok: true };
    },
  };
  const runtime = {
    collaboration,
    claims: { observeResult: () => undefined, get: () => null },
    presenceContext: {},
    files: { fileRpc: {}, fileManagerRpc: {} },
    terminalBridge: {
      currentTerminalId: () => "t-current",
      acknowledgeFrame: (...args: unknown[]) => {
        acks.push(args.slice(1));
        return true;
      },
      handleTerminalRpc: async (...args: unknown[]) => {
        terminalRpcs.push(args.slice(1, 4));
      },
    },
  };
  const ws = {} as Ws;
  const clients = new Set<Ws>([ws]);
  const socketPresence = new Map<Ws, unknown>();
  const services = {
    clients,
    socketPrincipals: new WeakMap([[ws, LOCAL_PRINCIPAL]]),
    participantIds: new WeakMap([[ws, "web-1"]]),
    socketPresence,
    safeSend: (_ws: Ws, payload: string) => {
      sent.push(JSON.parse(payload));
      return true;
    },
    markRpcError: () => undefined,
    authzDeps: {
      roleOn: () => "owner",
      locate: async () => ({ workspace: "w1", pane: "w1:p1" }),
      claimOf: () => null,
      principalOfParticipant: () => null,
    },
    connectionManager: {
      defaultId: () => "local",
      has: (id: string) => id === "local",
      readyRuntimeLease: (id: string) =>
        id === "local"
          ? {
              connectionId: id,
              generation: 1,
              runtime,
              isCurrent: () => current,
            }
          : null,
    },
    clientIdentity: {
      forgetParticipant: (id: string) => forgotten.push(id),
      annotateResult: (result: unknown) => result,
    },
    viewerRoles: () => null,
    scopedPaneOf: () => null,
    freshScope: async () => null,
  } as unknown as RpcServices;
  const handleRpc = createRpcDispatcher(services);
  return {
    ws,
    sent,
    acks,
    terminalRpcs,
    forgotten,
    leave,
    clients,
    socketPresence,
    collaboration,
    send: (value: Record<string, unknown>) => handleRpc(ws, { value }),
    retire: () => {
      current = false;
    },
  };
}

test("a frame acknowledgement without an id is applied and never answered", async () => {
  const h = harness();
  await h.send({
    method: "terminal.frame_ack",
    params: { terminal_id: "t1", seq: 7 },
    connection_id: "local",
    connection_generation: 1,
  });
  expect(h.acks).toEqual([["t1", { terminal_id: "t1", seq: 7 }]]);
  // Without a terminal id it is the socket's current terminal, as for requests.
  await h.send({ method: "terminal.frame_ack", params: { seq: 8 } });
  expect(h.acks[1]).toEqual([
    "t-current",
    { seq: 8, terminal_id: "t-current" },
  ]);
  expect(h.sent).toEqual([]);
  expect(h.terminalRpcs).toEqual([]);
});

test("a one-way message that cannot be routed is dropped without a reply", async () => {
  const h = harness();
  await h.send({
    method: "terminal.frame_ack",
    params: { terminal_id: "t1", seq: 7 },
    connection_id: "missing",
  });
  await h.send({
    method: "terminal.frame_ack",
    params: { terminal_id: "t1", seq: 7 },
    connection_id: "local",
    connection_generation: 2,
  });
  h.retire();
  await h.send({
    method: "terminal.frame_ack",
    params: { terminal_id: "t1", seq: 7 },
    connection_id: "local",
  });
  expect(h.acks).toEqual([]);
  expect(h.sent).toEqual([]);
});

test("only acknowledgements may omit the id", async () => {
  const h = harness();
  await h.send({
    method: "terminal.input",
    params: { terminal_id: "t1", data: "YQ==" },
    connection_id: "local",
  });
  expect(h.terminalRpcs).toEqual([]);
  expect(h.sent).toEqual([
    { connection_id: "local", error: { message: "missing id/method" } },
  ]);
});

test("the request forms of older pages still reach the terminal bridge", async () => {
  const h = harness();
  await h.send({
    id: "ack-1",
    method: "terminal.frame_ack",
    params: { terminal_id: "t1", seq: 7 },
    connection_id: "local",
  });
  await h.send({
    id: "key-1",
    method: "terminal.input",
    params: { terminal_id: "t1", data: "YQ==" },
    connection_id: "local",
  });
  expect(h.acks).toEqual([]);
  expect(h.terminalRpcs).toEqual([
    ["ack-1", "terminal.frame_ack", { terminal_id: "t1", seq: 7 }],
    ["key-1", "terminal.input", { terminal_id: "t1", data: "YQ==" }],
  ]);
});

test("a failed collaboration.leave keeps the socket's presence for a retry", async () => {
  const h = harness();
  h.socketPresence.set(h.ws, h.collaboration);
  h.leave.fail = true;
  await h.send({
    id: "leave-1",
    method: "collaboration.leave",
    connection_id: "local",
  });
  expect(h.sent).toEqual([
    {
      connection_id: "local",
      connection_generation: 1,
      id: "leave-1",
      error: { message: "herdr unavailable" },
    },
  ]);
  // Still present upstream: closing the socket or a retry can leave for it.
  expect(h.socketPresence.get(h.ws)).toBe(h.collaboration);
  expect(h.forgotten).toEqual([]);

  h.leave.fail = false;
  await h.send({
    id: "leave-2",
    method: "collaboration.leave",
    connection_id: "local",
  });
  expect(h.sent[1]).toMatchObject({ id: "leave-2", result: { ok: true } });
  expect(h.socketPresence.has(h.ws)).toBe(false);
  expect(h.forgotten).toEqual(["web-1"]);
});

test("a failed collaboration.leave does not revive a closed socket's presence", async () => {
  const h = harness();
  h.socketPresence.set(h.ws, h.collaboration);
  h.leave.fail = true;
  h.clients.delete(h.ws);
  await h.send({
    id: "leave-1",
    method: "collaboration.leave",
    connection_id: "local",
  });
  expect(h.socketPresence.has(h.ws)).toBe(false);
});
