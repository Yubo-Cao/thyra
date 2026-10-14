// The browser half of the peer-to-peer bridge transport (see rtcPath.ts and
// server/src/bridge/rtc-transport.ts). Loaded lazily after the first hello.
// It negotiates one data channel over the WebSocket with `bridge.rtc_offer`
// (non-trickle: complete offer, complete answer) and wraps the channel in a
// WebSocket-shaped socket the Bridge can adopt.

import {
  encodeRtcClose,
  encodeRtcMessage,
  RtcFrameDecoder,
} from "../../shared/rtcFrames";

const GATHER_TIMEOUT_MS = 1500;
const OPEN_TIMEOUT_MS = 10_000;
export const DEFAULT_RTC_STUN = "stun:stun.cloudflare.com:3478";

type CloseEventLike = { code: number; reason: string; wasClean: boolean };

/**
 * A data channel with the WebSocket surface the Bridge uses: `readyState`,
 * `bufferedAmount`, `send`, `close` and the four `on*` handlers. Messages
 * that arrive before `onmessage` is set (the server's hello) are kept.
 */
export class RtcBridgeSocket {
  readyState: number = WebSocket.OPEN;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: CloseEventLike) => void) | null = null;
  private messageHandler: ((event: { data: string }) => void) | null = null;
  private readonly queued: string[] = [];
  private readonly decoder = new RtcFrameDecoder();
  private closeEvent: CloseEventLike | null = null;

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly channel: RTCDataChannel,
  ) {
    channel.binaryType = "arraybuffer";
    channel.onmessage = (event) => this.receive(event.data);
    channel.onclose = () => this.finish(1006, "rtc channel closed");
    channel.onerror = () => this.finish(1006, "rtc channel error");
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed")
        this.finish(1006, `rtc ${pc.connectionState}`);
    };
  }

  get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  get onmessage() {
    return this.messageHandler;
  }

  set onmessage(handler: ((event: { data: string }) => void) | null) {
    this.messageHandler = handler;
    while (handler && this.queued.length && this.messageHandler === handler)
      handler({ data: this.queued.shift()! });
  }

  send(data: string) {
    if (this.readyState !== WebSocket.OPEN)
      throw new Error("rtc socket is not open");
    for (const chunk of encodeRtcMessage(data))
      this.channel.send(chunk as Uint8Array<ArrayBuffer>);
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= WebSocket.CLOSING) return;
    try {
      if (this.channel.readyState === "open")
        this.channel.send(
          encodeRtcClose(code, reason) as Uint8Array<ArrayBuffer>,
        );
    } catch {
      // The channel is already gone.
    }
    this.finish(code, reason);
  }

  private receive(data: unknown) {
    if (this.readyState !== WebSocket.OPEN) return;
    if (!(data instanceof ArrayBuffer)) {
      this.finish(1003, "rtc text frame");
      return;
    }
    let decoded: ReturnType<RtcFrameDecoder["push"]>;
    try {
      decoded = this.decoder.push(new Uint8Array(data));
    } catch (error) {
      this.close(1007, (error as Error).message);
      return;
    }
    if (!decoded) return;
    if (decoded.kind === "close") {
      this.finish(decoded.code, decoded.reason);
      return;
    }
    const text =
      typeof decoded.data === "string"
        ? decoded.data
        : new TextDecoder().decode(decoded.data);
    if (this.messageHandler) this.messageHandler({ data: text });
    else this.queued.push(text);
  }

  /** Close once, then report it like a WebSocket close event. */
  private finish(code: number, reason: string) {
    if (this.closeEvent) return;
    this.closeEvent = { code, reason, wasClean: code !== 1006 };
    this.readyState = WebSocket.CLOSED;
    // Give a close frame a moment to leave before the association goes.
    setTimeout(() => {
      try {
        this.channel.close();
        this.pc.close();
      } catch {
        // Already closed.
      }
    }, 200);
    this.onclose?.(this.closeEvent);
  }
}

function iceServers(urls: string[] | undefined): RTCIceServer[] {
  const list = urls?.length ? urls : [DEFAULT_RTC_STUN];
  return list.map((url) => ({ urls: url }));
}

function waitForGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/**
 * Negotiate a channel over `offer` (a `bridge.rtc_offer` call on the current
 * WebSocket) and resolve once it is open. Rejects on any failure.
 */
export async function openRtcSocket(
  offer: (sdp: string) => Promise<{ sdp?: unknown }>,
  stunUrls?: string[],
): Promise<RtcBridgeSocket> {
  const pc = new RTCPeerConnection({ iceServers: iceServers(stunUrls) });
  try {
    const channel = pc.createDataChannel("thyra", { ordered: true });
    // Wrap at once so the server's hello, sent as the channel opens, is kept.
    const socket = new RtcBridgeSocket(pc, channel);
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("rtc channel did not open")),
        OPEN_TIMEOUT_MS,
      );
      channel.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      channel.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new Error("rtc channel closed"));
      });
    });
    await pc.setLocalDescription(await pc.createOffer());
    await waitForGathering(pc);
    const local = pc.localDescription?.sdp;
    if (!local) throw new Error("no local description");
    const answer = await offer(local);
    if (typeof answer?.sdp !== "string") throw new Error("invalid rtc answer");
    await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    await opened;
    return socket;
  } catch (error) {
    pc.close();
    throw error;
  }
}
