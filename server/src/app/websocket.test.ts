import { expect, jest, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { LOCAL_PRINCIPAL, type Principal } from "../auth/principal";
import { createClientRegistry } from "../bridge/client-registry";
import type { SocketData } from "../bridge/socket-data";
import type { ParsedRpcMessage } from "../rpc/logging";
import type { Logger } from "../utils/logger";
import { createSocketTransports } from "./websocket";

type Socket = ServerWebSocket<SocketData>;

const logger = new Proxy(
  {},
  {
    get: (_target, key) => (key === "child" ? () => logger : () => undefined),
  },
) as Logger;

/**
 * The real socket handlers and client registry around a scripted dispatcher,
 * so a test decides when each request's awaited checks settle.
 */
function harness(
  handleRpc: (
    ws: ServerWebSocket<unknown>,
    request: { id?: string; method: string; params?: Record<string, any> },
  ) => Promise<unknown>,
) {
  const proxyClosed: string[] = [];
  const registry = createClientRegistry({
    logger,
    clientIdentity: () =>
      ({
        detach: () => undefined,
        deviceKeyOf: () => null,
        forgetParticipant: () => undefined,
      }) as never,
    connectionManager: () =>
      ({ forEachCurrentRuntime: () => undefined }) as never,
  });
  const { websocketHandlers } = createSocketTransports({
    bootstrap: {
      config: { socketPath: "/tmp/herdr.sock" },
      logger,
      webEntry: () => null,
    } as never,
    registry,
    accounts: {
      clientIdentity: {
        attach: () => undefined,
        participantId: (_ws: unknown, session: string | null) =>
          `web-${session}`,
      },
    } as never,
    connections: { connectionManager: { defaultId: () => "local" } } as never,
    vscodeProxy: {
      openSocket: () => ({
        message: () => undefined,
        close: () => proxyClosed.push("vscode"),
      }),
    } as never,
    agentBrowser: {
      openVnc: () => ({
        message: () => undefined,
        close: () => proxyClosed.push("vnc"),
      }),
    } as never,
    rtcConfig: { enabled: false, iceServers: [], portRange: null },
    handleRpc: (ws, message: ParsedRpcMessage) =>
      handleRpc(ws, message?.value as never),
  });
  const open = (
    name: string,
    data: Partial<SocketData> = {},
    principal: Principal = LOCAL_PRINCIPAL,
  ) => {
    const sent: any[] = [];
    const closed: [number?, string?][] = [];
    const ws = {
      data: {
        principal,
        clientSession: name,
        directOrigin: null,
        rtc: false,
        ...data,
      },
      send(payload: string) {
        sent.push(JSON.parse(payload));
        return payload.length;
      },
      getBufferedAmount: () => 0,
      close(code?: number, reason?: string) {
        closed.push([code, reason]);
        websocketHandlers.close?.(ws, code ?? 1000, reason ?? "");
      },
    } as unknown as Socket & { close(code?: number, reason?: string): void };
    websocketHandlers.open?.(ws);
    return { ws, sent, closed };
  };
  const receive = (ws: Socket, message: Record<string, unknown>) =>
    websocketHandlers.message(ws, JSON.stringify(message));
  return { registry, open, receive, proxyClosed };
}

const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

test("the hello names the terminal protocol capabilities", () => {
  const { open } = harness(async () => undefined);
  const { sent } = open("page");
  expect(sent[0]).toMatchObject({
    hello: true,
    capabilities: {
      connection_id: true,
      terminal_input_pipeline: true,
      terminal_frame_ack_notify: true,
    },
  });
});

test("pipelined input is written in arrival order when its checks settle out of order", async () => {
  jest.useFakeTimers();
  try {
    const written: string[] = [];
    // Each request's authorization takes less time than the one before it.
    const checkMs: Record<string, number> = { k1: 300, k2: 200, k3: 100 };
    const { open, receive } = harness(async (_ws, request) => {
      await new Promise((resolve) =>
        setTimeout(resolve, checkMs[request.id!] ?? 0),
      );
      written.push(`${request.params?.terminal_id}:${request.id}`);
    });
    const page = open("page");
    const other = open("other");
    for (const id of ["k1", "k2", "k3"])
      receive(page.ws, {
        id,
        method: id === "k2" ? "terminal.key" : "terminal.input",
        params: { terminal_id: "t1" },
        connection_id: "local",
      });
    // Another terminal of the page and another page are not held up.
    receive(page.ws, {
      id: "x1",
      method: "terminal.input",
      params: { terminal_id: "t2" },
      connection_id: "local",
    });
    receive(other.ws, {
      id: "o1",
      method: "terminal.input",
      params: { terminal_id: "t1" },
      connection_id: "local",
    });
    jest.advanceTimersByTime(0);
    await settle();
    expect(written).toEqual(["t2:x1", "t1:o1"]);
    for (let elapsed = 0; elapsed < 600; elapsed += 100) {
      jest.advanceTimersByTime(100);
      await settle();
    }
    expect(written).toEqual(["t2:x1", "t1:o1", "t1:k1", "t1:k2", "t1:k3"]);
  } finally {
    jest.useRealTimers();
  }
});

test("a rejected input answers its own request and does not stall the next", async () => {
  const written: string[] = [];
  const { open, receive } = harness(async (_ws, request) => {
    await Promise.resolve();
    if (request.id === "k1")
      throw new Error("another collaborator controls this pane");
    written.push(request.id!);
  });
  const page = open("page");
  for (const id of ["k1", "k2"])
    receive(page.ws, {
      id,
      method: "terminal.input",
      params: { terminal_id: "t1" },
      connection_id: "local",
    });
  await settle();
  expect(written).toEqual(["k2"]);
  expect(page.sent.slice(1)).toEqual([
    {
      connection_id: "local",
      id: "k1",
      error: { message: "another collaborator controls this pane" },
    },
  ]);
});

test("an input that waits for nothing starts when it arrives", () => {
  const started: string[] = [];
  const { open, receive } = harness(async (_ws, request) => {
    started.push(request.id!);
  });
  const page = open("page");
  // A page that sends one input at a time (before pipelining) is not delayed.
  receive(page.ws, {
    id: "k1",
    method: "terminal.input",
    params: { terminal_id: "t1" },
  });
  expect(started).toEqual(["k1"]);
});

test("a one-way message reaches the dispatcher and is never answered", async () => {
  const seen: unknown[] = [];
  const { open, receive, registry } = harness(async (_ws, request) => {
    seen.push(request);
  });
  const page = open("page");
  receive(page.ws, {
    method: "terminal.frame_ack",
    params: { terminal_id: "t1", seq: 4 },
    connection_id: "local",
  });
  await settle();
  expect(seen).toHaveLength(1);
  expect(page.sent).toHaveLength(1);
  expect(registry.trackedRpcCount(page.ws)).toBe(0);
});

test("request outcomes are dropped once their request settles", async () => {
  let finish = () => {};
  const { open, receive, registry } = harness(async (ws, request) => {
    if (request.id === "fails") {
      registry.markRpcError(ws, request.id, "refused");
      return;
    }
    if (request.id === "throws") {
      registry.markRpcError(ws, request.id, "refused");
      throw new Error("handler failed");
    }
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const page = open("page");
  receive(page.ws, { id: "fails", method: "pane.list" });
  receive(page.ws, { id: "throws", method: "pane.list" });
  receive(page.ws, { id: "slow", method: "pane.list" });
  expect(registry.trackedRpcCount(page.ws)).toBe(3);
  await settle();
  // Marked and returned, and marked then thrown: both taken.
  expect(registry.trackedRpcCount(page.ws)).toBe(1);
  finish();
  await settle();
  expect(registry.trackedRpcCount(page.ws)).toBe(0);
  // A failure reported after its request settled is not kept.
  registry.markRpcError(page.ws, "slow", "late");
  registry.markRpcError(page.ws, "never-dispatched", "late");
  expect(registry.trackedRpcCount(page.ws)).toBe(0);
});

test("closing a principal's sockets ends its VNC and VS Code sockets at once", () => {
  const { open, registry, proxyClosed } = harness(async () => undefined);
  const guest = (id: string) =>
    ({
      kind: "guest",
      key: `guest:${id}`,
      guest: { idHash: id },
      link: {},
    }) as Principal;
  const page = open("page", {}, guest("g1"));
  const vnc = open("vnc", { vnc: { scale: 1 } }, guest("g1"));
  const vscode = open(
    "vscode",
    {
      vscode: {
        req: new Request("http://thyra.test/vscode"),
        url: new URL("http://thyra.test/vscode"),
      },
    },
    guest("g1"),
  );
  const stranger = open("stranger-vnc", { vnc: { scale: 1 } }, guest("g2"));
  registry.closeSockets(
    (principal) =>
      principal.kind === "guest" && principal.guest.idHash === "g1",
    4001,
    "Shared view ended",
  );
  for (const socket of [page, vnc, vscode])
    expect(socket.closed).toEqual([[4001, "Shared view ended"]]);
  expect(proxyClosed.sort()).toEqual(["vnc", "vscode"]);
  expect(registry.vncSockets.has(vnc.ws)).toBe(false);
  expect(registry.vscodeSockets.has(vscode.ws)).toBe(false);
  expect(stranger.closed).toEqual([]);
  expect(registry.vncSockets.has(stranger.ws)).toBe(true);
});
