import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real server with both listeners: the tailnet listener behind a
// simulated Caddy and the public listener behind a simulated cloudflared.
test.skipIf(process.platform === "win32")(
  "the public listener serves only passkey login and assets and never trusts tailnet headers",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "thyra-public-"));
    const whoisLog = join(root, "whois.log");
    const cli = join(root, "tailscale");
    await writeFile(
      cli,
      `#!/bin/sh
echo "$3" >> ${JSON.stringify(whoisLog)}
case "$3" in
  100.64.7.7) echo '{"Node":{"StableID":"n1","ComputedName":"iphone"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
  *) exit 1 ;;
esac
`,
    );
    await chmod(cli, 0o755);
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
        THYRA_DB_PATH: join(root, "thyra.db"),
        THYRA_PUBLIC_BASE_URL: "https://dev.example",
        THYRA_TRUSTED_PROXIES: "loopback",
        THYRA_PUBLIC_LISTEN: "127.0.0.1:0",
        THYRA_PUBLIC_ORIGIN: "https://thyra.example",
        THYRA_PUBLIC_TRUSTED_PROXIES: "",
        THYRA_TAILSCALE_IDENTITY: "",
        THYRA_TAILSCALE_SOCKET: "",
        THYRA_TAILSCALE_CLI: cli,
        THYRA_TAILNET_AUTH: "",
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
    const ready = Promise.withResolvers<{ primary: string; public: string }>();
    const output = (async () => {
      let text = "";
      for await (const chunk of child.stdout) {
        text += new TextDecoder().decode(chunk);
        const primary = text.match(
          /\bINFO bridge listening\b[^\r\n]*:(\d+)\b/,
        )?.[1];
        const publicPort = text.match(
          /\bINFO bridge public listener\b[^\r\n]*listen=http:\/\/[^:\s]+:(\d+)/,
        )?.[1];
        if (primary && publicPort) {
          ready.resolve({
            primary: `http://127.0.0.1:${primary}`,
            public: `http://127.0.0.1:${publicPort}`,
          });
        }
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
      const bases = await ready.promise;
      clearTimeout(deadline);
      const request = (base: string, path: string, init?: RequestInit) =>
        fetch(`${base}${path}`, {
          redirect: "manual",
          ...init,
          signal: AbortSignal.timeout(5000),
        });
      // What cloudflared sends: the public Host and the edge client address.
      const cloudflared = (client = "203.0.113.5") => ({
        host: "thyra.example",
        "cf-connecting-ip": client,
        "cf-ray": "8a1b2c3d4e5f6789-SJC",
        "x-forwarded-for": client,
        "x-forwarded-proto": "https",
      });
      const caddy = (client: string) => ({
        host: "dev.example",
        "x-forwarded-for": client,
        "x-forwarded-host": "dev.example",
        "x-forwarded-proto": "https",
      });
      const upgrade = {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      };
      const pub = (path: string, init?: RequestInit) =>
        request(bases.public, path, init);

      // Login page and static assets, with the public security headers.
      const login = await pub("/login", { headers: cloudflared() });
      expect(login.status).toBe(200);
      expect(login.headers.get("set-cookie")).toBeNull();
      expect(login.headers.get("strict-transport-security")).toContain(
        "max-age=",
      );
      const csp = login.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      // No inline script: the passkey logic is an external same-origin file.
      const loginHtml = await login.text();
      expect(loginHtml).toContain('<script src="/auth/passkey.js" defer>');
      expect(loginHtml).not.toContain("<form");
      const script = await pub("/auth/passkey.js", { headers: cloudflared() });
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toContain("text/javascript");
      // Passkeys are bound to the public host name.
      const options = await pub("/api/auth/passkey/login/options", {
        method: "POST",
        headers: {
          ...cloudflared(),
          origin: "https://thyra.example",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(options.status).toBe(200);
      expect(
        ((await options.json()) as { options?: { rpId?: string } }).options
          ?.rpId,
      ).toBe("thyra.example");
      expect(
        (await pub("/thyra-icon.svg", { headers: cloudflared() })).status,
      ).toBe(200);
      // A missing asset is not answered with the SPA entry.
      expect(
        (
          await pub("/assets/missing.js", {
            headers: { ...cloudflared(), accept: "text/html" },
          })
        ).status,
      ).toBe(404);
      const app = await pub("/", {
        headers: { ...cloudflared(), accept: "text/html" },
      });
      expect(app.status).toBe(302);
      expect(app.headers.get("location")).toBe("/login");

      // The removed password login, a tailnet cookie, and every header
      // that claims tailnet identity are all ignored.
      const passwordLogin = await pub("/api/login", {
        method: "POST",
        headers: {
          ...cloudflared(),
          origin: "https://thyra.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "correct horse" }),
      });
      expect(passwordLogin.status).toBe(401);
      expect(passwordLogin.headers.get("set-cookie")).toBeNull();

      const spoofs: Record<string, string>[] = [
        cloudflared("100.64.7.7"),
        { ...cloudflared(), "x-forwarded-for": "100.64.7.7" },
        { ...cloudflared(), "x-real-ip": "100.64.7.7" },
        { ...caddy("100.64.7.7"), host: "thyra.example" },
        {
          ...cloudflared(),
          "tailscale-user-login": "owner@example.com",
          "tailscale-user-name": "Owner",
        },
        { host: "thyra.example", "x-forwarded-for": "100.64.7.7" },
      ];
      for (const headers of spoofs) {
        for (const path of ["/api/health", "/api/herdr/status", "/mcp"]) {
          const response = await pub(path, {
            headers: { ...headers, origin: "https://thyra.example" },
          });
          expect(response.status).toBe(401);
          expect(response.headers.get("set-cookie")).toBeNull();
        }
        const page = await pub("/", {
          headers: { ...headers, accept: "text/html" },
        });
        expect(page.status).toBe(302);
        const socket = await pub("/ws", {
          headers: { ...headers, ...upgrade, origin: "https://thyra.example" },
        });
        expect(socket.status).toBe(401);
      }
      // Whois never ran for any public request.
      expect(await readFile(whoisLog, "utf8").catch(() => "")).toBe("");

      // Host and Origin are pinned to the public origin.
      expect(
        (
          await pub("/login", {
            headers: { ...cloudflared(), host: "dev.example" },
          })
        ).status,
      ).toBe(421);
      expect(
        (await pub("/login", { headers: { host: "127.0.0.1" } })).status,
      ).toBe(421);
      expect(
        (
          await pub("/api/health", {
            headers: { ...cloudflared(), origin: "https://dev.example" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await pub("/ws", {
            headers: { ...cloudflared(), ...upgrade },
          })
        ).status,
      ).toBe(403);

      // The tailnet listener behaves as before.
      const tailnet = await request(bases.primary, "/", {
        headers: { ...caddy("100.64.7.7"), accept: "text/html" },
      });
      expect(tailnet.status).toBe(200);
      const session = tailnet.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith("thyra_session="));
      expect(session).toContain("; Secure");
      const cookie = session?.split(";", 1)[0] ?? "";
      expect(
        (
          await request(bases.primary, "/api/health", {
            headers: { ...caddy("203.0.113.5"), cookie },
          })
        ).status,
      ).toBe(200);
      // Its session cookie does not work on the public listener.
      expect(
        (
          await pub("/api/health", {
            headers: {
              ...cloudflared(),
              origin: "https://thyra.example",
              cookie,
            },
          })
        ).status,
      ).toBe(401);
      // Cloudflare-marked traffic that reaches the tailnet listener (a
      // misrouted tunnel) is refused or must log in.
      expect(
        (
          await request(bases.primary, "/", {
            headers: { ...cloudflared("100.64.7.7"), accept: "text/html" },
          })
        ).status,
      ).toBe(421);
      const marked = await request(bases.primary, "/", {
        headers: {
          ...caddy("100.64.7.7"),
          "cf-connecting-ip": "100.64.7.7",
          accept: "text/html",
        },
      });
      expect(marked.status).toBe(302);
      // Direct local use is unchanged.
      expect((await request(bases.primary, "/api/health")).status).toBe(200);

      // A share link made on the tailnet listener points at the public
      // origin; redeeming it there sets a `__Host-` guest cookie that only
      // the public listener accepts.
      const made = await request(
        bases.primary,
        "/api/share-links?connection_id=legacy-default&workspace_id=w1",
        {
          method: "POST",
          headers: {
            ...caddy("203.0.113.5"),
            origin: "https://dev.example",
            "content-type": "application/json",
            cookie,
          },
          body: JSON.stringify({ label: "public" }),
        },
      );
      expect(made.status).toBe(200);
      const url = new URL(((await made.json()) as { url: string }).url);
      expect(url.origin).toBe("https://thyra.example");
      const landing = await pub(url.pathname, {
        headers: { ...cloudflared(), accept: "text/html" },
      });
      expect(landing.status).toBe(200);
      expect(landing.headers.get("referrer-policy")).toBe("no-referrer");
      expect(landing.headers.get("content-security-policy")).toContain(
        "script-src 'self'",
      );
      const redeemed = await pub("/api/share/redeem", {
        method: "POST",
        headers: {
          ...cloudflared(),
          origin: "https://thyra.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: url.pathname.split("/")[2],
          secret: url.hash.slice(1),
        }),
      });
      expect(redeemed.status).toBe(200);
      const guestSetCookie = redeemed.headers.getSetCookie()[0] ?? "";
      expect(guestSetCookie).toStartWith("__Host-thyra_guest=");
      expect(guestSetCookie).toContain("; Secure");
      const guestCookie = guestSetCookie.split(";", 1)[0]!;
      const guestHealth = await pub("/api/health", {
        headers: { ...cloudflared(), cookie: guestCookie },
      });
      expect(guestHealth.status).toBe(200);
      expect(
        ((await guestHealth.json()) as { principal: { kind: string } })
          .principal.kind,
      ).toBe("guest");
      expect(
        (
          await pub("/", {
            headers: {
              ...cloudflared(),
              accept: "text/html",
              cookie: guestCookie,
            },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(bases.primary, "/api/health", {
            headers: { ...caddy("203.0.113.5"), cookie: guestCookie },
          })
        ).status,
      ).toBe(401);
    } finally {
      child.kill();
      await child.exited;
      await output.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);
