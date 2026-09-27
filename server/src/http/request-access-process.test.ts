import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real router on a loopback listener behind a simulated Caddy.
test("loopback listener enforces Host, Origin, proxy login and RPC policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "thyra-access-"));
  const sockets: WebSocket[] = [];
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
      THYRA_PASSWORD: "",
      THYRA_PUBLIC_BASE_URL: "https://dev.example",
      THYRA_TRUSTED_PROXIES: "loopback",
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
  const ready = Promise.withResolvers<string>();
  const output = (async () => {
    let text = "";
    for await (const chunk of child.stdout) {
      text += new TextDecoder().decode(chunk);
      const port = text.match(/\bINFO bridge listening\b[^\r\n]*:(\d+)\b/)?.[1];
      if (port) ready.resolve(`http://127.0.0.1:${port}`);
    }
    ready.reject(
      new Error(`Server exited before listening: ${text}\n${await errors}`),
    );
  })();
  const deadline = setTimeout(
    () => ready.reject(new Error("Server startup timed out")),
    10_000,
  );
  try {
    const base = await ready.promise;
    clearTimeout(deadline);
    const request = (path: string, init?: RequestInit) =>
      fetch(`${base}${path}`, {
        redirect: "manual",
        ...init,
        signal: AbortSignal.timeout(5000),
      });
    const caddy = (client = "100.64.1.2") => ({
      host: "dev.example",
      "x-forwarded-for": client,
      "x-forwarded-host": "dev.example",
      "x-forwarded-proto": "https",
    });
    const upgradeHeaders = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    };

    // Direct local use keeps working without login.
    const health = await request("/api/health");
    expect(health.status).toBe(200);
    expect((await health.json()).auth_required).toBe(false);
    const page = await request("/", { headers: { accept: "text/html" } });
    expect(page.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");

    // DNS rebinding: a foreign name resolving to loopback.
    expect(
      (await request("/", { headers: { host: "attacker.example:8787" } }))
        .status,
    ).toBe(421);

    // Another local origin cannot open the WebSocket or POST.
    expect(
      (
        await request("/ws", {
          headers: { ...upgradeHeaders, origin: "http://127.0.0.1:1" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/logout", {
          method: "POST",
          headers: { origin: "http://localhost:1", "x-thyra-logout": "1" },
        })
      ).status,
    ).toBe(403);

    // Through the proxy nothing is local: login is required.
    expect(
      (
        await request("/api/health", {
          headers: { ...caddy(), "sec-fetch-site": "same-origin" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request("/ws", {
          headers: { ...upgradeHeaders, ...caddy() },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/login", {
          method: "POST",
          headers: { ...caddy(), origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
    ).toBe(403);

    const token = (
      await readFile(join(root, ".config", "thyra", "auth-token"), "utf8")
    ).trim();
    const login = await request("/api/login", {
      method: "POST",
      headers: { ...caddy(), origin: "https://dev.example" },
      body: JSON.stringify({ password: token }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("; Secure");
    const authCookie = setCookie.split(";", 1)[0];
    // The page load assigns the device cookie a browser then keeps.
    const app = await request("/", {
      headers: { ...caddy(), accept: "text/html", cookie: authCookie },
    });
    expect(app.status).toBe(200);
    const deviceCookie = (app.headers.get("set-cookie") ?? "").split(";", 1)[0];
    expect(deviceCookie).toStartWith("thyra_device=");
    const cookie = `${authCookie}; ${deviceCookie}`;

    const connect = async (session: string) => {
      const Socket = WebSocket as unknown as new (
        url: string,
        options: Bun.WebSocketOptions,
      ) => WebSocket;
      const ws = new Socket(
        `${base.replace("http:", "ws:")}/ws?client_session=${session}`,
        {
          headers: { ...caddy(), origin: "https://dev.example", cookie },
        },
      );
      sockets.push(ws);
      const messages: any[] = [];
      const waiters: ((message: any) => void)[] = [];
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        messages.push(message);
        for (const waiter of waiters.splice(0)) waiter(message);
      };
      const next = (match: (message: any) => boolean) =>
        new Promise<any>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("WebSocket message timed out")),
            5000,
          );
          const check = () => {
            const found = messages.find(match);
            if (found) {
              clearTimeout(timeout);
              resolve(found);
            } else waiters.push(check);
          };
          check();
        });
      const hello = await next((message) => message.hello === true);
      return { ws, hello, next };
    };
    const first = await connect("page-one-session");
    const again = await connect("page-one-session");
    const other = await connect("page-two-session");
    expect(first.hello.participant_id).toMatch(/^web-/);
    expect(again.hello.participant_id).toBe(first.hello.participant_id);
    expect(other.hello.participant_id).not.toBe(first.hello.participant_id);

    for (const method of ["server.stop", "plugin.enable", "workspace.get"]) {
      first.ws.send(JSON.stringify({ id: method, method, params: {} }));
      const reply = await first.next((message) => message.id === method);
      expect(reply.error?.message).toContain(`${method} is not allowed`);
    }

    // Ten wrong passwords from one client block it; others still log in.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wrong = await request("/api/login", {
        method: "POST",
        headers: { ...caddy("100.64.9.9"), origin: "https://dev.example" },
        body: JSON.stringify({ password: "wrong" }),
      });
      expect(wrong.status).toBe(401);
    }
    expect(
      (
        await request("/api/login", {
          method: "POST",
          headers: { ...caddy("100.64.9.9"), origin: "https://dev.example" },
          body: JSON.stringify({ password: token }),
        })
      ).status,
    ).toBe(429);
  } finally {
    for (const ws of sockets) ws.close();
    child.kill();
    await child.exited;
    await output.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
