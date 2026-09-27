import { describe, expect, test } from "bun:test";

import { parseTrustedProxies } from "../identity/client-address";
import {
  createRequestAccessPolicy,
  originCheckMode,
  parsePublicBaseUrls,
} from "./request-access";

const PORT = 8787;

function policy(
  overrides: {
    publicBaseUrl?: string;
    bindHost?: string;
    tls?: boolean;
    trustedProxies?: string;
  } = {},
) {
  return createRequestAccessPolicy({
    listenerKind: "tailnet",
    port: PORT,
    tls: overrides.tls ?? false,
    bindHost: overrides.bindHost ?? "127.0.0.1",
    publicOrigins: parsePublicBaseUrls(overrides.publicBaseUrl).origins,
    trustedProxies: parseTrustedProxies(overrides.trustedProxies),
  });
}

const CADDY = {
  "x-forwarded-for": "100.101.102.103",
  "x-forwarded-host": "dev.example",
  "x-forwarded-proto": "https",
};

type Case = {
  name: string;
  peer: string;
  headers: Record<string, string>;
  path?: string;
  method?: string;
  publicBaseUrl?: string;
  bindHost?: string;
  trustedProxies?: string;
  expect: {
    hostAllowed: boolean;
    local?: boolean;
    proxied?: boolean;
    /** Origin decision for the request's check mode; omitted when host fails. */
    allowed?: boolean;
  };
};

const cases: Case[] = [
  {
    name: "direct loopback page connecting its own WebSocket",
    peer: "127.0.0.1",
    headers: { host: "localhost:8787", origin: "http://localhost:8787" },
    path: "/ws",
    expect: { hostAllowed: true, local: true, proxied: false, allowed: true },
  },
  {
    name: "direct loopback CLI without Origin",
    peer: "127.0.0.1",
    headers: { host: "127.0.0.1:8787" },
    path: "/ws",
    expect: { hostAllowed: true, local: true, allowed: true },
  },
  {
    name: "foreign local origin (another port) opening the WebSocket",
    peer: "127.0.0.1",
    headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:9000" },
    path: "/ws",
    expect: { hostAllowed: true, local: false, allowed: false },
  },
  {
    name: "foreign site POSTing to the API",
    peer: "127.0.0.1",
    headers: { host: "localhost:8787", origin: "https://evil.example" },
    path: "/api/logout",
    method: "POST",
    expect: { hostAllowed: true, local: false, allowed: false },
  },
  {
    name: "opaque null Origin",
    peer: "127.0.0.1",
    headers: { host: "localhost:8787", origin: "null" },
    path: "/ws",
    expect: { hostAllowed: true, local: false, allowed: false },
  },
  {
    name: "DNS rebinding Host",
    peer: "127.0.0.1",
    headers: {
      host: "attacker.example:8787",
      origin: "http://attacker.example:8787",
    },
    path: "/ws",
    expect: { hostAllowed: false },
  },
  {
    name: "DNS rebinding Host on a plain page load",
    peer: "127.0.0.1",
    headers: { host: "attacker.example" },
    path: "/",
    method: "GET",
    expect: { hostAllowed: false },
  },
  {
    name: "Caddy-proxied same-origin WebSocket",
    peer: "127.0.0.1",
    headers: { host: "dev.example", origin: "https://dev.example", ...CADDY },
    path: "/ws",
    publicBaseUrl: "https://dev.example",
    expect: { hostAllowed: true, local: false, proxied: true, allowed: true },
  },
  {
    name: "Caddy-proxied WebSocket from a foreign origin",
    peer: "127.0.0.1",
    headers: {
      host: "dev.example",
      origin: "https://evil.example",
      ...CADDY,
    },
    path: "/ws",
    publicBaseUrl: "https://dev.example",
    expect: { hostAllowed: true, local: false, allowed: false },
  },
  {
    name: "proxied WebSocket without Origin",
    peer: "127.0.0.1",
    headers: { host: "dev.example", ...CADDY },
    path: "/ws",
    publicBaseUrl: "https://dev.example",
    expect: { hostAllowed: true, local: false, allowed: false },
  },
  {
    name: "proxied request for a host that is not configured",
    peer: "127.0.0.1",
    headers: { host: "dev.example", origin: "https://dev.example", ...CADDY },
    path: "/ws",
    expect: { hostAllowed: false },
  },
  {
    name: "proxy rewriting Host to the upstream still uses X-Forwarded-Host",
    peer: "127.0.0.1",
    headers: {
      host: "127.0.0.1:8787",
      origin: "https://dev.example",
      ...CADDY,
    },
    path: "/api/file/upload",
    method: "POST",
    publicBaseUrl: "https://dev.example",
    expect: { hostAllowed: true, local: false, proxied: true, allowed: true },
  },
  {
    name: "forwarding headers from an untrusted loopback proxy are not local",
    peer: "127.0.0.1",
    headers: {
      host: "localhost:8787",
      origin: "http://localhost:8787",
      "x-forwarded-for": "100.64.0.9",
    },
    path: "/ws",
    trustedProxies: "none",
    expect: { hostAllowed: true, local: false, proxied: false, allowed: true },
  },
  {
    name: "untrusted peer cannot choose X-Forwarded-Host",
    peer: "100.64.0.9",
    headers: {
      host: "attacker.example",
      origin: "https://dev.example",
      "x-forwarded-host": "dev.example",
      "x-forwarded-proto": "https",
    },
    path: "/ws",
    publicBaseUrl: "https://dev.example",
    bindHost: "0.0.0.0",
    expect: { hostAllowed: false },
  },
  {
    name: "LAN page on an IP literal (no rebinding possible)",
    peer: "192.168.1.20",
    headers: { host: "192.168.1.5:8787", origin: "http://192.168.1.5:8787" },
    path: "/ws",
    bindHost: "0.0.0.0",
    expect: { hostAllowed: true, local: false, allowed: true },
  },
  {
    name: "remote peer addressing a loopback name is not local",
    peer: "192.168.1.20",
    headers: { host: "localhost:8787" },
    path: "/ws",
    bindHost: "0.0.0.0",
    expect: { hostAllowed: true, local: false, allowed: false },
  },
  {
    name: "second public base URL",
    peer: "127.0.0.1",
    headers: {
      ...CADDY,
      host: "b.example",
      origin: "https://b.example",
      "x-forwarded-host": "b.example",
    },
    path: "/ws",
    publicBaseUrl: "https://a.example, https://b.example",
    expect: { hostAllowed: true, allowed: true },
  },
  {
    name: "same-site cross-origin API read",
    peer: "127.0.0.1",
    headers: {
      host: "dev.example",
      "sec-fetch-site": "same-site",
      ...CADDY,
    },
    path: "/api/file/download",
    method: "GET",
    publicBaseUrl: "https://dev.example",
    expect: { hostAllowed: true, allowed: false },
  },
  {
    name: "same-origin API read without Origin",
    peer: "127.0.0.1",
    headers: {
      host: "dev.example",
      "sec-fetch-site": "same-origin",
      ...CADDY,
    },
    path: "/api/health",
    method: "GET",
    publicBaseUrl: "https://dev.example",
    expect: { hostAllowed: true, allowed: true },
  },
  {
    name: "cross-site navigation to the app still loads it",
    peer: "127.0.0.1",
    headers: {
      host: "dev.example",
      "sec-fetch-site": "cross-site",
      ...CADDY,
    },
    path: "/",
    method: "GET",
    publicBaseUrl: "https://dev.example",
    expect: { hostAllowed: true, allowed: true },
  },
];

describe("request access decisions", () => {
  test.each(cases)("$name", (entry) => {
    const access = policy({
      publicBaseUrl: entry.publicBaseUrl,
      bindHost: entry.bindHost,
      trustedProxies: entry.trustedProxies,
    });
    const request = new Request(
      `http://127.0.0.1:${PORT}${entry.path ?? "/"}`,
      {
        method: entry.method ?? "GET",
        headers: entry.headers,
      },
    );
    const result = access.evaluate(request, entry.peer);
    expect(result.hostAllowed).toBe(entry.expect.hostAllowed);
    if (entry.expect.local !== undefined)
      expect(result.local).toBe(entry.expect.local);
    if (entry.expect.proxied !== undefined)
      expect(result.proxied).toBe(entry.expect.proxied);
    if (entry.expect.allowed === undefined) return;
    const mode = originCheckMode(new URL(request.url).pathname, request.method);
    const decision =
      mode === "none"
        ? { ok: true }
        : access.checkOrigin(request, result, mode === "strict");
    expect(decision.ok).toBe(entry.expect.allowed);
  });

  test("a Caddy-proxied request is HTTPS and keyed by the forwarded client", () => {
    const result = policy({ publicBaseUrl: "https://dev.example" }).evaluate(
      new Request("http://127.0.0.1:8787/api/login", {
        method: "POST",
        headers: { host: "dev.example", ...CADDY },
      }),
      "127.0.0.1",
    );
    expect(result.secure).toBe(true);
    expect(result.ownOrigin).toBe("https://dev.example");
    expect(result.clientAddress).toBe("100.101.102.103");
  });
});

describe("originCheckMode", () => {
  test.each([
    ["/ws", "GET", "strict"],
    ["/api/login", "POST", "strict"],
    ["/anything", "DELETE", "strict"],
    ["/api/health", "GET", "read"],
    ["/api/connections/default/file/download", "HEAD", "read"],
    ["/mcp", "POST", "read"],
    ["/", "GET", "none"],
    ["/assets/index.js", "GET", "none"],
  ] as const)("%s %s is %s", (path, method, mode) => {
    expect(originCheckMode(path, method)).toBe(mode);
  });
});

describe("parsePublicBaseUrls", () => {
  test("normalizes origins and reports invalid entries", () => {
    expect(
      parsePublicBaseUrls(
        "https://Dev.Example/, http://host:8080/path ftp://x.example nope",
      ),
    ).toEqual({
      origins: ["https://dev.example", "http://host:8080"],
      invalid: ["ftp://x.example", "nope"],
    });
  });
});
