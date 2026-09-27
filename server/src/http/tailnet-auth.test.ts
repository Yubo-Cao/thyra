import { describe, expect, test } from "bun:test";

import { parseTrustedProxies } from "../identity/client-address";
import { createTailscaleWhois, type WhoisBackend } from "../identity/tailscale";
import { createRequestAccessPolicy } from "./request-access";
import { parseTailnetAuthMode, tailnetLogin } from "./tailnet-auth";

const USER_NODE = {
  Node: { StableID: "n1", ComputedName: "iphone" },
  UserProfile: { LoginName: "owner@example.com" },
};
const TAGGED_NODE = {
  Node: { StableID: "n2", ComputedName: "ci", Tags: ["tag:ci"] },
  UserProfile: { LoginName: "tagged-devices" },
};

const backend: WhoisBackend = async (address) => {
  if (address === "100.64.7.7") return USER_NODE;
  if (address === "fd7a:115c:a1e0::7") return USER_NODE;
  if (address === "100.64.7.8") return TAGGED_NODE;
  if (address === "100.64.7.9") throw new Error("tailscaled unavailable");
  return null;
};

const policy = createRequestAccessPolicy({
  listenerKind: "tailnet",
  port: 8787,
  tls: false,
  bindHost: "127.0.0.1",
  publicOrigins: ["https://dev.example"],
  trustedProxies: parseTrustedProxies(undefined),
});

function proxied(forwardedFor: string) {
  return new Request("http://127.0.0.1:8787/", {
    headers: {
      host: "dev.example",
      "x-forwarded-for": forwardedFor,
      "x-forwarded-host": "dev.example",
      "x-forwarded-proto": "https",
    },
  });
}

async function login(
  request: Request,
  peer: string,
  mode: "admin" | "off" = "admin",
) {
  const whois = createTailscaleWhois({ backend });
  return tailnetLogin({
    mode,
    access: policy.evaluate(request, peer),
    lookupUser: async (address) => {
      const identity = await whois.lookup(address);
      return identity?.user ? { login: identity.user.login } : null;
    },
  });
}

describe("tailnet login", () => {
  test.each([
    ["tailnet IPv4 user via proxy", proxied("100.64.7.7"), "owner@example.com"],
    [
      "tailnet IPv6 user via proxy",
      proxied("fd7a:115c:a1e0::7"),
      "owner@example.com",
    ],
    [
      "client-supplied prefix is ignored (rightmost untrusted hop wins)",
      proxied("100.64.7.7, 203.0.113.5"),
      null,
    ],
    ["whois failure fails closed", proxied("100.64.7.9"), null],
    ["tagged node has no user", proxied("100.64.7.8"), null],
    ["unknown tailnet peer", proxied("100.64.7.10"), null],
    ["non-tailnet forwarded address", proxied("203.0.113.5"), null],
  ] as const)("%s", async (_name, request, expected) => {
    expect(await login(request, "127.0.0.1")).toBe(expected);
  });

  test("forwarded headers from an untrusted direct peer are ignored", async () => {
    expect(await login(proxied("100.64.7.7"), "100.64.7.9")).toBeNull();
    expect(await login(proxied("100.64.7.7"), "203.0.113.5")).toBeNull();
  });

  test("a direct tailnet peer without a proxy is not logged in", async () => {
    const request = new Request("http://100.90.0.1:8787/", {
      headers: { host: "100.90.0.1:8787" },
    });
    expect(await login(request, "100.64.7.7")).toBeNull();
  });

  test("direct loopback use stays local and does not use whois", async () => {
    const request = new Request("http://127.0.0.1:8787/", {
      headers: { host: "127.0.0.1:8787" },
    });
    expect(policy.evaluate(request, "127.0.0.1").local).toBe(true);
    expect(await login(request, "127.0.0.1")).toBeNull();
  });

  test("off disables it", async () => {
    expect(await login(proxied("100.64.7.7"), "127.0.0.1", "off")).toBeNull();
  });

  test("a request with Cloudflare edge headers never logs in", async () => {
    for (const header of ["cf-connecting-ip", "cf-ray", "cf-ipcountry"]) {
      const request = proxied("100.64.7.7");
      request.headers.set(header, "100.64.7.7");
      expect(await login(request, "127.0.0.1")).toBeNull();
    }
  });
});

describe("tailnet login is decided by the listener", () => {
  const whois = createTailscaleWhois({ backend });
  const lookupUser = async (address: string) => {
    const identity = await whois.lookup(address);
    return identity?.user ? { login: identity.user.login } : null;
  };
  const localPolicy = createRequestAccessPolicy({
    listenerKind: "local",
    port: 8787,
    tls: false,
    bindHost: "127.0.0.1",
    publicOrigins: ["https://dev.example"],
    trustedProxies: parseTrustedProxies(undefined),
  });
  const publicPolicy = createRequestAccessPolicy({
    listenerKind: "public",
    port: 8788,
    tls: false,
    bindHost: "127.0.0.1",
    publicOrigins: ["https://thyra.example"],
    trustedProxies: parseTrustedProxies("loopback"),
  });

  test("the local listener never runs tailnet login", async () => {
    expect(
      await tailnetLogin({
        mode: "admin",
        access: localPolicy.evaluate(proxied("100.64.7.7"), "127.0.0.1"),
        lookupUser,
      }),
    ).toBeNull();
  });

  // Every header a client or local process could use to claim a tailnet
  // address or Tailscale identity, alone and together.
  const SPOOFS: Record<string, string>[] = [
    { "x-forwarded-for": "100.64.7.7" },
    { "x-forwarded-for": "100.64.7.7, 127.0.0.1" },
    { "x-real-ip": "100.64.7.7" },
    { forwarded: "for=100.64.7.7;proto=https;host=dev.example" },
    { "cf-connecting-ip": "100.64.7.7" },
    { "cf-connecting-ip": "fd7a:115c:a1e0::7" },
    { "true-client-ip": "100.64.7.7" },
    {
      "tailscale-user-login": "owner@example.com",
      "tailscale-user-name": "Owner",
      "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
    },
    {
      "x-forwarded-for": "100.64.7.7",
      "x-forwarded-host": "dev.example",
      "x-forwarded-proto": "https",
      "cf-connecting-ip": "100.64.7.7",
      "tailscale-user-login": "owner@example.com",
    },
  ];

  test.each(
    SPOOFS.flatMap((headers) =>
      ["127.0.0.1", "::1", "100.64.7.7"].map(
        (peer) => [JSON.stringify(headers), peer, headers] as const,
      ),
    ),
  )("public listener ignores %s from %s", async (_name, peer, headers) => {
    const request = new Request("http://127.0.0.1:8788/", {
      headers: { host: "thyra.example", ...headers },
    });
    const access = publicPolicy.evaluate(request, peer);
    expect(access.listener).toBe("public");
    expect(access.local).toBe(false);
    // No header can supply a tailnet client address: it stays the peer.
    expect(access.clientAddress).toBe(peer);
    const lookups: string[] = [];
    expect(
      await tailnetLogin({
        mode: "admin",
        access,
        lookupUser: async (address) => {
          lookups.push(address);
          return lookupUser(address);
        },
      }),
    ).toBeNull();
    expect(lookups).toEqual([]);
  });

  test("even a direct tailnet peer is untrusted on the public listener", async () => {
    const request = new Request("http://100.64.0.1:8788/", {
      headers: { host: "thyra.example" },
    });
    const access = publicPolicy.evaluate(request, "100.64.7.7");
    expect(access.clientAddress).toBe("100.64.7.7");
    expect(
      await tailnetLogin({ mode: "admin", access, lookupUser }),
    ).toBeNull();
  });
});

describe("THYRA_TAILNET_AUTH", () => {
  test.each([
    [undefined, true, "admin", false],
    [undefined, false, "off", false],
    ["admin", true, "admin", false],
    ["ADMIN", true, "admin", false],
    ["admin", false, "off", true],
    ["off", true, "off", false],
    ["false", true, "off", false],
    ["yes", true, "off", true],
  ] as const)("%p with whois=%p is %s", (value, whois, mode, warns) => {
    const result = parseTailnetAuthMode(value, whois);
    expect(result.mode).toBe(mode);
    expect(Boolean(result.warning)).toBe(warns);
  });
});
