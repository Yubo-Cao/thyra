import { isIP } from "node:net";

import {
  addressInRange,
  isLoopbackAddress,
  normalizeAddress,
  resolveClientAddress,
  type TrustedProxies,
} from "../identity/client-address";

/**
 * Origin and Host checks that stop other web pages from using a signed-in
 * (or loopback) browser's authority, and stop DNS rebinding.
 *
 * - `Host` (or a trusted proxy's `X-Forwarded-Host`) must name this server:
 *   a loopback name, an IP literal, the bind host, or a
 *   `THYRA_PUBLIC_BASE_URL` host. An attacker-controlled DNS name that
 *   resolves to this server is therefore rejected.
 * - WebSocket upgrades and every non-GET/HEAD request must carry an allowed
 *   `Origin`: the request's own origin, a public base URL, or a loopback
 *   origin on the listening port. Without `Origin` they are accepted only
 *   from a direct loopback client addressing a loopback host (CLI, tests).
 * - GET requests to the API are refused when the browser reports a
 *   cross-site or same-site initiator, or an `Origin` that is not allowed.
 * - Only a direct loopback request without forwarding headers, a loopback
 *   `Host` and no foreign `Origin` is "local"; a request that came through
 *   a reverse proxy is never local, so it never skips login.
 */

export type RequestAccessOptions = {
  /** Listening port, for the loopback origins of direct local use. */
  port: number;
  /** Native TLS on the listener. */
  tls: boolean;
  /** Configured listen address. */
  bindHost: string;
  /** Normalized origins from `THYRA_PUBLIC_BASE_URL`. */
  publicOrigins: readonly string[];
  trustedProxies: TrustedProxies;
};

export type RequestAccess = {
  /** The effective host names this server. */
  hostAllowed: boolean;
  /** Effective host (`hostname[:port]`), from `X-Forwarded-Host` if proxied. */
  host: string | null;
  /** Origin the browser uses for this server, when the host is allowed. */
  ownOrigin: string | null;
  /** The peer is a trusted proxy and supplied forwarding headers. */
  proxied: boolean;
  /** Direct loopback use; eligible for the loopback-listener login bypass. */
  local: boolean;
  /** Effective scheme is HTTPS (native TLS or trusted `X-Forwarded-Proto`). */
  secure: boolean;
  /** Client address for rate limiting (forwarded only by trusted proxies). */
  clientAddress: string | null;
};

export type AccessDecision = { ok: true } | { ok: false; reason: string };

const FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function parsePublicBaseUrls(value: string | undefined): {
  origins: string[];
  invalid: string[];
} {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const token of (value ?? "").split(/[\s,]+/).filter(Boolean)) {
    try {
      const url = new URL(token);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username ||
        url.password
      ) {
        invalid.push(token);
        continue;
      }
      if (!origins.includes(url.origin)) origins.push(url.origin);
    } catch {
      invalid.push(token);
    }
  }
  return { origins, invalid };
}

/** `hostname[:port]` authority; null for anything else (paths, userinfo). */
function parseAuthority(
  value: string | null | undefined,
): { hostname: string; host: string } | null {
  const text = value?.trim().toLowerCase();
  if (!text || /[\s/\\?#@]/.test(text)) return null;
  try {
    const url = new URL(`http://${text}`);
    if (!url.hostname) return null;
    return { hostname: url.hostname, host: url.host };
  } catch {
    return null;
  }
}

/** Normalized serialized origin, or null for `null` and non-HTTP origins. */
function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.pathname !== "/") return null;
    if (url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isIpLiteral(hostname: string): boolean {
  return isIP(hostname.replace(/^\[|\]$/g, "")) !== 0;
}

function isLoopbackName(hostname: string): boolean {
  if (LOOPBACK_NAMES.has(hostname)) return true;
  const address = normalizeAddress(hostname);
  return address !== null && isLoopbackAddress(address);
}

function firstValue(header: string | null): string | null {
  return header?.split(",")[0]?.trim() || null;
}

export function createRequestAccessPolicy(options: RequestAccessOptions) {
  const scheme = options.tls ? "https" : "http";
  const publicHosts = new Set(
    options.publicOrigins.map((origin) => new URL(origin).hostname),
  );
  const bindName = parseAuthority(
    options.bindHost.includes(":") && !options.bindHost.startsWith("[")
      ? `[${options.bindHost}]`
      : options.bindHost,
  )?.hostname;
  const loopbackOrigins = new Set(
    ["localhost", "127.0.0.1", "[::1]"].map(
      (name) => new URL(`${scheme}://${name}:${options.port}`).origin,
    ),
  );

  function hostnameAllowed(hostname: string): boolean {
    return (
      isLoopbackName(hostname) ||
      // A rebinding page is served from a DNS name, never an IP literal.
      isIpLiteral(hostname) ||
      publicHosts.has(hostname) ||
      hostname === bindName
    );
  }

  function evaluate(
    req: Request,
    peer: string | null | undefined,
  ): RequestAccess {
    const headers = req.headers;
    const forwarding = FORWARDING_HEADERS.some((name) => headers.has(name));
    const peerAddress = normalizeAddress(peer);
    const trustedPeer =
      peerAddress !== null &&
      options.trustedProxies.ranges.some((range) =>
        addressInRange(peerAddress, range),
      );
    const proxied = trustedPeer && forwarding;
    const forwardedHost = proxied
      ? parseAuthority(firstValue(headers.get("x-forwarded-host")))
      : null;
    const authority = forwardedHost ?? parseAuthority(headers.get("host"));
    const forwardedProto = proxied
      ? firstValue(headers.get("x-forwarded-proto"))?.toLowerCase()
      : undefined;
    const effectiveScheme =
      forwardedProto === "https" || forwardedProto === "http"
        ? forwardedProto
        : scheme;
    const hostAllowed = authority ? hostnameAllowed(authority.hostname) : false;
    const ownOrigin =
      authority && hostAllowed
        ? new URL(`${effectiveScheme}://${authority.host}`).origin
        : null;
    const origin = headers.get("origin");
    const local =
      !forwarding &&
      peerAddress !== null &&
      isLoopbackAddress(peerAddress) &&
      authority !== null &&
      isLoopbackName(authority.hostname) &&
      (origin === null || loopbackOrigins.has(parseOrigin(origin) ?? ""));
    const client = resolveClientAddress({
      peer,
      headers,
      trusted: options.trustedProxies,
    });
    return {
      hostAllowed,
      host: authority?.host ?? null,
      ownOrigin,
      proxied,
      local,
      secure: effectiveScheme === "https",
      clientAddress: client.address,
    };
  }

  function originAllowed(origin: string, access: RequestAccess): boolean {
    const parsed = parseOrigin(origin);
    if (!parsed) return false;
    return (
      parsed === access.ownOrigin ||
      options.publicOrigins.includes(parsed) ||
      loopbackOrigins.has(parsed)
    );
  }

  /**
   * Browser-context check. `strict` applies to WebSocket upgrades and
   * state-changing methods: an `Origin` is then required unless the
   * request is local.
   */
  function checkOrigin(
    req: Request,
    access: RequestAccess,
    strict: boolean,
  ): AccessDecision {
    const origin = req.headers.get("origin");
    if (origin !== null) {
      return originAllowed(origin, access)
        ? { ok: true }
        : { ok: false, reason: "origin not allowed" };
    }
    const site = req.headers.get("sec-fetch-site");
    if (site === "cross-site" || site === "same-site") {
      return { ok: false, reason: "cross-site request" };
    }
    if (strict && !access.local) {
      return { ok: false, reason: "origin required" };
    }
    return { ok: true };
  }

  return { evaluate, checkOrigin, loopbackOrigins };
}

export type RequestAccessPolicy = ReturnType<typeof createRequestAccessPolicy>;

/** Methods that cannot change state and need no `Origin`. */
export function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/**
 * Whether a request needs the Origin check, and whether strictly: WebSocket
 * upgrades and state-changing methods always, API reads too (they return
 * workspace data or have side effects). Page and asset loads do not, so
 * links from other sites still open Thyra.
 */
export function originCheckMode(
  pathname: string,
  method: string,
): "strict" | "read" | "none" {
  if (pathname === "/ws" || !isSafeMethod(method)) return "strict";
  if (pathname === "/api" || pathname.startsWith("/api/")) return "read";
  return "none";
}

export function forbiddenResponse(reason: string): Response {
  return new Response(`forbidden: ${reason}`, {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function hostNotAllowedResponse(host: string | null): Response {
  return new Response(
    `misdirected request: host ${JSON.stringify(host ?? "")} is not served here. Add its URL to THYRA_PUBLIC_BASE_URL.`,
    {
      status: 421,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
