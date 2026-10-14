// The peer-to-peer bridge transport. A page on the public listener (behind a
// tunnel that adds tens of milliseconds per round trip) negotiates a WebRTC
// data channel over its authenticated WebSocket with `bridge.rtc_offer`. Once
// the channel opens it becomes a second bridge socket for the same principal:
// `RtcSocket` implements the part of Bun's `ServerWebSocket` the bridge uses,
// and the regular WebSocket handlers drive it, so the hello, RPC routing,
// terminal streams, presence and revocation treat it like any other socket.
// werift (pure TypeScript WebRTC) loads on the first offer only.

import {
  encodeRtcClose,
  encodeRtcMessage,
  RtcFrameDecoder,
} from "../../../shared/rtcFrames";
import { networkInterfaces } from "node:os";

import { thyraEnv } from "../config/environment";
import { type Logger, silentLogger } from "../utils/logger";

export const RTC_CHANNEL_LABEL = "thyra";
export const DEFAULT_RTC_STUN = "stun:stun.cloudflare.com:3478";
const MAX_OFFER_SDP_BYTES = 32 * 1024;
/** Above this many queued bytes `send` reports backpressure (-1), like Bun. */
const SEND_BACKPRESSURE_BYTES = 1024 * 1024;
/** `drain` fires once the queue falls below this. */
const DRAIN_THRESHOLD_BYTES = 256 * 1024;
/** How long a close frame may take to flush before the peer is dropped. */
const CLOSE_FLUSH_MS = 1000;

export interface RtcConfig {
  enabled: boolean;
  /** STUN URLs offered to both ends. */
  iceServers: string[];
  /** Local UDP port range for ICE, inclusive. */
  portRange: [number, number] | null;
}

export function parseRtcConfig(
  env: Record<string, string | undefined> = process.env,
): { config: RtcConfig; warnings: string[] } {
  const warnings: string[] = [];
  const enabled = (thyraEnv("RTC", env) ?? "").trim().toLowerCase() !== "off";
  const stunSetting = thyraEnv("RTC_STUN", env);
  const iceServers = (stunSetting ?? DEFAULT_RTC_STUN)
    .split(",")
    .map((url) => url.trim())
    .filter((url) => {
      if (!url) return false;
      if (/^stuns?:[^\s]+$/.test(url)) return true;
      warnings.push(`THYRA_RTC_STUN: ignoring ${JSON.stringify(url)}`);
      return false;
    });
  let portRange: [number, number] | null = null;
  const rangeSetting = thyraEnv("RTC_PORT_RANGE", env)?.trim();
  if (rangeSetting) {
    const match = rangeSetting.match(/^(\d{1,5})-(\d{1,5})$/);
    const low = Number(match?.[1]);
    const high = Number(match?.[2]);
    if (match && low >= 1024 && high <= 65535 && low < high)
      portRange = [low, high];
    else
      warnings.push(
        `THYRA_RTC_PORT_RANGE must look like 50000-50100 (low < high, 1024-65535); ignoring ${JSON.stringify(rangeSetting)}`,
      );
  }
  return { config: { enabled, iceServers, portRange }, warnings };
}

// --- The werift surface this module uses (typed loosely for test fakes). ---

interface WeriftEvent<T extends unknown[]> {
  subscribe(listener: (...args: T) => void): unknown;
}

export interface RtcChannelLike {
  readonly label: string;
  readyState: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  readonly onMessage: WeriftEvent<[string | Uint8Array]>;
  readonly stateChanged: WeriftEvent<[string]>;
  readonly bufferedAmountLow: WeriftEvent<unknown[]>;
  send(data: Uint8Array | string): void;
  close(): void;
}

export interface RtcPeerLike {
  readonly onDataChannel: WeriftEvent<[RtcChannelLike]>;
  readonly connectionStateChange: WeriftEvent<[string]>;
  readonly iceGatheringStateChange: WeriftEvent<[string]>;
  readonly iceGatheringState: string;
  readonly localDescription: { sdp: string } | null | undefined;
  setRemoteDescription(description: {
    type: "offer";
    sdp: string;
  }): Promise<unknown>;
  createAnswer(): Promise<unknown>;
  setLocalDescription(description: unknown): Promise<unknown>;
  close(): Promise<void> | void;
}

export type CreateRtcPeer = (options: {
  iceServers: { urls: string }[];
  icePortRange: [number, number] | undefined;
}) => RtcPeerLike;

async function loadWerift(): Promise<CreateRtcPeer> {
  // A lazy require, not `await import()`: in `bun build --compile`, a dynamic
  // import wraps every module it shares with the main graph, and Bun then
  // runs @peculiar/x509's `import "reflect-metadata"` after tsyringe, which
  // throws at startup (passkeys import the same x509 module). The CommonJS
  // build of werift loads its own copies, so the main graph stays unwrapped.
  // eslint-disable-next-line typescript/no-require-imports
  const { RTCPeerConnection } = require("werift") as typeof import("werift");
  return (options) =>
    new RTCPeerConnection({
      iceServers: options.iceServers,
      icePortRange: options.icePortRange,
      // Non-trickle: wait for server-reflexive candidates only briefly.
      iceStunGatherTimeout: 2,
    }) as unknown as RtcPeerLike;
}

// --- The socket adapter. ---

export interface RtcSocketStats {
  messagesIn: number;
  messagesOut: number;
  bytesIn: number;
  bytesOut: number;
}

/**
 * A data channel shaped like the parts of Bun's `ServerWebSocket` the bridge
 * calls: `send`, `close`, `data`, `getBufferedAmount`, `readyState`,
 * `remoteAddress`, plus `sendText`, `terminate` and `cork`. Bun's pub/sub
 * (`subscribe`, `publish`) is not used by the bridge and is not offered.
 */
export class RtcSocket<Data> {
  readonly transport = "rtc" as const;
  readyState: 0 | 1 | 2 | 3 = 1;
  readonly stats: RtcSocketStats = {
    messagesIn: 0,
    messagesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
  };

  constructor(
    private readonly channel: RtcChannelLike,
    public data: Data,
    readonly remoteAddress: string,
    private readonly onClose: (code: number, reason: string) => void,
  ) {}

  /**
   * Bytes sent, -1 when queued behind backpressure, 0 when dropped. Bun's
   * second argument (compress) does not apply: DTLS carries the bytes.
   */
  send(payload: string | Uint8Array | ArrayBuffer) {
    if (this.readyState !== 1 || this.channel.readyState !== "open") return 0;
    const data =
      payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
    let bytes = 0;
    for (const chunk of encodeRtcMessage(data)) {
      this.channel.send(chunk);
      bytes += chunk.byteLength;
    }
    this.stats.messagesOut += 1;
    this.stats.bytesOut += bytes;
    return this.channel.bufferedAmount > SEND_BACKPRESSURE_BYTES ? -1 : bytes;
  }

  sendText(payload: string) {
    return this.send(payload);
  }

  getBufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  cork<T>(callback: (socket: this) => T): T {
    return callback(this);
  }

  /** Tell the page why (it acts on 4001 like a WebSocket close), then close. */
  close(code = 1000, reason = "") {
    if (this.readyState !== 1) return;
    try {
      if (this.channel.readyState === "open")
        this.channel.send(encodeRtcClose(code, reason));
    } catch {
      // The channel is already gone; closing it below is enough.
    }
    this.onClose(code, reason);
  }

  terminate() {
    this.close(1006, "terminated");
  }
}

// --- Peer connections. ---

export interface RtcSocketHandlers<Data> {
  open(socket: RtcSocket<Data>): void;
  message(socket: RtcSocket<Data>, message: string): void;
  close(socket: RtcSocket<Data>, code: number, reason: string): void;
  drain(socket: RtcSocket<Data>): void;
}

export interface RtcTransportOptions<Data> {
  config: RtcConfig;
  handlers: RtcSocketHandlers<Data>;
  logger?: Logger;
  /** Live peer connections across all sockets. */
  maxPeers?: number;
  /** ICE gathering cap for the non-trickle answer. */
  gatherTimeoutMs?: number;
  /** A peer whose channel has not opened by then is dropped. */
  openTimeoutMs?: number;
  /** An open channel with no message for this long is closed. */
  idleTimeoutMs?: number;
  createPeer?: CreateRtcPeer;
}

export class RtcOfferError extends Error {}

interface Peer<Data> {
  pc: RtcPeerLike;
  owner: object | null;
  socket: RtcSocket<Data> | null;
  lastMessageAt: number;
  openTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

/** Container and VM bridges: no browser reaches the server through them. */
const VIRTUAL_BRIDGE = /^(docker|br-|incusbr|lxdbr|virbr|veth|cni|podman)/;

/** This host's addresses on container and VM bridges. */
export function virtualBridgeAddresses(
  interfaces = networkInterfaces(),
): Set<string> {
  const addresses = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!VIRTUAL_BRIDGE.test(name)) continue;
    for (const entry of entries ?? [])
      addresses.add(entry.address.toLowerCase());
  }
  return addresses;
}

/**
 * Drop host candidates that only name tailnet (CGNAT, Tailscale ULA)
 * addresses or the given container-bridge addresses.
 */
export function withoutTailnetCandidates(
  sdp: string,
  excluded: ReadonlySet<string> = new Set(),
): string {
  return sdp
    .split(/\r\n/)
    .filter((line) => {
      const match = line.match(
        /^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ host\b/,
      );
      if (!match) return true;
      const address = match[1]!.toLowerCase();
      if (excluded.has(address)) return false;
      if (address.startsWith("fd7a:115c:a1e0:")) return false;
      const octets = address.split(".").map(Number);
      return !(
        octets.length === 4 &&
        octets[0] === 100 &&
        octets[1]! >= 64 &&
        octets[1]! <= 127
      );
    })
    .join("\r\n");
}

export function createRtcTransport<Data>(options: RtcTransportOptions<Data>) {
  const {
    config,
    handlers,
    logger = silentLogger,
    maxPeers = 64,
    gatherTimeoutMs = 1500,
    openTimeoutMs = 10_000,
    idleTimeoutMs = 120_000,
  } = options;
  let createPeer: Promise<CreateRtcPeer> | null = options.createPeer
    ? Promise.resolve(options.createPeer)
    : null;
  const peers = new Set<Peer<Data>>();
  const byOwner = new WeakMap<object, Peer<Data>>();
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  function ensureIdleSweep() {
    if (idleTimer) return;
    idleTimer = setInterval(
      () => {
        const now = Date.now();
        for (const peer of peers) {
          if (peer.socket && now - peer.lastMessageAt > idleTimeoutMs)
            peer.socket.close(4000, "rtc idle");
        }
        if (peers.size === 0 && idleTimer) {
          clearInterval(idleTimer);
          idleTimer = null;
        }
      },
      Math.min(idleTimeoutMs, 30_000),
    );
    (idleTimer as { unref?: () => void }).unref?.();
  }

  /** Release the peer; tell the bridge its socket closed, at most once. */
  function teardown(peer: Peer<Data>, code: number, reason: string) {
    if (peer.closed) return;
    peer.closed = true;
    peers.delete(peer);
    if (peer.owner && byOwner.get(peer.owner) === peer)
      byOwner.delete(peer.owner);
    if (peer.openTimer) clearTimeout(peer.openTimer);
    const socket = peer.socket;
    const closePc = () => {
      try {
        void Promise.resolve(peer.pc.close()).catch(() => {});
      } catch {
        // Already closed.
      }
    };
    if (socket) {
      socket.readyState = 2;
      logger.debug("rtc socket closed", {
        code,
        reason,
        messages_in: socket.stats.messagesIn,
        messages_out: socket.stats.messagesOut,
        bytes_in: socket.stats.bytesIn,
        bytes_out: socket.stats.bytesOut,
      });
      // Let a close frame flush before the association goes away.
      const started = Date.now();
      const flush = setInterval(() => {
        if (
          socket.getBufferedAmount() === 0 ||
          Date.now() - started > CLOSE_FLUSH_MS
        ) {
          clearInterval(flush);
          closePc();
        }
      }, 20);
      queueMicrotask(() => {
        socket.readyState = 3;
        try {
          handlers.close(socket, code, reason);
        } catch (error) {
          logger.warn("rtc close handler failed", {
            error: (error as Error).message,
          });
        }
      });
    } else closePc();
  }

  function opened(
    peer: Peer<Data>,
    channel: RtcChannelLike,
    data: Data,
    remoteAddress: string,
  ) {
    if (peer.closed || peer.socket) return;
    if (peer.openTimer) clearTimeout(peer.openTimer);
    peer.openTimer = null;
    const socket = new RtcSocket<Data>(
      channel,
      data,
      remoteAddress,
      (code, reason) => teardown(peer, code, reason),
    );
    peer.socket = socket;
    peer.lastMessageAt = Date.now();
    const decoder = new RtcFrameDecoder();
    channel.bufferedAmountLowThreshold = DRAIN_THRESHOLD_BYTES;
    channel.bufferedAmountLow.subscribe(() => {
      if (socket.readyState === 1) handlers.drain(socket);
    });
    channel.onMessage.subscribe((raw) => {
      if (socket.readyState !== 1) return;
      peer.lastMessageAt = Date.now();
      // Every frame is binary; a text frame is not ours.
      if (typeof raw === "string") {
        socket.close(1003, "rtc text frame");
        return;
      }
      socket.stats.bytesIn += raw.byteLength;
      let decoded: ReturnType<RtcFrameDecoder["push"]>;
      try {
        decoded = decoder.push(raw);
      } catch (error) {
        socket.close(1007, (error as Error).message);
        return;
      }
      if (!decoded) return;
      if (decoded.kind === "close") {
        teardown(peer, decoded.code, decoded.reason);
        return;
      }
      socket.stats.messagesIn += 1;
      handlers.message(
        socket,
        typeof decoded.data === "string"
          ? decoded.data
          : new TextDecoder().decode(decoded.data),
      );
    });
    channel.stateChanged.subscribe((state) => {
      if (state === "closed" || state === "closing")
        teardown(peer, 1006, "rtc channel closed");
    });
    ensureIdleSweep();
    handlers.open(socket);
  }

  async function waitForGathering(pc: RtcPeerLike) {
    if (pc.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, gatherTimeoutMs);
      pc.iceGatheringStateChange.subscribe((state) => {
        if (state !== "complete") return;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    get enabled() {
      return config.enabled;
    },
    get iceServers() {
      return config.iceServers;
    },
    get peerCount() {
      return peers.size;
    },

    /**
     * Answer a complete (non-trickle) offer from `owner`, a WebSocket. When
     * the channel opens it becomes a socket carrying `data`, a copy of the
     * owner's: the same principal and client context.
     */
    async answer(
      owner: object,
      data: Data,
      remoteAddress: string,
      sdp: unknown,
    ): Promise<string> {
      if (!config.enabled) throw new RtcOfferError("rtc is disabled");
      if (typeof sdp !== "string" || !sdp.startsWith("v=0"))
        throw new RtcOfferError("bridge.rtc_offer: sdp must be an SDP offer");
      if (Buffer.byteLength(sdp) > MAX_OFFER_SDP_BYTES)
        throw new RtcOfferError("bridge.rtc_offer: sdp is too large");
      if (byOwner.has(owner))
        throw new RtcOfferError(
          "bridge.rtc_offer: this socket already has a peer connection",
        );
      if (peers.size >= maxPeers)
        throw new RtcOfferError("bridge.rtc_offer: too many peer connections");
      createPeer ??= loadWerift();
      let factory: CreateRtcPeer;
      try {
        factory = await createPeer;
      } catch (error) {
        createPeer = null;
        throw error;
      }
      // Recheck: other offers may have arrived while werift loaded.
      if (byOwner.has(owner) || peers.size >= maxPeers)
        throw new RtcOfferError("bridge.rtc_offer: peer connection limit");
      const pc = factory({
        iceServers: config.iceServers.map((urls) => ({ urls })),
        icePortRange: config.portRange ?? undefined,
      });
      const peer: Peer<Data> = {
        pc,
        owner,
        socket: null,
        lastMessageAt: Date.now(),
        openTimer: null,
        closed: false,
      };
      peers.add(peer);
      byOwner.set(owner, peer);
      peer.openTimer = setTimeout(() => {
        logger.debug("rtc channel did not open in time");
        teardown(peer, 1006, "rtc open timeout");
      }, openTimeoutMs);
      const channelData = { ...data };
      pc.onDataChannel.subscribe((channel) => {
        if (channel.label !== RTC_CHANNEL_LABEL || peer.socket) {
          channel.close();
          return;
        }
        if (channel.readyState === "open")
          opened(peer, channel, channelData, remoteAddress);
        else
          channel.stateChanged.subscribe((state) => {
            if (state === "open")
              opened(peer, channel, channelData, remoteAddress);
          });
      });
      pc.connectionStateChange.subscribe((state) => {
        if (state === "failed" || state === "closed")
          teardown(peer, 1006, `rtc ${state}`);
      });
      try {
        await pc.setRemoteDescription({ type: "offer", sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await waitForGathering(pc);
        const answer = pc.localDescription?.sdp;
        if (peer.closed || !answer) throw new Error("peer closed");
        return withoutTailnetCandidates(answer, virtualBridgeAddresses());
      } catch (error) {
        teardown(peer, 1006, "rtc negotiation failed");
        throw new RtcOfferError(
          `bridge.rtc_offer: ${(error as Error).message}`,
        );
      }
    },

    /**
     * The negotiating WebSocket closed: a peer still setting up goes with
     * it; an open one is its own socket now and stays.
     */
    ownerClosed(owner: object) {
      const peer = byOwner.get(owner);
      if (!peer) return;
      byOwner.delete(owner);
      peer.owner = null;
      if (!peer.socket) teardown(peer, 1006, "rtc owner closed");
    },

    /** Close every peer (shutdown). */
    closeAll(code = 1001, reason = "server shutting down") {
      for (const peer of [...peers]) {
        if (peer.socket) peer.socket.close(code, reason);
        else teardown(peer, code, reason);
      }
    },
  };
}

export type RtcTransport<Data> = ReturnType<typeof createRtcTransport<Data>>;
