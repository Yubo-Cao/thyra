import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { parseTrustedProxies } from "../identity/client-address";
import { createLoginRateLimiter } from "./login-rate-limit";
import {
  createLoginUnavailableAuthenticator,
  inlineScriptHashes,
  isPublicStaticAsset,
  publicContentSecurityPolicy,
  publicCookie,
  readPublicCookie,
  withPublicSecurityHeaders,
} from "./public-auth";
import { createRequestAccessPolicy } from "./request-access";

const policy = createRequestAccessPolicy({
  listenerKind: "public",
  port: 8788,
  tls: false,
  bindHost: "127.0.0.1",
  publicOrigins: ["https://thyra.example"],
  trustedProxies: parseTrustedProxies("loopback"),
});

function context(req: Request) {
  return {
    access: policy.evaluate(req, "127.0.0.1"),
    origin: "https://thyra.example",
    loginLimiter: createLoginRateLimiter(),
  };
}

describe("login-unavailable authenticator", () => {
  const auth = createLoginUnavailableAuthenticator();

  test("serves an explanatory login page without a form or script", async () => {
    const req = new Request("http://127.0.0.1:8788/login", {
      headers: { host: "thyra.example", "accept-language": "zh-CN" },
    });
    const response = await auth.handle(req, new URL(req.url), context(req));
    expect(response?.status).toBe(200);
    const html = (await response?.text()) ?? "";
    expect(html).toContain('lang="zh-CN"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<form");
  });

  test("handles nothing else and authenticates nobody", async () => {
    for (const path of ["/", "/api/login", "/api/health", "/ws"]) {
      const req = new Request(`http://127.0.0.1:8788${path}`, {
        method: path === "/api/login" ? "POST" : "GET",
        headers: {
          host: "thyra.example",
          // The owner's cookie means nothing on the public listener.
          cookie: "herdr_auth=anything; __Host-thyra_session=forged",
        },
      });
      expect(await auth.handle(req, new URL(req.url), context(req))).toBeNull();
      expect(await auth.authenticate(req, context(req))).toBeNull();
    }
  });
});

describe("public cookies", () => {
  test("carry the __Host- prefix and its required attributes", () => {
    const cookie = publicCookie("thyra_session", "a b", 60);
    expect(cookie).toBe(
      "__Host-thyra_session=a%20b; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=60",
    );
    expect(cookie).not.toContain("Domain");
    expect(() => publicCookie("bad;name", "x", 1)).toThrow();
  });

  test("read only the prefixed cookie", () => {
    const req = new Request("http://x/", {
      headers: { cookie: "thyra_session=plain; __Host-thyra_session=v%3D1" },
    });
    expect(readPublicCookie(req, "thyra_session")).toBe("v=1");
    expect(
      readPublicCookie(
        new Request("http://x/", {
          headers: { cookie: "thyra_session=plain" },
        }),
        "thyra_session",
      ),
    ).toBeNull();
  });
});

describe("public static assets", () => {
  test.each([
    ["/assets/index-abc123.js", true],
    ["/assets/style.css", true],
    ["/thyra-icon-192.png", true],
    ["/thyra-icon.svg", true],
    ["/thyra-mark-48.png", true],
    ["/favicon.ico", true],
    ["/manifest.json", true],
    ["/", false],
    ["/index.html", false],
    ["/task-notifications-sw.js", false],
    ["/thyra-assets.json", false],
    ["/assets/../index.html", false],
    ["/assets/sub/file.js", false],
    ["/api/health", false],
  ])("%s -> %p", (path, allowed) => {
    expect(isPublicStaticAsset(path)).toBe(allowed);
  });
});

describe("public security headers", () => {
  test("inline scripts are allowed by hash only", () => {
    const html =
      '<script>alert(1)</script><script type="module" src="/a.js"></script><script>\n x()\n</script>';
    const digest = (text: string) =>
      `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
    expect(inlineScriptHashes(html)).toEqual([
      digest("alert(1)"),
      digest("\n x()\n"),
    ]);
    const csp = publicContentSecurityPolicy(inlineScriptHashes(html));
    expect(csp).toContain(
      `script-src 'self' 'wasm-unsafe-eval' ${digest("alert(1)")}`,
    );
    expect(csp).not.toContain("'unsafe-inline' ;");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  test("HTML gets the strict policy and every response HSTS", () => {
    const page = withPublicSecurityHeaders(
      new Response("<p>", {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "frame-ancestors 'none'",
        },
      }),
      "default-src 'self'",
    );
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'self'",
    );
    expect(page.headers.get("strict-transport-security")).toContain("max-age=");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");

    const unauthorized = withPublicSecurityHeaders(
      new Response("unauthorized", { status: 401 }),
      "default-src 'self'",
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("strict-transport-security")).toBeTruthy();
  });

  test("sandboxed previews keep their own policy", () => {
    const preview = withPublicSecurityHeaders(
      new Response("<p>", {
        headers: {
          "content-type": "text/html",
          "content-security-policy": "sandbox; default-src 'none'",
        },
      }),
      "default-src 'self'",
    );
    expect(preview.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'",
    );
  });
});
