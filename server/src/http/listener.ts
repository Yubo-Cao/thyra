import { isIP } from "node:net";

import {
  isLoopbackAddress,
  normalizeAddress,
  parseTrustedProxies,
  type TrustedProxies,
} from "../identity/client-address";
import type { TailnetAuthMode } from "./tailnet-auth";

/**
 * Which listener a request arrived on. The listener, never a header, decides
 * how much a request is trusted:
 *
 * - `tailnet`: the primary listener with tailnet login on. Proxied tailnet
 *   users are logged in by Tailscale `whois`; direct local use of a loopback
 *   bind skips login.
 * - `local`: the primary listener with tailnet login off. Only direct local
 *   use of a loopback bind skips login.
 * - `public`: the internet-facing listener behind Cloudflare Tunnel
 *   (`THYRA_PUBLIC_LISTEN`). Nothing skips login, tailnet login is off, the
 *   owner cookie is ignored, and only the public origin is accepted.
 */
export type ListenerKind = "tailnet" | "local" | "public";

/** Kind of the primary (`HOST`/`PORT`) listener. */
export function primaryListenerKind(tailnetAuth: TailnetAuthMode) {
  return tailnetAuth === "admin" ? "tailnet" : "local";
}

export type PublicListenerConfig = {
  hostname: string;
  port: number;
  /** The single origin browsers use, such as `https://thyra.yubo.fun`. */
  origin: string;
  /** Proxies whose `CF-Connecting-IP` is believed (cloudflared). */
  trustedProxies: TrustedProxies;
  warnings: string[];
};

/** `host:port`, `[v6]:port` or a bare port (loopback). */
export function parseListenAddress(
  value: string,
): { hostname: string; port: number } | null {
  const text = value.trim();
  const match =
    text.match(/^\[([^\]]+)\]:(\d+)$/) ??
    text.match(/^([^:[\]]+):(\d+)$/) ??
    text.match(/^()(\d+)$/);
  if (!match) return null;
  const hostname = match[1] || "127.0.0.1";
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  if (hostname !== "localhost" && isIP(hostname) === 0) return null;
  return { hostname, port };
}

/**
 * The public listener settings, or null when `THYRA_PUBLIC_LISTEN` is unset.
 * Misconfiguration throws: the listener must never start half-configured.
 */
export function loadPublicListenerConfig(args: {
  listen: string | undefined;
  origin: string | undefined;
  trustedProxies: string | undefined;
  /** Origins of the primary listener (`THYRA_PUBLIC_BASE_URL`). */
  primaryOrigins: readonly string[];
  primary: { hostname: string; port: number };
}): PublicListenerConfig | null {
  const listen = args.listen?.trim();
  if (!listen) return null;
  const address = parseListenAddress(listen);
  if (!address) {
    throw new Error(
      `THYRA_PUBLIC_LISTEN must be host:port, such as 127.0.0.1:8788 (got ${JSON.stringify(listen)})`,
    );
  }
  let origin: string;
  try {
    const url = new URL(args.origin?.trim() ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0
    ) {
      throw new Error("not an HTTPS origin");
    }
    origin = url.origin;
  } catch {
    throw new Error(
      `THYRA_PUBLIC_LISTEN needs THYRA_PUBLIC_ORIGIN, the HTTPS origin of the public DNS name, such as https://thyra.example.com (got ${JSON.stringify(args.origin ?? "")})`,
    );
  }
  if (args.primaryOrigins.includes(origin)) {
    throw new Error(
      `THYRA_PUBLIC_ORIGIN ${origin} must not also be in THYRA_PUBLIC_BASE_URL: the primary listener would accept public traffic`,
    );
  }
  if (
    address.port !== 0 &&
    address.port === args.primary.port &&
    (address.hostname === args.primary.hostname ||
      args.primary.hostname === "0.0.0.0" ||
      args.primary.hostname === "::")
  ) {
    throw new Error("THYRA_PUBLIC_LISTEN must differ from HOST/PORT");
  }
  const warnings: string[] = [];
  const bind = normalizeAddress(address.hostname);
  if (address.hostname !== "localhost" && !(bind && isLoopbackAddress(bind))) {
    warnings.push(
      `THYRA_PUBLIC_LISTEN binds ${address.hostname}; bind loopback and let cloudflared reach it locally`,
    );
  }
  const trustedProxies = parseTrustedProxies(
    args.trustedProxies === undefined || args.trustedProxies.trim() === ""
      ? "loopback"
      : args.trustedProxies,
  );
  if (trustedProxies.invalid.length > 0) {
    warnings.push(
      `ignoring invalid THYRA_PUBLIC_TRUSTED_PROXIES entries: ${trustedProxies.invalid.join(",")}`,
    );
  }
  return { ...address, origin, trustedProxies, warnings };
}
