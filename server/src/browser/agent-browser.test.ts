import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../utils/logger";
import {
  agentBrowserConfig,
  createAgentBrowser,
  createSseParser,
  type ReviewRequest,
  relevantTab,
} from "./agent-browser";

const tab = (targetId: string, state?: string) => ({
  targetId,
  url: `https://example.com/${targetId}`,
  title: targetId,
  ...(state ? { review: { state, message: "" } } : {}),
});

describe("agent browser", () => {
  test("defaults and THYRA_ overrides", () => {
    expect(agentBrowserConfig({ XDG_RUNTIME_DIR: "/run/user/7" })).toEqual({
      vncSocket: "/run/user/7/chromium-virtual-display/vnc.sock",
      proxyUrl: "http://127.0.0.1:3456",
    });
    expect(
      agentBrowserConfig({
        THYRA_BROWSER_VNC_SOCKET: "/tmp/v.sock",
        THYRA_BROWSER_PROXY_URL: "http://127.0.0.1:9/",
      }),
    ).toEqual({ vncSocket: "/tmp/v.sock", proxyUrl: "http://127.0.0.1:9" });
  });

  test("SSE parser joins data lines and skips comments and ids", () => {
    const parse = createSseParser();
    expect(parse(': connected\n\nid: 1\ndata: {"a"')).toEqual([]);
    expect(
      parse(":1}\n\n: ping\n\nid: 2\r\ndata: x\r\ndata: y\r\n\r\n"),
    ).toEqual(['{"a":1}', "x\ny"]);
  });

  test("most relevant tab: latest pending review, else latest tab", () => {
    expect(relevantTab([tab("a", "pending"), tab("b")])?.targetId).toBe("a");
    expect(relevantTab([tab("a", "viewed"), tab("b")])?.targetId).toBe("b");
    expect(relevantTab([])).toBeUndefined();
  });

  test("activates only a tab the pane owns", async () => {
    const calls: string[] = [];
    const browser = createAgentBrowser({
      vncSocket: "/nonexistent",
      proxyUrl: "http://proxy",
      logger: silentLogger,
      onReview: () => {},
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return url.includes("/targets")
          ? Response.json([tab("a", "pending"), tab("b"), { bad: 1 }])
          : new Response("ok");
      }) as unknown as typeof fetch,
    });
    expect(await browser.tabs("w1:p1")).toHaveLength(2);
    expect(await browser.activate("w1:p1")).toBe("a");
    expect(await browser.activate("w1:p1", "b")).toBe("b");
    expect(await browser.activate("w1:p1", "other")).toBeNull();
    expect(calls).toContain("POST http://proxy/activate?target=a");
    expect(calls).toContain("GET http://proxy/targets?pane=w1%3Ap1");
    // Without a pane: list every tab, front only a named one.
    expect(await browser.tabs(null)).toHaveLength(2);
    expect(calls).toContain("GET http://proxy/targets");
    expect(await browser.activate(null)).toBeNull();
    expect(await browser.activate(null, "b")).toBe("b");
    expect(calls.some((call) => call.includes("/close"))).toBe(false);
    expect(browser.status()).toEqual({ vnc: false, proxy: false });
  });

  test("a proxy that is down yields no tabs", async () => {
    const browser = createAgentBrowser({
      vncSocket: "/nonexistent",
      proxyUrl: "http://proxy",
      logger: silentLogger,
      onReview: () => {},
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(await browser.tabs("p")).toBeNull();
    expect(await browser.activate("p")).toBeNull();
  });

  test("events: pending reviews notify once per stream, reconnect after loss", async () => {
    const owner = { paneId: "w1:p1", workspaceId: "w1" };
    const event = (type: string, review: unknown, targetId = "t1") =>
      `id: 1\ndata: ${JSON.stringify({ type, targetId, owner, review, url: "u", title: "T" })}\n\n`;
    const streams = [
      [
        ": connected\n\n",
        event("owner", null),
        event("review", { state: "pending", message: "Check login" }),
        event("review", { state: "pending", message: "Check login" }),
      ],
      [
        event("review", { state: "pending", message: "Check login" }),
        event("navigated", { state: "navigated" }),
        event("review", { state: "pending", message: "Again" }),
      ],
    ];
    const reviews: ReviewRequest[] = [];
    let connects = 0;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const browser = createAgentBrowser({
      vncSocket: "/nonexistent",
      proxyUrl: "http://proxy",
      logger: silentLogger,
      backoffMs: () => 0,
      onReview: (review) => {
        reviews.push(review);
        if (reviews.length === 3) done();
      },
      fetch: (async () => {
        const chunks = streams[connects++];
        if (!chunks) return new Response(null, { status: 503 });
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks)
                controller.enqueue(new TextEncoder().encode(chunk));
              controller.close();
            },
          }),
        );
      }) as unknown as typeof fetch,
    });
    browser.start();
    await finished;
    browser.stop();
    expect(reviews.map((review) => review.message)).toEqual([
      "Check login",
      "Check login",
      "Again",
    ]);
    expect(reviews[0]).toMatchObject({ targetId: "t1", owner, title: "T" });
  });

  test("bridges bytes both ways and closes the peer with the socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thyra-vnc-"));
    const path = join(dir, "vnc.sock");
    const received: string[] = [];
    let serverSocket: { write(data: string): number; end(): void } | null =
      null;
    const listener = Bun.listen({
      unix: path,
      socket: {
        open(socket) {
          serverSocket = socket;
          socket.write("RFB 003.008\n");
        },
        data(_socket, data) {
          received.push(data.toString());
        },
      },
    });
    try {
      const browser = createAgentBrowser({
        vncSocket: path,
        proxyUrl: "http://proxy",
        logger: silentLogger,
        onReview: () => {},
      });
      expect(browser.status().vnc).toBe(true);
      const sent: string[] = [];
      let closed: number | undefined;
      const { promise: gotHello, resolve: hello } = Promise.withResolvers();
      const { promise: gotClose, resolve: closeSeen } = Promise.withResolvers();
      const bridge = browser.openVnc({
        send: (data) => {
          sent.push(Buffer.from(data).toString());
          hello(undefined);
        },
        close: (code) => {
          closed = code;
          closeSeen(undefined);
        },
      });
      bridge.message(new TextEncoder().encode("RFB 003.008\n"));
      await gotHello;
      expect(sent.join("")).toBe("RFB 003.008\n");
      for (let i = 0; i < 50 && received.length === 0; i++) await Bun.sleep(10);
      expect(received.join("")).toBe("RFB 003.008\n");
      serverSocket!.end();
      await gotClose;
      expect(closed).toBe(1000);
    } finally {
      listener.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing socket closes the peer at once", () => {
    const browser = createAgentBrowser({
      vncSocket: "/nonexistent/vnc.sock",
      proxyUrl: "http://proxy",
      logger: silentLogger,
      onReview: () => {},
    });
    let code: number | undefined;
    browser.openVnc({ send() {}, close: (value) => (code = value) });
    expect(code).toBe(4404);
  });
});
