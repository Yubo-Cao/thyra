import { describe, expect, test } from "bun:test";
import {
  isLoopbackAddress,
  normalizeAddress,
  parseTrustedProxies,
  resolveClientAddress,
} from "./client-address";

const loopbackOnly = parseTrustedProxies(undefined);

function resolve(
  peer: string,
  headers: Record<string, string>,
  trusted = loopbackOnly,
) {
  return resolveClientAddress({ peer, headers: new Headers(headers), trusted });
}

describe("client address normalization", () => {
  test("strips ports, brackets and zones and unwraps mapped IPv4", () => {
    expect(normalizeAddress("100.85.156.15")).toBe("100.85.156.15");
    expect(normalizeAddress("100.85.156.15:4431")).toBe("100.85.156.15");
    expect(normalizeAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeAddress("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(normalizeAddress("[FD7A:115C:A1E0::1]:8080")).toBe(
      "fd7a:115c:a1e0::1",
    );
    expect(normalizeAddress("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizeAddress("unknown")).toBeNull();
    expect(normalizeAddress("")).toBeNull();
  });

  test("detects loopback in both families", () => {
    expect(isLoopbackAddress("127.3.4.5")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("100.85.156.15")).toBe(false);
  });
});

describe("forwarded header trust", () => {
  test("honors X-Forwarded-For from a loopback proxy", () => {
    expect(
      resolve("127.0.0.1", {
        "x-forwarded-for": "100.85.156.15",
        "x-forwarded-proto": "https",
      }),
    ).toEqual({
      address: "100.85.156.15",
      peer: "127.0.0.1",
      forwarded: true,
      forwardedProto: "https",
    });
    expect(resolve("::1", { "x-real-ip": "100.85.156.15" }).address).toBe(
      "100.85.156.15",
    );
  });

  test("ignores forwarded headers from a peer that is not a trusted proxy", () => {
    const result = resolve("192.0.2.10", {
      "x-forwarded-for": "100.85.156.15",
      "x-real-ip": "100.85.156.15",
      "x-forwarded-proto": "https",
    });
    expect(result).toEqual({
      address: "192.0.2.10",
      peer: "192.0.2.10",
      forwarded: false,
      forwardedProto: null,
    });
  });

  test("walks the chain from the right so a client cannot pick its address", () => {
    // The client sent "X-Forwarded-For: 100.64.0.9"; the proxy appended the
    // real peer. Only the rightmost untrusted hop is believed.
    expect(
      resolve("127.0.0.1", { "x-forwarded-for": "100.64.0.9, 198.51.100.7" })
        .address,
    ).toBe("198.51.100.7");
    const twoProxies = parseTrustedProxies("loopback, 10.0.0.0/8");
    expect(
      resolve(
        "127.0.0.1",
        { "x-forwarded-for": "100.64.0.9, 100.85.156.15, 10.1.2.3" },
        twoProxies,
      ).address,
    ).toBe("100.85.156.15");
  });

  test("stops at a malformed hop and uses the last trusted proxy", () => {
    expect(
      resolve("127.0.0.1", { "x-forwarded-for": "100.85.156.15, garbage" })
        .address,
    ).toBe("127.0.0.1");
  });

  test("an empty trust list disables forwarded headers entirely", () => {
    expect(
      resolve(
        "127.0.0.1",
        { "x-forwarded-for": "100.85.156.15" },
        parseTrustedProxies(""),
      ).address,
    ).toBe("127.0.0.1");
    expect(parseTrustedProxies("none").ranges).toEqual([]);
  });

  test("reports invalid trusted proxy entries", () => {
    const parsed = parseTrustedProxies("10.0.0.0/8, nope, 10.0.0.0/33, ::1");
    expect(parsed.invalid).toEqual(["nope", "10.0.0.0/33"]);
    expect(parsed.ranges).toHaveLength(2);
  });
});
