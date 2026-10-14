import { type BridgeHello, bridge } from "./api";
import { thyraLocalStorage } from "./browserStorage";

// The peer-to-peer path: when the bridge offers it in the hello (its public
// listener, behind a tunnel), the page negotiates a WebRTC data channel and
// moves the bridge onto it, so requests skip the tunnel. If the channel
// fails, the WebSocket reconnects as usual and the channel is retried after
// 30 seconds, 2 minutes, then every 10 minutes. `?rtc=0` or
// `localStorage["thyra:rtc"] = "off"` opts out; `?rtc=1` opts back in.
// The WebRTC code itself loads only when an attempt starts.

const STORAGE_KEY = "rtc";
export const RTC_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
/** A channel that lived this long resets the retry schedule. */
const STABLE_MS = 10 * 60_000;
/** Let the direct path (directPath.ts) probe first when it is offered. */
const DIRECT_PATH_GRACE_MS = 1600;
const OFFER_TIMEOUT_MS = 10_000;

/** Whether this page should not use the data channel. */
export function rtcOptedOut(search: string, stored: string | null): boolean {
  const flag = new URLSearchParams(search).get("rtc");
  if (flag === "0") return true;
  if (flag === "1") return false;
  return stored === "off";
}

/** Delay before the next attempt after `failures` failed ones. */
export function rtcRetryDelay(failures: number): number {
  if (failures <= 0) return 0;
  return RTC_RETRY_DELAYS_MS[
    Math.min(failures, RTC_RETRY_DELAYS_MS.length) - 1
  ]!;
}

let failures = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let attempting = false;
let openedAt = 0;

function optedOut(): boolean {
  const { search } = window.location;
  const flag = new URLSearchParams(search).get("rtc");
  if (flag === "0") thyraLocalStorage.setItem(STORAGE_KEY, "off");
  if (flag === "1") thyraLocalStorage.removeItem(STORAGE_KEY);
  return rtcOptedOut(search, thyraLocalStorage.getItem(STORAGE_KEY));
}

function schedule(hello: BridgeHello | null, extraDelayMs = 0) {
  if (timer || attempting || !hello?.rtc || optedOut()) return;
  timer = setTimeout(attempt, rtcRetryDelay(failures) + extraDelayMs);
}

function failed() {
  failures += 1;
  schedule(bridge.hello);
}

async function attempt() {
  timer = null;
  const hello = bridge.hello;
  if (
    bridge.status !== "connected" ||
    bridge.transport !== "websocket" ||
    !hello?.rtc ||
    typeof RTCPeerConnection === "undefined"
  )
    return;
  attempting = true;
  try {
    const { openRtcSocket } = await import("./rtcTransport");
    const socket = await openRtcSocket(
      (sdp) =>
        bridge.call(
          "bridge.rtc_offer",
          { sdp },
          { timeoutMs: OFFER_TIMEOUT_MS },
        ),
      hello.rtc_ice_servers,
    );
    if (!bridge.adoptSocket(socket as unknown as WebSocket, "p2p")) {
      socket.close(1000, "not adopted");
      attempting = false;
      failed();
      return;
    }
    openedAt = Date.now();
    attempting = false;
  } catch {
    attempting = false;
    failed();
  }
}

/** Once per page load. */
export function initRtcPath() {
  bridge.onTransport((transport) => {
    if (transport !== "websocket" || !openedAt) return;
    // The channel dropped: back off unless it had been up a long while.
    failures = Date.now() - openedAt >= STABLE_MS ? 0 : failures + 1;
    openedAt = 0;
  });
  bridge.onHello((hello) => {
    if (bridge.transport !== "websocket") return;
    schedule(
      hello,
      failures === 0 && hello.direct_origin ? DIRECT_PATH_GRACE_MS : 0,
    );
  });
}
