import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RTCPeerConnection } from "werift";
import {
  encodeRtcMessage,
  type RtcDecoded,
  RtcFrameDecoder,
} from "../../../shared/rtcFrames";
import { openAccountDatabase } from "../accounts/database";
import { createAccountStore, hashSecret } from "../accounts/store";

/** Queue of parsed messages with an awaitable `next`. */
function inbox<T>() {
  const items: T[] = [];
  const waiters: Array<() => void> = [];
  return {
    push(item: T) {
      items.push(item);
      for (const wake of waiters.splice(0)) wake();
    },
    async next(match: (item: T) => boolean, timeoutMs = 5000): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = items.findIndex(match);
        if (index >= 0) return items.splice(index, 1)[0]!;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("timed out waiting for a message");
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, left);
        });
      }
    },
  };
}

// The real server's public listener: a signed-in page negotiates the data
// channel over its WebSocket, the channel becomes a bridge socket for the
// same session, outlives the WebSocket, and revoking the session closes it
// with the same 4001 a WebSocket gets.
test.skipIf(process.platform === "win32")(
  "an RTC socket serves the bridge for its session and closes on revocation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "thyra-rtc-"));
    const dbPath = join(root, "thyra.db");
    const store = createAccountStore(openAccountDatabase(dbPath));
    const user = store.createUser({ name: "alice", role: "member" });
    const { token } = store.createSession({
      userId: user.id,
      authMethod: "passkey",
    });
    const child = Bun.spawn([process.execPath, "server/src/index.ts"], {
      cwd: join(import.meta.dir, "../../.."),
      env: {
        ...process.env,
        HOME: root,
        APPDATA: root,
        XDG_CONFIG_HOME: root,
        HOST: "127.0.0.1",
        PORT: "0",
        OPEN_BROWSER: "0",
        THYRA_LOG_LEVEL: "debug",
        THYRA_DB_PATH: dbPath,
        THYRA_PUBLIC_LISTEN: "127.0.0.1:0",
        THYRA_PUBLIC_ORIGIN: "https://thyra.example",
        THYRA_PUBLIC_TRUSTED_PROXIES: "",
        THYRA_RTC: "",
        // No STUN server in tests: loopback host candidates suffice.
        THYRA_RTC_STUN: "",
        THYRA_RTC_PORT_RANGE: "",
        THYRA_TAILSCALE_IDENTITY: "off",
        THYRA_TAILNET_AUTH: "off",
        THYRA_CONNECTIONS_PATH: join(root, "connections.json"),
        HERDR_SOCKET_PATH: join(root, "missing-control.sock"),
        HERDR_CLIENT_SOCKET_PATH: join(root, "missing-render.sock"),
        HERDR_SSH_HOST: "",
        HERDR_SESSION: "",
        THYRA_TLS_CERT: "",
        THYRA_TLS_KEY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const errors = new Response(child.stderr).text();
    let log = "";
    const ready = Promise.withResolvers<{ primary: string; public: string }>();
    const output = (async () => {
      for await (const chunk of child.stdout) {
        log += new TextDecoder().decode(chunk);
        const primary = log.match(
          /\bINFO bridge listening\b[^\r\n]*:(\d+)\b/,
        )?.[1];
        const publicPort = log.match(
          /\bINFO bridge public listener\b[^\r\n]*listen=http:\/\/[^:\s]+:(\d+)/,
        )?.[1];
        if (primary && publicPort)
          ready.resolve({
            primary: `ws://127.0.0.1:${primary}/ws`,
            public: `ws://127.0.0.1:${publicPort}/ws?client_session=rtcsession01`,
          });
      }
      ready.reject(
        new Error(`Server exited before listening: ${log}\n${await errors}`),
      );
    })();
    const deadline = setTimeout(
      () => ready.reject(new Error("Server startup timed out")),
      10_000,
    );
    const pc = new RTCPeerConnection({});
    try {
      const urls = await ready.promise;
      clearTimeout(deadline);

      // The primary listener never offers the transport.
      const primary = new WebSocket(urls.primary);
      const primaryInbox = inbox<Record<string, unknown>>();
      primary.onmessage = (event) =>
        primaryInbox.push(JSON.parse(String(event.data)));
      const primaryHello = await primaryInbox.next((m) => m.hello === true);
      expect(primaryHello.rtc).toBeUndefined();
      primary.close();

      const ws = new WebSocket(urls.public, {
        headers: {
          host: "thyra.example",
          origin: "https://thyra.example",
          cookie: `__Host-thyra_session=${token}`,
        },
      } as unknown as string[]);
      const wsInbox = inbox<Record<string, unknown>>();
      const wsClosed = Promise.withResolvers<void>();
      ws.onmessage = (event) => wsInbox.push(JSON.parse(String(event.data)));
      ws.onclose = () => wsClosed.resolve();
      const hello = await wsInbox.next((m) => m.hello === true);
      expect(hello.rtc).toBe(true);
      expect(hello.rtc_ice_servers).toEqual([]);
      expect((hello.principal as { kind: string }).kind).toBe("user");

      // The browser side: a complete offer for channel "thyra".
      const channel = pc.createDataChannel("thyra", { ordered: true });
      const rtcInbox = inbox<RtcDecoded>();
      const decoder = new RtcFrameDecoder();
      channel.onMessage.subscribe((raw) => {
        const decoded = decoder.push(
          typeof raw === "string" ? new TextEncoder().encode(raw) : raw,
        );
        if (decoded) rtcInbox.push(decoded);
      });
      const opened = new Promise<void>((resolve) =>
        channel.stateChanged.subscribe((s) => s === "open" && resolve()),
      );
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.iceGatheringState !== "complete")
        await new Promise<void>((resolve) =>
          pc.iceGatheringStateChange.subscribe(
            (s) => s === "complete" && resolve(),
          ),
        );
      ws.send(
        JSON.stringify({
          id: "o1",
          method: "bridge.rtc_offer",
          params: { sdp: pc.localDescription!.sdp },
        }),
      );
      const answer = await wsInbox.next((m) => m.id === "o1");
      expect(answer.error).toBeUndefined();
      const sdp = (answer.result as { sdp: string }).sdp;
      // A second offer on the same socket is refused.
      ws.send(
        JSON.stringify({
          id: "o2",
          method: "bridge.rtc_offer",
          params: { sdp: pc.localDescription!.sdp },
        }),
      );
      expect(
        (
          (await wsInbox.next((m) => m.id === "o2")).error as {
            message: string;
          }
        ).message,
      ).toContain("already has a peer connection");
      await pc.setRemoteDescription({ type: "answer", sdp });
      await opened;

      const rpc = (message: Record<string, unknown>) => {
        for (const chunk of encodeRtcMessage(JSON.stringify(message)))
          channel.send(Buffer.from(chunk));
      };
      const rtcJson = (match: (m: Record<string, unknown>) => boolean) =>
        rtcInbox
          .next(
            (item) =>
              item.kind === "message" && match(JSON.parse(item.data as string)),
          )
          .then(
            (item) =>
              JSON.parse((item as { data: string }).data) as Record<
                string,
                unknown
              >,
          );
      // The channel is a fresh bridge socket: its own hello, same session.
      const rtcHello = await rtcJson((m) => m.hello === true);
      expect(rtcHello.rtc).toBeUndefined();
      expect(rtcHello.principal).toEqual(hello.principal);
      expect(rtcHello.participant_id).toBe(hello.participant_id);
      rpc({ id: "p1", method: "bridge.ping", params: {} });
      expect((await rtcJson((m) => m.id === "p1")).result).toEqual({
        ok: true,
      });
      // An RTC socket cannot negotiate another one.
      rpc({ id: "o3", method: "bridge.rtc_offer", params: { sdp: "v=0" } });
      expect(
        ((await rtcJson((m) => m.id === "o3")).error as { message: string })
          .message,
      ).toContain("not offered");

      // The page drops its WebSocket; the channel keeps serving.
      ws.close();
      await wsClosed.promise;
      rpc({ id: "s1", method: "bridge.status", params: {} });
      const status = await rtcJson((m) => m.id === "s1");
      expect((status.result as { clients: number }).clients).toBe(1);

      // Revoking the session closes the RTC socket with 4001.
      expect(store.deleteSessionByHash(hashSecret(token), null)).toBe(true);
      expect(
        await rtcInbox.next((item) => item.kind === "close", 5000),
      ).toEqual({ kind: "close", code: 4001, reason: "Session ended" });
      // The server counted the RPCs that arrived over the channel.
      const deadline2 = Date.now() + 3000;
      while (!/rtc socket closed/.test(log) && Date.now() < deadline2)
        await Bun.sleep(50);
      expect(log).toMatch(/rtc socket closed[^\n]*code=4001/);
      expect(log).toMatch(/rtc socket closed[^\n]*messages_in=3/);
      expect(log).toMatch(/client connected[^\n]*transport=rtc/);
    } finally {
      await pc.close();
      child.kill();
      await child.exited;
      await output.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
