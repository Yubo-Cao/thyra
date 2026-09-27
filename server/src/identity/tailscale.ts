import { existsSync } from "node:fs";
import { type Logger, silentLogger } from "../utils/logger";
import { runProcessWithCodeTimeout } from "../utils/process-utils";
import {
  type AddressRange,
  addressInRange,
  parseAddressRange,
} from "./client-address";

/**
 * Tailscale identity for tailnet client addresses. A tailnet address belongs
 * to exactly one node, so `whois` names the device (node) and, for
 * user-owned nodes, the person (login). Lookups are cached, time-bounded and
 * fail soft: without Tailscale the bridge falls back to device cookies.
 */

const TAILNET_RANGES = ["100.64.0.0/10", "fd7a:115c:a1e0::/48"].map(
  (range) => parseAddressRange(range) as AddressRange,
);

export function isTailnetAddress(address: string | null | undefined) {
  return (
    typeof address === "string" &&
    TAILNET_RANGES.some((range) => addressInRange(address, range))
  );
}

export type TailscaleIdentity = {
  /** Node StableID (or numeric ID); identifies the device. */
  nodeId: string;
  /** Short device name, such as `iphone` or `liveopt`. */
  deviceName: string;
  os?: string;
  /** Present for user-owned nodes; tagged nodes have no person. */
  user?: { login: string; displayName?: string; avatarUrl?: string };
};

function text(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function firstLabel(name: string | undefined) {
  return name?.replace(/\.$/, "").split(".")[0] || undefined;
}

function httpsUrl(value: unknown): string | undefined {
  const candidate = text(value, 2048);
  if (!candidate) return undefined;
  try {
    return new URL(candidate).protocol === "https:" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** Parse `tailscale whois --json` / LocalAPI `whois` output. */
export function parseTailscaleWhois(raw: unknown): TailscaleIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const node = (raw as { Node?: unknown }).Node as
    | Record<string, unknown>
    | undefined;
  if (!node || typeof node !== "object") return null;
  const nodeId =
    text(node.StableID) ??
    (typeof node.ID === "number" || typeof node.ID === "string"
      ? String(node.ID)
      : undefined);
  if (!nodeId) return null;
  const hostinfo = (node.Hostinfo ?? {}) as Record<string, unknown>;
  const hostname = text(hostinfo.Hostname, 80);
  // Mobile clients often report the useless host name "localhost".
  const deviceName =
    text(node.ComputedName, 80) ??
    firstLabel(text(node.Name, 253)) ??
    (hostname && hostname.toLowerCase() !== "localhost" ? hostname : "") ??
    "";
  const tags = Array.isArray(node.Tags) ? node.Tags : [];
  const profile = (raw as { UserProfile?: unknown }).UserProfile as
    | Record<string, unknown>
    | undefined;
  const login = text(profile?.LoginName, 200);
  const user =
    tags.length === 0 && login && login !== "tagged-devices"
      ? {
          login,
          ...(text(profile?.DisplayName, 80)
            ? { displayName: text(profile?.DisplayName, 80) }
            : {}),
          ...(httpsUrl(profile?.ProfilePicURL)
            ? { avatarUrl: httpsUrl(profile?.ProfilePicURL) }
            : {}),
        }
      : undefined;
  const os = text(hostinfo.OS, 40);
  return {
    nodeId,
    deviceName,
    ...(os ? { os } : {}),
    ...(user ? { user } : {}),
  };
}

/** Returns parsed JSON, or null when the address is not a known peer. */
export type WhoisBackend = (
  address: string,
  timeoutMs: number,
) => Promise<unknown | null>;

export function tailscaleCliWhois(
  cli: string,
  run: typeof runProcessWithCodeTimeout = runProcessWithCodeTimeout,
): WhoisBackend {
  return async (address, timeoutMs) => {
    const result = await run([cli, "whois", "--json", address], timeoutMs);
    if (result.code !== 0) return null;
    return JSON.parse(result.stdout);
  };
}

export function tailscaleSocketWhois(socketPath: string): WhoisBackend {
  return async (address, timeoutMs) => {
    const response = await fetch(
      `http://local-tailscaled.sock/localapi/v0/whois?addr=${encodeURIComponent(address)}`,
      { unix: socketPath, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`tailscaled whois ${response.status}`);
    return response.json();
  };
}

const DEFAULT_SOCKETS = [
  "/var/run/tailscale/tailscaled.sock",
  "/run/tailscale/tailscaled.sock",
];
const MACOS_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/**
 * `THYRA_TAILSCALE_IDENTITY=off` disables lookups; `THYRA_TAILSCALE_SOCKET`
 * or `THYRA_TAILSCALE_CLI` selects a backend. Otherwise the tailscaled
 * LocalAPI socket is preferred, then a `tailscale` CLI on `PATH`.
 */
export function tailscaleWhoisBackendFromEnv(
  env: Record<string, string | undefined> = process.env,
  probe: {
    exists?: (path: string) => boolean;
    which?: (command: string) => string | null;
    platform?: string;
  } = {},
): { backend: WhoisBackend; description: string } | null {
  const mode = env.THYRA_TAILSCALE_IDENTITY?.trim().toLowerCase();
  if (mode === "off" || mode === "0" || mode === "false") return null;
  const exists = probe.exists ?? existsSync;
  const which = probe.which ?? ((command: string) => Bun.which(command));
  const platform = probe.platform ?? process.platform;
  const socket = env.THYRA_TAILSCALE_SOCKET?.trim();
  if (socket) {
    return { backend: tailscaleSocketWhois(socket), description: socket };
  }
  const cli = env.THYRA_TAILSCALE_CLI?.trim();
  if (cli) return { backend: tailscaleCliWhois(cli), description: cli };
  if (platform === "linux") {
    const found = DEFAULT_SOCKETS.find((path) => exists(path));
    if (found) {
      return { backend: tailscaleSocketWhois(found), description: found };
    }
  }
  const onPath =
    which("tailscale") ??
    (platform === "darwin" && exists(MACOS_APP_CLI) ? MACOS_APP_CLI : null);
  return onPath
    ? { backend: tailscaleCliWhois(onPath), description: onPath }
    : null;
}

export type TailscaleWhois = {
  readonly available: boolean;
  lookup(address: string): Promise<TailscaleIdentity | null>;
};

export function createTailscaleWhois(args: {
  backend: WhoisBackend | null;
  ttlMs?: number;
  negativeTtlMs?: number;
  timeoutMs?: number;
  maxEntries?: number;
  now?: () => number;
  logger?: Logger;
}): TailscaleWhois {
  const ttlMs = args.ttlMs ?? 5 * 60_000;
  const negativeTtlMs = args.negativeTtlMs ?? 30_000;
  const timeoutMs = args.timeoutMs ?? 1_500;
  const maxEntries = args.maxEntries ?? 512;
  const now = args.now ?? Date.now;
  const logger = args.logger ?? silentLogger;
  const cache = new Map<
    string,
    { value: TailscaleIdentity | null; expiresAt: number }
  >();
  const inflight = new Map<string, Promise<TailscaleIdentity | null>>();
  let warned = false;

  function remember(address: string, value: TailscaleIdentity | null) {
    cache.delete(address);
    cache.set(address, {
      value,
      expiresAt: now() + (value ? ttlMs : negativeTtlMs),
    });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function query(address: string, backend: WhoisBackend) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        backend(address, timeoutMs),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("tailscale whois timed out")),
            timeoutMs + 250,
          );
        }),
      ]);
      const identity = raw === null ? null : parseTailscaleWhois(raw);
      remember(address, identity);
      return identity;
    } catch (error) {
      if (!warned) {
        warned = true;
        logger.warn("tailscale identity lookup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      remember(address, null);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    available: args.backend !== null,
    lookup(address) {
      const backend = args.backend;
      if (!backend || !isTailnetAddress(address)) return Promise.resolve(null);
      const cached = cache.get(address);
      if (cached && cached.expiresAt > now()) {
        return Promise.resolve(cached.value);
      }
      const pending = inflight.get(address);
      if (pending) return pending;
      const next = query(address, backend).finally(() => {
        inflight.delete(address);
      });
      inflight.set(address, next);
      return next;
    },
  };
}
