import { createHash } from "node:crypto";

import type { AuthResult } from "../auth/principal";
import type { LoginRateLimiter } from "./login-rate-limit";
import type { RequestAccess } from "./request-access";

/**
 * Authentication on the public listener. The primary listener's session
 * cookie, tailnet login and loopback bypass never apply there; a request is
 * authenticated only by the `PublicAuthenticator` (accounts and passkeys,
 * `server/src/auth/public.ts`), whose `__Host-` session cookie the primary
 * listener in turn ignores.
 */

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
  /** The principal of this request's session (and a rotated cookie), if any. */
  authenticate(
    req: Request,
    context: PublicRequestContext,
  ): AuthResult | Promise<AuthResult>;
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
