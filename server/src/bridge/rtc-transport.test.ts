import { afterEach, describe, expect, test } from "bun:test";
import { RTCPeerConnection } from "werift";
import {
  encodeRtcClose,
  encodeRtcMessage,
  RtcFrameDecoder,
  type RtcDecoded,
} from "../../../shared/rtcFrames";
import {
  createRtcTransport,
  parseRtcConfig,
  type RtcChannelLike,
  type RtcSocket,
  RtcSocket as RtcSocketClass,
  virtualBridgeAddresses,
  withoutTailnetCandidates,
} from "./rtc-transport";

type Data = { principal: { key: string }; clientSession: string | null };

const config = { enabled: true, iceServers: [], portRange: null };
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function recorder() {
  const events: string[] = [];
  const sockets: RtcSocket<Data>[] = [];
  const messages: string[] = [];
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
  const open = Promise.withResolvers<RtcSocket<Data>>();
  const handlers = {
    open(socket: RtcSocket<Data>) {
      events.push("open");
      sockets.push(socket);
      open.resolve(socket);
    },
    message(socket: RtcSocket<Data>, message: string) {
      messages.push(message);
      // Echo, like an RPC reply.
      socket.send(`echo:${message.length}`);
    },
    close(_socket: RtcSocket<Data>, code: number, reason: string) {
      events.push(`close:${code}`);
      closed.resolve({ code, reason });
    },
    drain() {
      events.push("drain");
    },
  };
  return { events, sockets, messages, handlers, closed, open };
}

/** A browser stand-in: a werift peer making a complete offer. */
async function browserOffer() {
  const pc = new RTCPeerConnection({});
  cleanups.push(() => pc.close());
  const channel = pc.createDataChannel("thyra", { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  if (pc.iceGatheringState !== "complete")
    await new Promise<void>((resolve) =>
      pc.iceGatheringStateChange.subscribe(
        (state) => state === "complete" && resolve(),
      ),
    );
  const received: RtcDecoded[] = [];
  const decoder = new RtcFrameDecoder();
  const waiters: Array<() => void> = [];
  channel.onMessage.subscribe((raw) => {
    const decoded = decoder.push(
      typeof raw === "string" ? new TextEncoder().encode(raw) : raw,
    );
    if (decoded) received.push(decoded);
    for (const wake of waiters.splice(0)) wake();
  });
  const opened = new Promise<void>((resolve) =>
    channel.stateChanged.subscribe((state) => state === "open" && resolve()),
  );
  return {
    pc,
    channel,
    sdp: pc.localDescription!.sdp,
    received,
    opened,
    async accept(answer: string) {
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      await opened;
    },
    send(text: string) {
      for (const chunk of encodeRtcMessage(text))
        channel.send(Buffer.from(chunk));
    },
    async next(count = 1) {
      while (received.length < count)
        await new Promise<void>((resolve) => waiters.push(resolve));
      return received[count - 1]!;
    },
  };
}

function transportWith(
  handlers: ReturnType<typeof recorder>["handlers"],
  extra: Partial<Parameters<typeof createRtcTransport<Data>>[0]> = {},
) {
  const transport = createRtcTransport<Data>({ config, handlers, ...extra });
  cleanups.push(() => transport.closeAll());
  return transport;
}

describe("rtc transport", () => {
  test("an opened channel is a socket for a copy of the owner's data", async () => {
    const record = recorder();
    const transport = transportWith(record.handlers);
    const owner = {};
    const data: Data = { principal: { key: "user:1" }, clientSession: "abc" };
    const browser = await browserOffer();
    const answer = await transport.answer(
      owner,
      data,
      "203.0.113.5",
      browser.sdp,
    );
    expect(answer).toStartWith("v=0");
    expect(answer).toContain("a=candidate");
    await browser.accept(answer);
    const socket = await record.open.promise;
    expect(socket.data).not.toBe(data);
    expect(socket.data).toEqual(data);
    expect(socket.remoteAddress).toBe("203.0.113.5");
    expect(socket.readyState).toBe(1);

    // Large messages cross both ways in chunks and arrive whole.
    const big = JSON.stringify({
      id: "c1",
      method: "x",
      params: "y".repeat(300_000),
    });
    browser.send(big);
    expect(await browser.next()).toEqual({
      kind: "message",
      data: `echo:${big.length}`,
    });
    expect(record.messages).toEqual([big]);
    const frame = JSON.stringify({ terminal: { bytes: "z".repeat(200_000) } });
    expect(socket.send(frame)).toBeGreaterThan(200_000);
    expect(await browser.next(2)).toEqual({ kind: "message", data: frame });
    expect(socket.stats.messagesIn).toBe(1);
    expect(socket.stats.messagesOut).toBe(2);
  });

  test("closing sends the close code to the page and closes once", async () => {
    const record = recorder();
    const transport = transportWith(record.handlers);
    const browser = await browserOffer();
    await browser.accept(
      await transport.answer(
        {},
        { principal: { key: "k" }, clientSession: null },
        "",
        browser.sdp,
      ),
    );
    const socket = await record.open.promise;
    socket.close(4001, "Session ended");
    socket.close(4003, "again");
    expect(await browser.next()).toEqual({
      kind: "close",
      code: 4001,
      reason: "Session ended",
    });
    expect(await record.closed.promise).toEqual({
      code: 4001,
      reason: "Session ended",
    });
    expect(socket.readyState).toBe(3);
    expect(socket.send("late")).toBe(0);
    expect(record.events.filter((event) => event.startsWith("close"))).toEqual([
      "close:4001",
    ]);
    expect(transport.peerCount).toBe(0);
  });

  test("a page's close frame or a dropped channel closes the socket", async () => {
    const record = recorder();
    const transport = transportWith(record.handlers);
    const browser = await browserOffer();
    await browser.accept(
      await transport.answer(
        {},
        { principal: { key: "k" }, clientSession: null },
        "",
        browser.sdp,
      ),
    );
    await record.open.promise;
    browser.channel.send(Buffer.from(encodeRtcClose(1000, "bye")));
    expect(await record.closed.promise).toEqual({ code: 1000, reason: "bye" });

    const second = recorder();
    const other = transportWith(second.handlers);
    const peer = await browserOffer();
    await peer.accept(
      await other.answer(
        {},
        { principal: { key: "k" }, clientSession: null },
        "",
        peer.sdp,
      ),
    );
    await second.open.promise;
    await peer.pc.close();
    expect((await second.closed.promise).code).toBe(1006);
  });

  test("one peer per socket and a global cap", async () => {
    const record = recorder();
    const transport = transportWith(record.handlers, { maxPeers: 2 });
    const data = { principal: { key: "k" }, clientSession: null };
    const owner = {};
    await transport.answer(owner, data, "", (await browserOffer()).sdp);
    await expect(
      transport.answer(owner, data, "", (await browserOffer()).sdp),
    ).rejects.toThrow("already has a peer connection");
    await transport.answer({}, data, "", (await browserOffer()).sdp);
    await expect(
      transport.answer({}, data, "", (await browserOffer()).sdp),
    ).rejects.toThrow("too many peer connections");
    expect(transport.peerCount).toBe(2);
    // The owner leaving before the channel opens frees its slot.
    transport.ownerClosed(owner);
    expect(transport.peerCount).toBe(1);
    await transport.answer(owner, data, "", (await browserOffer()).sdp);
  });

  test("rejects malformed offers and works when disabled", async () => {
    const record = recorder();
    const transport = transportWith(record.handlers);
    const data = { principal: { key: "k" }, clientSession: null };
    await expect(transport.answer({}, data, "", 42)).rejects.toThrow(
      "sdp must be an SDP offer",
    );
    await expect(
      transport.answer({}, data, "", `v=0\r\n${"a".repeat(40_000)}`),
    ).rejects.toThrow("too large");
    const off = transportWith(record.handlers, {
      config: { ...config, enabled: false },
    });
    expect(off.enabled).toBe(false);
    await expect(
      off.answer({}, data, "", (await browserOffer()).sdp),
    ).rejects.toThrow("disabled");
  });

  test("a channel that never opens is dropped", async () => {
    const record = recorder();
    const transport = transportWith(record.handlers, { openTimeoutMs: 100 });
    const browser = await browserOffer();
    await transport.answer(
      {},
      { principal: { key: "k" }, clientSession: null },
      "",
      browser.sdp,
    );
    expect(transport.peerCount).toBe(1);
    // The page never applies the answer.
    await Bun.sleep(250);
    expect(transport.peerCount).toBe(0);
    expect(record.events).toEqual([]);
  });
});

describe("rtc socket adapter", () => {
  function fakeChannel(buffered: number) {
    const sent: Uint8Array[] = [];
    const channel: RtcChannelLike = {
      label: "thyra",
      readyState: "open",
      bufferedAmount: buffered,
      bufferedAmountLowThreshold: 0,
      onMessage: { subscribe() {} },
      stateChanged: { subscribe() {} },
      bufferedAmountLow: { subscribe() {} },
      send(data) {
        sent.push(data as Uint8Array);
      },
      close() {},
    };
    return { channel, sent };
  }

  test("buffered amount and backpressure follow the channel", () => {
    const { channel, sent } = fakeChannel(0);
    const closes: number[] = [];
    const socket = new RtcSocketClass(channel, {}, "", (code) =>
      closes.push(code),
    );
    expect(socket.getBufferedAmount()).toBe(0);
    expect(socket.send("hello")).toBe(6);
    channel.bufferedAmount = 2 * 1024 * 1024;
    expect(socket.getBufferedAmount()).toBe(2 * 1024 * 1024);
    // Queued behind backpressure, as Bun reports it.
    expect(socket.send("x".repeat(40_000))).toBe(-1);
    expect(sent).toHaveLength(4);
    expect(socket.cork((s) => s === socket)).toBe(true);
    socket.terminate();
    expect(closes).toEqual([1006]);
  });

  test("a closed channel drops sends", () => {
    const { channel } = fakeChannel(0);
    channel.readyState = "closed";
    const socket = new RtcSocketClass(channel, {}, "", () => {});
    expect(socket.send("x")).toBe(0);
  });
});

describe("rtc config", () => {
  test("defaults on with Cloudflare STUN", () => {
    expect(parseRtcConfig({})).toEqual({
      config: {
        enabled: true,
        iceServers: ["stun:stun.cloudflare.com:3478"],
        portRange: null,
      },
      warnings: [],
    });
  });

  test("reads THYRA_RTC, THYRA_RTC_STUN and THYRA_RTC_PORT_RANGE", () => {
    const parsed = parseRtcConfig({
      THYRA_RTC: "off",
      THYRA_RTC_STUN: "stun:a.example:3478, stun:b.example ,http://bad",
      THYRA_RTC_PORT_RANGE: "50000-50100",
    });
    expect(parsed.config).toEqual({
      enabled: false,
      iceServers: ["stun:a.example:3478", "stun:b.example"],
      portRange: [50000, 50100],
    });
    expect(parsed.warnings).toHaveLength(1);
    expect(
      parseRtcConfig({ THYRA_RTC_PORT_RANGE: "9-8" }).warnings[0],
    ).toContain("THYRA_RTC_PORT_RANGE");
    expect(parseRtcConfig({ THYRA_RTC_STUN: "" }).config.iceServers).toEqual(
      [],
    );
  });

  test("tailnet host candidates are not published", () => {
    const sdp = [
      "v=0",
      "a=candidate:1 1 udp 2116026367 100.112.202.14 39187 typ host generation 0",
      "a=candidate:2 1 udp 2116026367 fd7a:115c:a1e0::333a:ca0f 51752 typ host generation 0",
      "a=candidate:3 1 udp 2116026367 131.215.155.232 33514 typ host generation 0",
      "a=candidate:4 1 udp 1679818751 131.215.155.232 39187 typ srflx raddr 100.112.202.14 rport 39187",
      "",
    ].join("\r\n");
    const out = withoutTailnetCandidates(sdp);
    expect(out).not.toContain("a=candidate:1 ");
    expect(out).not.toContain("a=candidate:2 ");
    expect(out).toContain("a=candidate:3 ");
    expect(out).toContain("a=candidate:4 ");
  });

  test("container bridge host candidates are not published", () => {
    const bridges = virtualBridgeAddresses({
      docker0: [{ address: "172.17.0.1" } as never],
      incusbr0: [{ address: "10.121.113.1" } as never],
      enp8s0: [{ address: "131.215.155.232" } as never],
    });
    expect([...bridges].sort()).toEqual(["10.121.113.1", "172.17.0.1"]);
    const sdp = [
      "a=candidate:1 1 udp 2116026367 10.121.113.1 44216 typ host generation 0",
      "a=candidate:2 1 udp 2116026367 131.215.155.232 42637 typ host generation 0",
      "",
    ].join("\r\n");
    const out = withoutTailnetCandidates(sdp, bridges);
    expect(out).not.toContain("a=candidate:1 ");
    expect(out).toContain("a=candidate:2 ");
  });
});
