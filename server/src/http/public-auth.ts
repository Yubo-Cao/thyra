import { createHash } from "node:crypto";

import type { RpcRole } from "../authz/policy";
import type { LoginRateLimiter } from "./login-rate-limit";
import { loginLocale, type LoginLocale } from "./login-page";
import type { RequestAccess } from "./request-access";

/**
 * Authentication on the public listener. The owner's password, token,
 * `herdr_auth` cookie, tailnet login and loopback bypass never apply there;
 * a request is authenticated only by a `PublicAuthenticator` (accounts and
 * passkeys). The default authenticator knows nobody, so the public listener
 * serves the login page and static assets and answers everything else 401.
 */

/** An authenticated account on the public listener. */
export type PublicPrincipal = {
  /** Stable account id, for logs and grants. */
  id: string;
  /** RPC role; `owner` only for accounts the owner marked as admins. */
  role: RpcRole;
};

/** Facts the router hands the authenticator for one public request. */
export type PublicRequestContext = {
  access: RequestAccess;
  /** The one browser origin, such as `https://thyra.example.com`. */
  origin: string;
  /** Rate limiter for credential attempts, keyed by `access.clientAddress`. */
  loginLimiter: LoginRateLimiter;
};

export interface PublicAuthenticator {
  /**
   * Serve an authentication route (login page, login and logout API,
   * passkey ceremonies) before any session check; null when `url` is not
   * one. Responses that set a session must use `publicCookie`.
   */
  handle(
    req: Request,
    url: URL,
    context: PublicRequestContext,
  ): Response | null | Promise<Response | null>;
  /** The principal of this request's session, or null. */
  authenticate(
    req: Request,
    context: PublicRequestContext,
  ): PublicPrincipal | null | Promise<PublicPrincipal | null>;
}

/**
 * Cookies on the public listener carry the `__Host-` prefix: the browser
 * then requires `Secure`, `Path=/` and no `Domain`, so no other subdomain can
 * set or read them.
 */
export function publicCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("invalid cookie name");
  return `__Host-${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

/** Value of a `__Host-` cookie set by `publicCookie`, or null. */
export function readPublicCookie(req: Request, name: string): string | null {
  const wanted = `__Host-${name}`;
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== wanted) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

const UNAVAILABLE = {
  en: {
    title: "Thyra",
    heading: "Sign-in is not available here yet",
    body: "This address does not accept sign-ins yet. If you administer this Thyra, use your private address.",
  },
  "zh-CN": {
    title: "Thyra",
    heading: "此地址暂不支持登录",
    body: "此地址尚未开放登录。如果你是此 Thyra 的管理员，请使用你的私有地址。",
  },
} satisfies Record<LoginLocale, Record<string, string>>;

const UNAVAILABLE_STYLE =
  "body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font-family:system-ui,sans-serif;background:#141516;color:#eeeef0}main{max-width:420px}img{width:48px;height:48px}h1{font-size:22px;margin:16px 0 8px}p{color:#a9abb0;line-height:1.6;margin:0}@media(prefers-color-scheme:light){body{background:#f5f5f3;color:#252629}p{color:#64666d}}";

export function renderLoginUnavailableHtml(locale: LoginLocale): string {
  const s = UNAVAILABLE[locale];
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="referrer" content="no-referrer">
<title>${s.title}</title>
<link rel="icon" type="image/svg+xml" href="/thyra-icon.svg">
<style>${UNAVAILABLE_STYLE}</style>
</head>
<body>
<main>
<img src="/thyra-icon-192.png" alt="" width="48" height="48">
<h1>${s.heading}</h1>
<p>${s.body}</p>
</main>
</body>
</html>`;
}

/**
 * The authenticator used until accounts exist: `/login` explains that
 * sign-in is unavailable and no request is ever authenticated.
 */
export function createLoginUnavailableAuthenticator(): PublicAuthenticator {
  return {
    handle(req, url) {
      if (url.pathname !== "/login") return null;
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("method not allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      return new Response(
        renderLoginUnavailableHtml(
          loginLocale(req.headers.get("accept-language")),
        ),
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            vary: "Accept-Language",
          },
        },
      );
    },
    authenticate: () => null,
  };
}

/**
 * Files served before login on the public listener: fingerprinted bundles,
 * icons and the manifest. The SPA entry, service worker and asset list are
 * served only after login.
 */
export function isPublicStaticAsset(pathname: string): boolean {
  return (
    /^\/assets\/[A-Za-z0-9._-]+$/.test(pathname) ||
    /^\/thyra-(?:icon|mark)(?:-\d+)?\.(?:png|svg)$/.test(pathname) ||
    pathname === "/favicon.ico" ||
    pathname === "/manifest.json"
  );
}

/** `sha256-...` CSP sources for the inline scripts of an HTML document. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(
    /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const digest = createHash("sha256")
      .update(match[1] ?? "", "utf8")
      .digest("base64");
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

/**
 * Content Security Policy for Thyra's own pages on the public listener.
 * Scripts come only from this origin (plus the listed inline-script hashes
 * of the SPA entry); WebAssembly is needed for voice activity detection.
 * Inline styles stay allowed for React style attributes and xterm.
 */
export function publicContentSecurityPolicy(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${scriptHashes.map((hash) => ` ${hash}`).join("")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const PUBLIC_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)",
};

/**
 * Add the public listener's security headers. HTML responses get the strict
 * CSP unless they already carry a sandboxing policy (workspace previews).
 */
export function withPublicSecurityHeaders(
  response: Response,
  htmlPolicy: string,
): Response {
  // WebSocket upgrades and 101 responses cannot be rewrapped.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(PUBLIC_RESPONSE_HEADERS)) {
    headers.set(name, value);
  }
  if (
    (headers.get("content-type") ?? "").startsWith("text/html") &&
    !headers.get("content-security-policy")?.startsWith("sandbox")
  ) {
    headers.set("content-security-policy", htmlPolicy);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
