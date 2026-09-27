import { describe, expect, test } from "bun:test";

import { parseTrustedProxies } from "../identity/client-address";
import {
  loadPublicListenerConfig,
  parseListenAddress,
  primaryListenerKind,
} from "./listener";
import { createRequestAccessPolicy } from "./request-access";

describe("listener kinds", () => {
  test("the primary listener is tailnet only with tailnet login on", () => {
    expect(primaryListenerKind("admin")).toBe("tailnet");
    expect(primaryListenerKind("off")).toBe("local");
  });
});

describe("THYRA_PUBLIC_LISTEN", () => {
  test.each([
    ["127.0.0.1:8788", { hostname: "127.0.0.1", port: 8788 }],
    ["[::1]:8788", { hostname: "::1", port: 8788 }],
    ["localhost:0", { hostname: "localhost", port: 0 }],
    ["8788", { hostname: "127.0.0.1", port: 8788 }],
    ["example.com:8788", null],
    ["127.0.0.1", null],
    ["127.0.0.1:99999", null],
    ["http://127.0.0.1:8788", null],
  ] as const)("%s", (value, expected) => {
    expect(parseListenAddress(value)).toEqual(expected);
  });

  const base = {
    listen: "127.0.0.1:8788",
    origin: "https://thyra.example",
    trustedProxies: undefined,
    primaryOrigins: ["https://dev.example"],
    primary: { hostname: "127.0.0.1", port: 8787 },
  };

  test("unset disables the public listener", () => {
    expect(loadPublicListenerConfig({ ...base, listen: undefined })).toBeNull();
    expect(loadPublicListenerConfig({ ...base, listen: " " })).toBeNull();
  });

  test("defaults to trusting only a loopback cloudflared", () => {
    const config = loadPublicListenerConfig(base);
    expect(config).toMatchObject({
      hostname: "127.0.0.1",
      port: 8788,
      origin: "https://thyra.example",
      warnings: [],
    });
    expect(config?.trustedProxies).toEqual(parseTrustedProxies("loopback"));
  });

  test.each([
    ["missing origin", { origin: undefined }, /THYRA_PUBLIC_ORIGIN/],
    ["plain HTTP origin", { origin: "http://thyra.example" }, /HTTPS/],
    ["origin with a path", { origin: "https://thyra.example/app" }, /HTTPS/],
    ["IP-literal origin", { origin: "https://203.0.113.5" }, /HTTPS/],
    ["bad address", { listen: "thyra.example:8788" }, /host:port/],
    [
      "origin shared with the primary listener",
      { primaryOrigins: ["https://thyra.example"] },
      /must not also be in THYRA_PUBLIC_BASE_URL/,
    ],
    ["same port as the primary", { listen: "127.0.0.1:8787" }, /differ/],
  ] as const)("refuses %s", (_name, overrides, message) => {
    expect(() => loadPublicListenerConfig({ ...base, ...overrides })).toThrow(
      message,
    );
  });

  test("warns about a non-loopback bind and invalid proxies", () => {
    const config = loadPublicListenerConfig({
      ...base,
      listen: "0.0.0.0:8788",
      trustedProxies: "loopback,nonsense",
    });
    expect(config?.warnings).toHaveLength(2);
  });
});

describe("public listener request access", () => {
  const policy = createRequestAccessPolicy({
    listenerKind: "public",
    port: 8788,
    tls: false,
    bindHost: "127.0.0.1",
    publicOrigins: ["https://thyra.example"],
    trustedProxies: parseTrustedProxies("loopback"),
  });
  const request = (headers: Record<string, string>, path = "/") =>
    new Request(`http://127.0.0.1:8788${path}`, { headers });

  test("a cloudflared request is HTTPS, never local, and keyed by CF-Connecting-IP", () => {
    const access = policy.evaluate(
      request({
        host: "thyra.example",
        "cf-connecting-ip": "203.0.113.5",
        "x-forwarded-for": "198.51.100.1, 203.0.113.5",
        "x-forwarded-proto": "http",
      }),
      "127.0.0.1",
    );
    expect(access).toMatchObject({
      listener: "public",
      hostAllowed: true,
      ownOrigin: "https://thyra.example",
      proxied: true,
      local: false,
      secure: true,
      clientAddress: "203.0.113.5",
    });
  });

  test("CF-Connecting-IP is believed only from a trusted cloudflared", () => {
    const headers = {
      host: "thyra.example",
      "cf-connecting-ip": "203.0.113.5",
    };
    expect(
      policy.evaluate(request(headers), "198.51.100.7").clientAddress,
    ).toBe("198.51.100.7");
  });

  test.each([
    ["loopback", "127.0.0.1"],
    ["tailnet", "100.64.7.7"],
    ["tailnet IPv6", "fd7a:115c:a1e0::7"],
    ["garbage", "not-an-ip"],
  ])("a %s CF-Connecting-IP falls back to the peer", (_name, value) => {
    const access = policy.evaluate(
      request({ host: "thyra.example", "cf-connecting-ip": value }),
      "127.0.0.1",
    );
    expect(access.clientAddress).toBe("127.0.0.1");
  });

  test("X-Forwarded-For and X-Real-IP never set the client address", () => {
    const access = policy.evaluate(
      request({
        host: "thyra.example",
        "x-forwarded-for": "100.64.7.7",
        "x-real-ip": "100.64.7.7",
      }),
      "127.0.0.1",
    );
    expect(access.clientAddress).toBe("127.0.0.1");
  });

  test.each([
    ["loopback name", { host: "localhost:8788" }],
    ["loopback IP", { host: "127.0.0.1:8788" }],
    ["tailnet IP", { host: "100.64.0.1" }],
    ["primary DNS name", { host: "dev.example" }],
    ["other port", { host: "thyra.example:8443" }],
    [
      "forwarded host",
      { host: "evil.example", "x-forwarded-host": "thyra.example" },
    ],
    ["no host", {}],
  ])("only the public host is served (%s refused)", (_name, headers) => {
    const access = policy.evaluate(
      request(headers as Record<string, string>),
      "127.0.0.1",
    );
    expect(access.hostAllowed).toBe(false);
    expect(access.local).toBe(false);
  });

  test.each([
    ["public origin", "https://thyra.example", true],
    ["plain HTTP public origin", "http://thyra.example", false],
    ["primary origin", "https://dev.example", false],
    ["loopback origin", "http://127.0.0.1:8788", false],
    ["localhost origin", "http://localhost:8788", false],
    ["null", "null", false],
  ])("Origin %s allowed=%p", (_name, origin, allowed) => {
    const req = request({ host: "thyra.example", origin }, "/ws");
    const access = policy.evaluate(req, "127.0.0.1");
    expect(policy.checkOrigin(req, access, true).ok).toBe(allowed);
  });

  test("a direct loopback request without Origin is not local here", () => {
    const req = request({ host: "thyra.example" }, "/ws");
    const access = policy.evaluate(req, "127.0.0.1");
    expect(access.local).toBe(false);
    expect(policy.checkOrigin(req, access, true)).toEqual({
      ok: false,
      reason: "origin required",
    });
  });

  test("the public policy requires exactly one HTTPS origin", () => {
    const options = {
      listenerKind: "public" as const,
      port: 8788,
      tls: false,
      bindHost: "127.0.0.1",
      trustedProxies: parseTrustedProxies("loopback"),
    };
    expect(() =>
      createRequestAccessPolicy({ ...options, publicOrigins: [] }),
    ).toThrow();
    expect(() =>
      createRequestAccessPolicy({
        ...options,
        publicOrigins: ["https://a.example", "https://b.example"],
      }),
    ).toThrow();
    expect(() =>
      createRequestAccessPolicy({
        ...options,
        publicOrigins: ["http://a.example"],
      }),
    ).toThrow();
  });
});

describe("private listeners reject the public host", () => {
  test("the tailnet listener answers the public DNS name with 421", () => {
    const policy = createRequestAccessPolicy({
      listenerKind: "tailnet",
      port: 8787,
      tls: false,
      bindHost: "127.0.0.1",
      publicOrigins: ["https://dev.example"],
      trustedProxies: parseTrustedProxies(undefined),
    });
    const access = policy.evaluate(
      new Request("http://127.0.0.1:8787/", {
        headers: {
          host: "thyra.example",
          "cf-connecting-ip": "203.0.113.5",
        },
      }),
      "127.0.0.1",
    );
    expect(access.hostAllowed).toBe(false);
    expect(access.cloudflare).toBe(true);
  });
});
