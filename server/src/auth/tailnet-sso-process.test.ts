import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { startTestServer } from "../../test-support/auth/harness";

// Tailnet sign-in across the real server's two listeners: the tailnet
// listener behind a simulated Caddy (stub `tailscale whois`) issues a code
// to the public login page's origin, and the public listener behind a
// simulated cloudflared redeems it for a session.
test.skipIf(process.platform === "win32")(
  "a tailnet device signs in to the public listener without a passkey",
  async () => {
    const server = await startTestServer({
      whois: { "100.64.7.7": "owner@example.com" },
      env: {
        THYRA_PUBLIC_LISTEN: "127.0.0.1:0",
        THYRA_PUBLIC_ORIGIN: "https://thyra.example",
        THYRA_PUBLIC_TRUSTED_PROXIES: "",
        THYRA_TAILNET_SSO_URL: "https://dev.example",
      },
    });
    try {
      const cloudflared = {
        host: "thyra.example",
        "cf-connecting-ip": "203.0.113.5",
        "cf-ray": "8a1b2c3d4e5f6789-SJC",
      };
      const pub = (path: string, init: RequestInit = {}) =>
        fetch(`${server.publicBase}${path}`, {
          redirect: "manual",
          ...init,
          headers: { ...cloudflared, ...(init.headers ?? {}) },
          signal: AbortSignal.timeout(5000),
        });
      const tailnet = (client: string, path: string, init: RequestInit = {}) =>
        server.request(path, {
          ...init,
          headers: { ...server.proxy(client), ...(init.headers ?? {}) },
        });

      // The login page may fetch the tailnet origin and says so in its CSP.
      const login = await pub("/login");
      expect(login.status).toBe(200);
      expect(login.headers.get("content-security-policy")).toContain(
        "connect-src 'self' https://dev.example",
      );
      expect(await login.text()).toContain('"silent":true');

      // The preflight passes the primary listener's Origin check for the
      // public origin only.
      const preflight = await tailnet("100.64.7.7", "/auth/tailnet-sso/code", {
        method: "OPTIONS",
        headers: {
          origin: "https://thyra.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
          "access-control-request-private-network": "true",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(
        "https://thyra.example",
      );
      expect(
        preflight.headers.get("access-control-allow-private-network"),
      ).toBe("true");

      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const ask = (client: string, origin = "https://thyra.example") =>
        tailnet(client, "/auth/tailnet-sso/code", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ code_challenge: challenge }),
        });
      expect((await ask("100.64.7.7", "https://dev.example")).status).toBe(403);
      // A device the stub whois does not know, and a non-tailnet client.
      expect((await ask("100.64.9.9")).status).toBe(403);
      expect((await ask("198.51.100.7")).status).toBe(403);
      // Tailscale headers on the public listener prove nothing there.
      const onPublic = await pub("/auth/tailnet-sso/code", {
        method: "POST",
        headers: {
          origin: "https://thyra.example",
          "content-type": "application/json",
          "x-forwarded-for": "100.64.7.7",
          "tailscale-user-login": "owner@example.com",
        },
        body: JSON.stringify({ code_challenge: challenge }),
      });
      expect(onPublic.status).toBe(401);

      const issued = await ask("100.64.7.7");
      expect(issued.status).toBe(200);
      const { code } = (await issued.json()) as { code: string };

      const redeem = () =>
        pub("/auth/tailnet-sso/redeem", {
          method: "POST",
          headers: {
            origin: "https://thyra.example",
            "content-type": "application/json",
          },
          body: JSON.stringify({ code, code_verifier: verifier }),
        });
      const done = await redeem();
      expect(done.status).toBe(200);
      const cookie = done.headers
        .getSetCookie()
        .find((value) => value.startsWith("__Host-thyra_session="))!
        .split(";")[0]!;
      const me = await pub("/api/auth/me", { headers: { cookie } });
      expect(me.status).toBe(200);
      expect(((await me.json()) as any).user.name).toBe("owner");
      expect((await redeem()).status).toBe(401);

      // The redirect flow's start points at the tailnet listener.
      const start = await pub("/auth/tailnet-sso/start");
      expect(start.status).toBe(303);
      expect(start.headers.get("location")).toStartWith(
        "https://dev.example/auth/tailnet-sso/authorize?",
      );
      // And the tailnet side of it never runs on the public listener.
      expect(
        (await pub(`/auth/tailnet-sso/authorize?return=https://thyra.example`))
          .status,
      ).toBe(401);
    } finally {
      await server.stop();
    }
  },
  30_000,
);
