import { describe, expect, test } from "bun:test";
import { addDomains, normalizeDomain, sameDomains } from "./signupDomains";

describe("sign-up domains", () => {
  test("normalizes case, a leading address part and a trailing dot", () => {
    expect(normalizeDomain(" Example.COM ")).toBe("example.com");
    expect(normalizeDomain("@corp.example.org")).toBe("corp.example.org");
    expect(normalizeDomain("ada@lab.example.")).toBe("lab.example");
    expect(normalizeDomain("xn--fiqs8s.cn")).toBe("xn--fiqs8s.cn");
  });

  test("rejects what is not a domain", () => {
    for (const input of ["", "localhost", "-a.com", "a..com", "a b.com", "a.1"])
      expect(normalizeDomain(input)).toBeNull();
  });

  test("adds a pasted list once each and reports invalid entries", () => {
    expect(
      addDomains(["example.com"], "Example.com, b.org;\nnot_a_domain  c.io"),
    ).toEqual({
      domains: ["example.com", "b.org", "c.io"],
      invalid: ["not_a_domain"],
    });
    expect(addDomains([], "  ")).toEqual({ domains: [], invalid: [] });
  });

  test("compares lists ignoring order", () => {
    expect(sameDomains(["a.com", "b.com"], ["b.com", "a.com"])).toBe(true);
    expect(sameDomains(["a.com"], ["a.com", "b.com"])).toBe(false);
    expect(sameDomains(["a.com"], ["b.com"])).toBe(false);
  });
});
