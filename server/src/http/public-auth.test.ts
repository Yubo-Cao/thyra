import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { openAccountDatabase } from "../accounts/database";
import { createAccountStore } from "../accounts/store";
import { createPasskeyService } from "../auth/passkeys";
import { createAuthenticator } from "../auth/principal";
import { createPublicAuthenticator } from "../auth/public";
import { createAuthRoutes } from "../auth/routes";
import { testDeps } from "../../test-support/authz/principals";
import { parseTrustedProxies } from "../identity/client-address";
import { createLoginRateLimiter } from "./login-rate-limit";
import {
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

function publicAuthenticator() {
  const store = createAccountStore(openAccountDatabase(":memory:"));
  const authenticator = createAuthenticator({
    store,
    authRequired: true,
    tailnetMode: "off",
    // Tailnet login never applies on the public listener.
    tailnetUser: async () => ({ login: "owner@example.com" }),
    hostOnlyCookie: true,
  });
  const routes = createAuthRoutes({
    store,
    authenticator,
    passkeys: createPasskeyService({ store }),
    limiter: createLoginRateLimiter(),
    authzDeps: testDeps(),
    connectionExists: () => false,
    onChange: () => {},
    onSessionEnded: () => {},
  });
  return {
    store,
    auth: createPublicAuthenticator({ authenticator, routes }),
  };
}

describe("public authenticator", () => {
  test("serves the passkey login page and its external script", async () => {
    const { auth } = publicAuthenticator();
    const page = new Request("http://127.0.0.1:8788/login", {
      headers: { host: "thyra.example", "accept-language": "zh-CN" },
    });
    const response = await auth.handle(page, new URL(page.url), context(page));
    expect(response?.status).toBe(200);
    const html = (await response?.text()) ?? "";
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain('<script src="/auth/passkey.js" defer>');
    // Only a JSON data block inline: the strict CSP needs no hash for it.
    expect(
      inlineScriptHashes(
        html.replace(
          /<script type="application\/json"[^>]*>[\s\S]*?<\/script>/,
          "",
        ),
      ),
    ).toEqual([]);
    const script = new Request("http://127.0.0.1:8788/auth/passkey.js", {
      headers: { host: "thyra.example" },
    });
    const js = await auth.handle(script, new URL(script.url), context(script));
    expect(js?.headers.get("content-type")).toContain("text/javascript");
  });

  test("handles nothing else and authenticates only its own cookie", async () => {
    const { auth, store } = publicAuthenticator();
    const user = store.createUser({ name: "owner", role: "admin" });
    const { token } = store.createSession({
      userId: user.id,
      authMethod: "passkey",
    });
    for (const path of ["/", "/api/login", "/api/health", "/ws"]) {
      const req = new Request(`http://127.0.0.1:8788${path}`, {
        method: path === "/api/login" ? "POST" : "GET",
        headers: {
          host: "thyra.example",
          // The primary listener's cookie means nothing here.
          cookie: `thyra_session=${token}; __Host-thyra_session=forged`,
        },
      });
      expect(await auth.handle(req, new URL(req.url), context(req))).toBeNull();
      expect((await auth.authenticate(req, context(req))).principal).toBeNull();
    }
    const req = new Request("http://127.0.0.1:8788/", {
      headers: {
        host: "thyra.example",
        cookie: `__Host-thyra_session=${token}`,
      },
    });
    const principal = (await auth.authenticate(req, context(req))).principal;
    expect(principal?.kind === "user" && principal.user.name).toBe("owner");
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
    ["/assets/./index.html", false],
    ["/assets/fonts/maple/400/0a1b2c.woff2", true],
    ["/assets/fonts/../../index.html", false],
    ["/assets/", false],
    ["/assets//a.js", false],
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
    expect(page.headers.get("cache-control")).toBe("no-transform");

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
