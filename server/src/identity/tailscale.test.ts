import { describe, expect, test } from "bun:test";
import {
  createTailscaleWhois,
  isTailnetAddress,
  parseTailscaleWhois,
  tailscaleCliWhois,
  tailscaleWhoisBackendFromEnv,
} from "./tailscale";

const IPAD_WHOIS = {
  Node: {
    ID: 5607852902871656,
    StableID: "nZZXqcnonk11CNTRL",
    Name: "ipad.tail104cf.ts.net.",
    Addresses: ["100.85.156.15/32"],
    Hostinfo: { OS: "iOS", Hostname: "localhost" },
    ComputedName: "ipad",
  },
  UserProfile: {
    ID: 68409751995295330,
    LoginName: "Yubo-Cao@github",
    DisplayName: "Yubo Cao",
    ProfilePicURL: "https://avatars.githubusercontent.com/u/79431291?v=4",
  },
};

describe("tailnet detection", () => {
  test("recognizes the CGNAT and ULA tailnet ranges only", () => {
    expect(isTailnetAddress("100.64.0.1")).toBe(true);
    expect(isTailnetAddress("100.85.156.15")).toBe(true);
    expect(isTailnetAddress("100.127.255.255")).toBe(true);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
    expect(isTailnetAddress("100.63.255.255")).toBe(false);
    expect(isTailnetAddress("fd7a:115c:a1e0::8d3a:9c0f")).toBe(true);
    expect(isTailnetAddress("fd7a:115c:a1e1::1")).toBe(false);
    expect(isTailnetAddress("192.168.1.2")).toBe(false);
    expect(isTailnetAddress(null)).toBe(false);
  });
});

describe("whois parsing", () => {
  test("prefers the computed node name over a useless host name", () => {
    expect(parseTailscaleWhois(IPAD_WHOIS)).toEqual({
      nodeId: "nZZXqcnonk11CNTRL",
      deviceName: "ipad",
      os: "iOS",
      user: {
        login: "Yubo-Cao@github",
        displayName: "Yubo Cao",
        avatarUrl: "https://avatars.githubusercontent.com/u/79431291?v=4",
      },
    });
  });

  test("falls back to the MagicDNS label, then a real host name", () => {
    expect(
      parseTailscaleWhois({
        Node: { ID: 7, Name: "liveopt.tail104cf.ts.net.", Hostinfo: {} },
      })?.deviceName,
    ).toBe("liveopt");
    expect(
      parseTailscaleWhois({ Node: { ID: 7, Hostinfo: { Hostname: "box" } } })
        ?.deviceName,
    ).toBe("box");
    expect(
      parseTailscaleWhois({
        Node: { ID: 7, Hostinfo: { Hostname: "localhost" } },
      })?.deviceName,
    ).toBe("");
  });

  test("tagged nodes have no person and non-HTTPS avatars are dropped", () => {
    expect(
      parseTailscaleWhois({
        Node: { StableID: "n1", ComputedName: "ci", Tags: ["tag:ci"] },
        UserProfile: { LoginName: "tagged-devices" },
      }),
    ).toEqual({ nodeId: "n1", deviceName: "ci" });
    expect(
      parseTailscaleWhois({
        Node: { StableID: "n2", ComputedName: "pc" },
        UserProfile: {
          LoginName: "a@example.com",
          ProfilePicURL: "http://example.com/a.png",
        },
      })?.user,
    ).toEqual({ login: "a@example.com" });
    expect(parseTailscaleWhois({})).toBeNull();
    expect(parseTailscaleWhois({ Node: {} })).toBeNull();
  });
});

describe("whois lookups", () => {
  test("caches per address, deduplicates concurrent lookups and expires", async () => {
    let clock = 1_000;
    const calls: string[] = [];
    const whois = createTailscaleWhois({
      backend: async (address) => {
        calls.push(address);
        return IPAD_WHOIS;
      },
      ttlMs: 60_000,
      now: () => clock,
    });
    const [first, second] = await Promise.all([
      whois.lookup("100.85.156.15"),
      whois.lookup("100.85.156.15"),
    ]);
    expect(first?.user?.login).toBe("Yubo-Cao@github");
    expect(second).toBe(first);
    await whois.lookup("100.85.156.15");
    expect(calls).toEqual(["100.85.156.15"]);
    clock += 60_001;
    await whois.lookup("100.85.156.15");
    expect(calls).toHaveLength(2);
  });

  test("never queries non-tailnet addresses", async () => {
    const calls: string[] = [];
    const whois = createTailscaleWhois({
      backend: async (address) => {
        calls.push(address);
        return IPAD_WHOIS;
      },
    });
    expect(await whois.lookup("198.51.100.7")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("fails soft on errors and timeouts, with a short negative cache", async () => {
    let clock = 0;
    let calls = 0;
    const whois = createTailscaleWhois({
      backend: () => {
        calls += 1;
        return new Promise(() => {});
      },
      timeoutMs: 5,
      negativeTtlMs: 1_000,
      now: () => clock,
    });
    expect(await whois.lookup("100.85.156.15")).toBeNull();
    expect(await whois.lookup("100.85.156.15")).toBeNull();
    expect(calls).toBe(1);
    clock += 1_001;
    const failing = createTailscaleWhois({
      backend: async () => {
        throw new Error("tailscaled not running");
      },
    });
    expect(await failing.lookup("100.85.156.15")).toBeNull();
  });

  test("the CLI backend runs whois --json and treats a non-zero exit as unknown", async () => {
    const argv: string[][] = [];
    const backend = tailscaleCliWhois("/opt/tailscale", async (args) => {
      argv.push(args);
      return args[3] === "100.85.156.15"
        ? { code: 0, stdout: JSON.stringify(IPAD_WHOIS), stderr: "" }
        : { code: 1, stdout: "", stderr: "no match for IP" };
    });
    expect(
      parseTailscaleWhois(await backend("100.85.156.15", 100)),
    ).not.toBeNull();
    expect(await backend("100.64.0.2", 100)).toBeNull();
    expect(argv[0]).toEqual([
      "/opt/tailscale",
      "whois",
      "--json",
      "100.85.156.15",
    ]);
  });

  test("backend selection honors overrides and the off switch", () => {
    const none = { exists: () => false, which: () => null, platform: "linux" };
    expect(tailscaleWhoisBackendFromEnv({}, none)).toBeNull();
    expect(
      tailscaleWhoisBackendFromEnv(
        { THYRA_TAILSCALE_IDENTITY: "off" },
        {
          ...none,
          which: () => "/usr/bin/tailscale",
        },
      ),
    ).toBeNull();
    expect(
      tailscaleWhoisBackendFromEnv({ THYRA_TAILSCALE_CLI: "/tmp/fake" }, none)
        ?.description,
    ).toBe("/tmp/fake");
    expect(
      tailscaleWhoisBackendFromEnv(
        {},
        {
          ...none,
          exists: (path) => path === "/run/tailscale/tailscaled.sock",
          which: () => "/usr/bin/tailscale",
        },
      )?.description,
    ).toBe("/run/tailscale/tailscaled.sock");
    expect(
      tailscaleWhoisBackendFromEnv(
        {},
        {
          ...none,
          which: () => "/usr/bin/tailscale",
        },
      )?.description,
    ).toBe("/usr/bin/tailscale");
  });
});
