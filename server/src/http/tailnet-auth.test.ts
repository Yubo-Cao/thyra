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
