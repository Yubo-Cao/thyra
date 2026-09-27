import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { loginLocale, renderLoginHtml } from "./login-page";
import {
  type LoginRateLimiter,
  tooManyAttemptsResponse,
} from "./login-rate-limit";

const AUTH_COOKIE = "herdr_auth";
const AUTH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  return Buffer.from(
    padded.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
}

/** Per-request facts from the request-access policy. */
export type AuthRequestContext = {
  /**
   * Direct loopback use. On a loopback listener these requests skip login;
   * requests that came through a reverse proxy are never local.
   */
  local?: boolean;
  /** The browser reached Thyra over HTTPS; cookies get `Secure`. */
  secure?: boolean;
  /** Rate-limit key for login attempts (the resolved client address). */
  clientKey?: string | null;
};

export function createAuthHandlers(args: {
  /** Every request needs login (non-loopback listener). */
  authRequired: boolean;
  /** Signing secret and login password or token; empty disables login. */
  password: string;
  urlLoginToken?: string;
  secureCookies?: boolean;
  loginLimiter?: LoginRateLimiter;
}) {
  if (args.authRequired && !args.password) {
    throw new Error("authentication requires a non-empty signing secret");
  }

  function parseCookie(header: string | null, name: string): string | null {
    if (!header) return null;
    for (const part of header.split(";")) {
      const [key, ...rest] = part.trim().split("=");
      if (key !== name) continue;
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
    return null;
  }

  function sign(payload: string): string {
    return createHmac("sha256", args.password).update(payload).digest("hex");
  }

  function signedToken(): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = base64UrlEncode(
      JSON.stringify({
        iat: now,
        exp: now + AUTH_TOKEN_TTL_SECONDS,
        nonce: randomBytes(16).toString("hex"),
      }),
    );
    return `${payload}.${sign(payload)}`;
  }

  function secureAttribute(context: AuthRequestContext): string {
    return args.secureCookies || context.secure ? "; Secure" : "";
  }

  /** `Set-Cookie` value for a new session (login or tailnet login). */
  function sessionCookie(context: AuthRequestContext): string {
    if (!args.password) throw new Error("login is not configured");
    return `${AUTH_COOKIE}=${signedToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${AUTH_TOKEN_TTL_SECONDS}${secureAttribute(context)}`;
  }

  function authCookieHeaders(
    req: Request,
    context: AuthRequestContext,
  ): Record<string, string> {
    // Keep live tabs on the same session token without extending its expiry.
    if (hasValidSession(req)) return {};
    return { "set-cookie": sessionCookie(context) };
  }

  function clientKey(context: AuthRequestContext): string {
    return context.clientKey || "unknown";
  }

  function secretsEqual(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return (
      actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer)
    );
  }

  function isValidSignedToken(token: string): boolean {
    const [payload, signature, ...extra] = token.split(".");
    if (!payload || !signature || extra.length > 0) return false;
    const expected = sign(payload);
    const actualBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    if (actualBuffer.length !== expectedBuffer.length) return false;
    if (!timingSafeEqual(actualBuffer, expectedBuffer)) return false;
    try {
      const decoded = JSON.parse(base64UrlDecode(payload)) as { exp?: unknown };
      return (
        typeof decoded.exp === "number" &&
        decoded.exp > Math.floor(Date.now() / 1000)
      );
    } catch {
      return false;
    }
  }

  function sessionToken(req: Request): string | null {
    return parseCookie(req.headers.get("cookie"), AUTH_COOKIE);
  }

  function hasValidSession(req: Request): boolean {
    if (!args.password) return false;
    const token = sessionToken(req);
    return token !== null && isValidSignedToken(token);
  }

  /** Whether this request may skip login (loopback listener, local use). */
  function bypassesLogin(context: AuthRequestContext): boolean {
    return !args.authRequired && context.local === true;
  }

  function isAuthed(req: Request, context: AuthRequestContext = {}): boolean {
    return bypassesLogin(context) || hasValidSession(req);
  }

  function handleLogout(
    req: Request,
    context: AuthRequestContext = {},
  ): Response {
    if (req.method !== "POST") {
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }
    // Custom headers require a CORS preflight; the bridge grants no CORS access.
    // Unlike an Origin comparison, this also works behind reverse proxies.
    if (
      req.headers.get("x-thyra-logout") !== "1" ||
      req.headers.get("sec-fetch-site") === "cross-site"
    ) {
      return new Response("forbidden", { status: 403 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureAttribute(context)}`,
        "cache-control": "no-store",
      },
    });
  }

  /**
   * `?token=` on a page navigation is exchanged once for the session cookie
   * and removed by a redirect. It never authenticates the request itself,
   * API calls or WebSocket upgrades.
   */
  function handleTokenLogin(
    req: Request,
    context: AuthRequestContext = {},
  ): Response | null {
    if (!args.urlLoginToken || req.method !== "GET" || bypassesLogin(context)) {
      return null;
    }
    // pi-lens-ignore: unchecked-throwing-call
    const url = new URL(req.url);
    const suppliedToken = url.searchParams.get("token");
    if (suppliedToken === null) return null;
    if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) return null;
    const destination = req.headers.get("sec-fetch-dest");
    if (destination !== null && destination !== "document") return null;
    url.searchParams.delete("token");

    const key = clientKey(context);
    const retryAfter = args.loginLimiter?.retryAfterSeconds(key);
    if (retryAfter) return tooManyAttemptsResponse(retryAfter);
    const valid = secretsEqual(suppliedToken, args.urlLoginToken);
    if (valid) args.loginLimiter?.success(key);
    else args.loginLimiter?.failure(key);
    const location = valid ? `${url.pathname}${url.search}` : "/login";
    return new Response(null, {
      status: 303,
      headers: {
        location,
        ...(valid ? authCookieHeaders(req, context) : {}),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  async function handleLogin(
    req: Request,
    context: AuthRequestContext = {},
  ): Promise<Response> {
    if (bypassesLogin(context)) {
      return Response.json({ ok: true, note: "auth not required" });
    }
    const key = clientKey(context);
    const retryAfter = args.loginLimiter?.retryAfterSeconds(key);
    if (retryAfter) return tooManyAttemptsResponse(retryAfter);
    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "bad request" }, { status: 400 });
    }
    if (
      !args.password ||
      typeof body?.password !== "string" ||
      !secretsEqual(body.password, args.password)
    ) {
      args.loginLimiter?.failure(key);
      return Response.json({ error: "wrong password" }, { status: 401 });
    }
    args.loginLimiter?.success(key);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...authCookieHeaders(req, context),
      },
    });
  }

  function loginPage(req?: Request): Response {
    const locale = loginLocale(req?.headers.get("accept-language"));
    return new Response(renderLoginHtml(locale), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...HTML_SECURITY_HEADERS,
        vary: "Accept-Language",
      },
    });
  }

  return {
    isAuthed,
    sessionCookie,
    sessionToken,
    handleTokenLogin,
    handleLogin,
    handleLogout,
    loginPage,
  };
}

/** Headers for Thyra's own HTML pages (not workspace file previews). */
export const HTML_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
};

export function unauthenticatedLoginRedirect(): Response {
  // Use a relative Location so reverse proxies preserve the public origin
  // instead of leaking the internal upstream host. Intentionally ignores
  // request URLs and forwarded headers.
  return new Response(null, {
    status: 302,
    headers: { location: "/login" },
  });
}
