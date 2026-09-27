import { isIPv4, isIPv6 } from "node:net";

/**
 * Client address resolution for presence identity. Forwarded headers are
 * honored only when the direct peer is a trusted reverse proxy (loopback by
 * default), so a browser cannot choose the address it is identified by.
 * Authentication never depends on this address.
 */

export type AddressRange = { bytes: Uint8Array; prefix: number };

export type ClientAddress = {
  /** The resolved client address, or the direct peer when nothing is trusted. */
  address: string | null;
  /** The socket peer as seen by this process. */
  peer: string | null;
  /** True when the address came from a trusted forwarded header. */
  forwarded: boolean;
  /** Scheme reported by a trusted proxy (`X-Forwarded-Proto`), if any. */
  forwardedProto: string | null;
};

function parseIPv4(value: string): Uint8Array | null {
  if (!isIPv4(value)) return null;
  return Uint8Array.from(value.split(".").map((part) => Number(part)));
}

function parseIPv6(value: string): Uint8Array | null {
  if (!isIPv6(value)) return null;
  let text = value;
  let tail: Uint8Array | null = null;
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    tail = parseIPv4(text.slice(lastColon + 1));
    if (!tail) return null;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const headGroups = head ? head.split(":") : [];
  const restGroups = rest ? rest.split(":") : [];
  const missing =
    rest === undefined ? 0 : 8 - headGroups.length - restGroups.length;
  const groups = [
    ...headGroups,
    ...Array.from({ length: missing }, () => "0"),
    ...restGroups,
  ];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const number = Number.parseInt(group || "0", 16);
    bytes[index * 2] = number >> 8;
    bytes[index * 2 + 1] = number & 0xff;
  });
  if (tail) bytes.set(tail, 12);
  return bytes;
}

function isMappedIPv4(bytes: Uint8Array): boolean {
  if (bytes.length !== 16) return false;
  for (let index = 0; index < 10; index += 1)
    if (bytes[index] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/** Address bytes; IPv4-mapped IPv6 addresses become plain IPv4. */
export function addressBytes(value: string): Uint8Array | null {
  const v4 = parseIPv4(value);
  if (v4) return v4;
  const v6 = parseIPv6(value);
  if (!v6) return null;
  return isMappedIPv4(v6) ? v6.slice(12) : v6;
}

function formatBytes(bytes: Uint8Array): string {
  if (bytes.length === 4) return Array.from(bytes).join(".");
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
  }
  // Compress the longest run of zero groups, as in RFC 5952.
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < 8; ) {
    if (groups[start] !== "0") {
      start += 1;
      continue;
    }
    let end = start;
    while (end < 8 && groups[end] === "0") end += 1;
    if (end - start > bestLength && end - start > 1) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  if (bestStart < 0) return groups.join(":");
  return `${groups.slice(0, bestStart).join(":")}::${groups
    .slice(bestStart + bestLength)
    .join(":")}`;
}

/**
 * Canonical form of one address token: strips brackets, ports and IPv6 zone
 * ids, and unwraps IPv4-mapped IPv6. Returns null for anything else.
 */
export function normalizeAddress(value: string | null | undefined) {
  let text = (value ?? "").trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) return null;
    text = text.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(text)) {
    text = text.slice(0, text.lastIndexOf(":"));
  }
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const bytes = addressBytes(text.toLowerCase());
  return bytes ? formatBytes(bytes) : null;
}

export function parseAddressRange(value: string): AddressRange | null {
  const [address, prefixText, ...extra] = value.trim().split("/");
  if (extra.length > 0 || !address) return null;
  const normalized = normalizeAddress(address);
  const bytes = normalized ? addressBytes(normalized) : null;
  if (!bytes) return null;
  const maxPrefix = bytes.length * 8;
  const prefix =
    prefixText === undefined ? maxPrefix : Number.parseInt(prefixText, 10);
  if (
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > maxPrefix ||
    (prefixText !== undefined && !/^\d+$/.test(prefixText))
  ) {
    return null;
  }
  return { bytes, prefix };
}

export function addressInRange(address: string, range: AddressRange) {
  const bytes = addressBytes(address);
  if (!bytes || bytes.length !== range.bytes.length) return false;
  let remaining = range.prefix;
  for (let index = 0; remaining > 0; index += 1) {
    const bits = Math.min(8, remaining);
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((bytes[index] & mask) !== (range.bytes[index] & mask)) return false;
    remaining -= bits;
  }
  return true;
}

const LOOPBACK_RANGES = ["127.0.0.0/8", "::1/128"].map(
  (range) => parseAddressRange(range) as AddressRange,
);

export function isLoopbackAddress(address: string): boolean {
  return LOOPBACK_RANGES.some((range) => addressInRange(address, range));
}

export type TrustedProxies = {
  ranges: AddressRange[];
  /** Tokens that were ignored because they are not addresses or ranges. */
  invalid: string[];
};

/**
 * `THYRA_TRUSTED_PROXIES`: comma- or space-separated addresses and CIDR
 * ranges, plus the keywords `loopback` and `none`. Unset means `loopback`;
 * an empty value trusts no proxy.
 */
export function parseTrustedProxies(value: string | undefined): TrustedProxies {
  if (value === undefined) return { ranges: [...LOOPBACK_RANGES], invalid: [] };
  const ranges: AddressRange[] = [];
  const invalid: string[] = [];
  for (const token of value.split(/[\s,]+/).filter(Boolean)) {
    const keyword = token.toLowerCase();
    if (keyword === "none") continue;
    if (keyword === "loopback") {
      ranges.push(...LOOPBACK_RANGES);
      continue;
    }
    const range = parseAddressRange(token);
    if (range) ranges.push(range);
    else invalid.push(token);
  }
  return { ranges, invalid };
}

function isTrusted(address: string, trusted: TrustedProxies) {
  return trusted.ranges.some((range) => addressInRange(address, range));
}

/**
 * Resolve the client address of a request. `X-Forwarded-For` is walked from
 * the right, skipping trusted proxies, so a client-supplied prefix cannot
 * be chosen; `X-Real-IP` is used only when there is no `X-Forwarded-For`.
 */
export function resolveClientAddress(args: {
  peer: string | null | undefined;
  headers: Headers;
  trusted: TrustedProxies;
}): ClientAddress {
  const peer = normalizeAddress(args.peer);
  const direct: ClientAddress = {
    address: peer,
    peer,
    forwarded: false,
    forwardedProto: null,
  };
  if (!peer || !isTrusted(peer, args.trusted)) return direct;
  const forwardedProto =
    args.headers
      .get("x-forwarded-proto")
      ?.split(",")[0]
      ?.trim()
      .toLowerCase() || null;
  const forwardedFor = args.headers.get("x-forwarded-for");
  let address: string | null = null;
  if (forwardedFor) {
    const hops = forwardedFor.split(",");
    let lastTrusted = peer;
    for (let index = hops.length - 1; index >= 0; index -= 1) {
      const hop = normalizeAddress(hops[index]);
      // A malformed hop ends the trusted chain; keep the last trusted proxy.
      if (!hop) {
        address = lastTrusted;
        break;
      }
      if (!isTrusted(hop, args.trusted)) {
        address = hop;
        break;
      }
      lastTrusted = hop;
      // Every hop was a trusted proxy: the leftmost is the client.
      if (index === 0) address = hop;
    }
  } else {
    address = normalizeAddress(args.headers.get("x-real-ip"));
  }
  if (!address) return { ...direct, forwardedProto };
  return {
    address,
    peer,
    forwarded: address !== peer,
    forwardedProto,
  };
}
