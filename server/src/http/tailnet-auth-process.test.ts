import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real router with a stub `tailscale whois` behind a simulated proxy.
test.skipIf(process.platform === "win32")(
  "tailnet users behind the proxy log in by whois and get a session cookie",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "thyra-tailnet-"));
    const cli = join(root, "tailscale");
    await writeFile(
      cli,
      `#!/bin/sh
case "$3" in
  100.64.7.7) echo '{"Node":{"StableID":"n1","ComputedName":"iphone"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
  100.64.7.9) echo 'not json' ;;
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
        THYRA_PASSWORD: "",
        THYRA_PUBLIC_BASE_URL: "https://dev.example",
        THYRA_TRUSTED_PROXIES: "loopback",
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
    const ready = Promise.withResolvers<string>();
    const output = (async () => {
      let text = "";
      for await (const chunk of child.stdout) {
        text += new TextDecoder().decode(chunk);
        const port = text.match(
          /\bINFO bridge listening\b[^\r\n]*:(\d+)\b/,
        )?.[1];
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
      const page = (client: string, cookie = "") =>
        fetch(`${base}/`, {
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
          headers: {
            accept: "text/html",
            host: "dev.example",
            "x-forwarded-for": client,
            "x-forwarded-host": "dev.example",
            "x-forwarded-proto": "https",
            ...(cookie ? { cookie } : {}),
          },
        });

      const tailnet = await page("100.64.7.7");
      expect(tailnet.status).toBe(200);
      const session = tailnet.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith("herdr_auth="));
      expect(session).toContain("; Secure");
      expect(session).toContain("HttpOnly");

      // The cookie alone authenticates later requests, without whois.
      const cookie = session?.split(";", 1)[0] ?? "";
      expect((await page("203.0.113.5", cookie)).status).toBe(200);

      // Whois failures, unknown peers and non-tailnet clients must log in.
      for (const client of ["100.64.7.9", "100.64.7.8", "203.0.113.5"]) {
        const response = await page(client);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/login");
      }
      // A client-supplied tailnet prefix does not count.
      expect((await page("100.64.7.7, 203.0.113.5")).status).toBe(302);

      // Direct local use is unchanged: no login, no cookie.
      const local = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(local.status).toBe(200);
      expect(local.headers.get("set-cookie")).toBeNull();
    } finally {
      child.kill();
      await child.exited;
      await output.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);
