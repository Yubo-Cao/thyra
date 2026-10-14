import { afterEach, describe, expect, test } from "bun:test";
import {
  encodeRtcClose,
  encodeRtcMessage,
  RtcFrameDecoder,
} from "../../shared/rtcFrames";
import { Bridge, type BridgeTransport, type ConnectionStatus } from "./api";
import { rtcOptedOut, rtcRetryDelay } from "./rtcPath";
import { RtcBridgeSocket } from "./rtcTransport";

const originalWebSocket = globalThis.WebSocket;
const originalLocation = Object.getOwnPropertyDescriptor(
  globalThis,
  "location",
);

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static created: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  bufferedAmount = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code: number }) => void) | null = null;

  constructor() {
    FakeSocket.created.push(this);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    return this;
  }

  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  hello(extra: Record<string, unknown> = {}) {
    this.receive({
      hello: true,
      bridge_protocol_version: 2,
      default_connection_id: "local",
      capabilities: { connection_id: true },
      ...extra,
    });
  }

  lastCall() {
    return JSON.parse(this.sent[this.sent.length - 1]!) as {
      id: string;
      method: string;
    };
  }

  close(code = 1000) {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.closedWith = code;
    this.onclose?.({ code });
  }

  send(data: string) {
    this.sent.push(data);
  }
}

const bridges: Bridge[] = [];

function connectedBridge() {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "https:", host: "thyra.example" },
  });
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  FakeSocket.created = [];
  const bridge = new Bridge(1000, 60_000, false);
  bridges.push(bridge);
  const statuses: ConnectionStatus[] = [];
  const transports: BridgeTransport[] = [];
  const hellos: unknown[] = [];
  let swaps = 0;
  bridge.onStatus((status) => statuses.push(status));
  bridge.onTransport((transport) => transports.push(transport));
  bridge.onHello((hello) => hellos.push(hello));
  bridge.onSocketSwap(() => swaps++);
  bridge.connect();
  const ws = FakeSocket.created[0]!.open();
  ws.hello({ rtc: true });
  return {
    bridge,
    ws,
    statuses,
    transports,
    hellos,
    swaps: () => swaps,
  };
}

afterEach(() => {
  bridges.splice(0).forEach((bridge) => bridge.disconnect());
  globalThis.WebSocket = originalWebSocket;
  if (originalLocation)
    Object.defineProperty(globalThis, "location", originalLocation);
  else Reflect.deleteProperty(globalThis, "location");
});

describe("bridge socket swap", () => {
  test("moves to the adopted socket without leaving connected", async () => {
    const { bridge, ws, statuses, transports, hellos, swaps } =
      connectedBridge();
    expect(bridge.hello?.rtc).toBe(true);
    // A call is in flight on the WebSocket when the channel opens.
    const owed = bridge.call("bridge.status");
    const owedId = ws.lastCall().id;
    const channel = new FakeSocket().open();
    expect(bridge.adoptSocket(channel as unknown as WebSocket, "p2p")).toBe(
      true,
    );
    expect(bridge.transport).toBe("p2p");
    expect(transports).toEqual(["p2p"]);
    channel.hello();
    expect(hellos).toHaveLength(2);
    expect(swaps()).toBe(1);

    // New requests use the channel.
    const ping = bridge.call("bridge.ping");
    const pingCall = channel.lastCall();
    expect(pingCall.method).toBe("bridge.ping");
    channel.receive({ id: pingCall.id, result: { ok: true } });
    expect(await ping).toEqual({ ok: true });

    // Pushes on the old socket are dropped; its owed reply still lands,
    // and then it closes.
    let events = 0;
    bridge.onEvent(() => events++);
    ws.receive({
      connection_id: "local",
      event: "x",
      data: { type: "x" },
    });
    expect(events).toBe(0);
    expect(ws.closedWith).toBeNull();
    ws.receive({ id: owedId, result: { clients: 1 } });
    expect(await owed).toEqual({ clients: 1 });
    expect(ws.closedWith).toBe(1000);

    expect(statuses).toEqual(["disconnected", "connecting", "connected"]);
  });

  test("a dropped channel falls back to a WebSocket reconnect", () => {
    const { bridge, statuses, transports } = connectedBridge();
    const channel = new FakeSocket().open();
    bridge.adoptSocket(channel as unknown as WebSocket, "p2p");
    channel.hello();
    channel.close(1006);
    expect(statuses[statuses.length - 1]).toBe("disconnected");
    bridge.connect();
    expect(transports).toEqual(["p2p", "websocket"]);
    expect(FakeSocket.created[FakeSocket.created.length - 1]).not.toBe(channel);
  });

  test("a channel without its hello is abandoned", async () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "https:", host: "thyra.example" },
    });
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    FakeSocket.created = [];
    const bridge = new Bridge(20, 60_000, false);
    bridges.push(bridge);
    bridge.connect();
    FakeSocket.created[0]!.open().hello({ rtc: true });
    const channel = new FakeSocket().open();
    bridge.adoptSocket(channel as unknown as WebSocket, "p2p");
    await Bun.sleep(40);
    expect(channel.closedWith).toBe(4000);
    expect(bridge.status).toBe("disconnected");
  });

  test("adopts only while connected", () => {
    const { bridge } = connectedBridge();
    bridge.disconnect();
    expect(
      bridge.adoptSocket(
        new FakeSocket().open() as unknown as WebSocket,
        "p2p",
      ),
    ).toBe(false);
  });
});

describe("rtc path policy", () => {
  test("opt-out by query or storage, opt back in by query", () => {
    expect(rtcOptedOut("", null)).toBe(false);
    expect(rtcOptedOut("?rtc=0", null)).toBe(true);
    expect(rtcOptedOut("", "off")).toBe(true);
    expect(rtcOptedOut("?rtc=1", "off")).toBe(false);
  });

  test("retries after 30 seconds, 2 minutes, then every 10 minutes", () => {
    expect([0, 1, 2, 3, 4, 9].map(rtcRetryDelay)).toEqual([
      0, 30_000, 120_000, 600_000, 600_000, 600_000,
    ]);
  });
});

describe("rtc bridge socket", () => {
  function fakePeer() {
    const sent: Uint8Array[] = [];
    const channel = {
      binaryType: "blob",
      readyState: "open",
      bufferedAmount: 0,
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as (() => void) | null,
      send(data: Uint8Array) {
        sent.push(data);
      },
      close() {
        this.readyState = "closed";
      },
    };
    const pc = {
      connectionState: "connected",
      onconnectionstatechange: null as (() => void) | null,
      close() {},
    };
    const socket = new RtcBridgeSocket(
      pc as unknown as RTCPeerConnection,
      channel as unknown as RTCDataChannel,
    );
    const deliver = (chunk: Uint8Array) =>
      channel.onmessage?.({ data: chunk.slice().buffer });
    return { socket, channel, pc, sent, deliver };
  }

  test("keeps messages until onmessage is set and reassembles chunks", () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const { socket, deliver, channel } = fakePeer();
    expect(channel.binaryType).toBe("arraybuffer");
    const big = JSON.stringify({ terminal: { bytes: "b".repeat(100_000) } });
    encodeRtcMessage('{"hello":true}').forEach(deliver);
    encodeRtcMessage(big).forEach(deliver);
    const got: string[] = [];
    socket.onmessage = (event) => got.push(event.data);
    expect(got).toEqual(['{"hello":true}', big]);
  });

  test("sends chunks and reports close codes like a WebSocket", () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const { socket, sent, deliver } = fakePeer();
    socket.send("x".repeat(40_000));
    const decoder = new RtcFrameDecoder();
    const decoded = sent.map((chunk) => decoder.push(chunk)).filter(Boolean);
    expect(decoded).toEqual([{ kind: "message", data: "x".repeat(40_000) }]);
    const closes: number[] = [];
    socket.onclose = (event) => closes.push(event.code);
    deliver(encodeRtcClose(4001, "Session ended"));
    expect(closes).toEqual([4001]);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    expect(() => socket.send("late")).toThrow();
  });

  test("a failed peer connection closes the socket", () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const { socket, pc } = fakePeer();
    const closes: number[] = [];
    socket.onclose = (event) => closes.push(event.code);
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    expect(closes).toEqual([1006]);
  });
});
