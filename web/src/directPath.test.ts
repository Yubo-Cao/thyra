import { expect, test } from "bun:test";
import type { BridgePrincipal } from "./api";
import { directPathTarget } from "./directPath";

const TAILNET = "https://dev.example";
const PUBLIC = { origin: "https://thyra.example", search: "" };
const account: BridgePrincipal = {
  kind: "user",
  role: "admin",
  user: { id: "u1", name: "owner", display_name: "Owner", role: "admin" },
};

test("a signed-in page on the public origin probes the tailnet origin", () => {
  const hello = { direct_origin: TAILNET, principal: account };
  expect(directPathTarget(hello, PUBLIC, false)).toBe(TAILNET);
  expect(
    directPathTarget(hello, { ...PUBLIC, search: "?direct=1" }, false),
  ).toBe(TAILNET);
});

test("stays put without an offer, after an opt-out, or for guests", () => {
  expect(directPathTarget({ principal: account }, PUBLIC, false)).toBeNull();
  const hello = { direct_origin: TAILNET, principal: account };
  expect(directPathTarget(hello, PUBLIC, true)).toBeNull();
  expect(
    directPathTarget(hello, { ...PUBLIC, search: "?a=1&direct=0" }, false),
  ).toBeNull();
  // Already there.
  expect(
    directPathTarget(hello, { origin: TAILNET, search: "" }, false),
  ).toBeNull();
  const guest: BridgePrincipal = { kind: "guest", role: "guest", user: null };
  expect(
    directPathTarget(
      { direct_origin: TAILNET, principal: guest },
      PUBLIC,
      false,
    ),
  ).toBeNull();
  expect(
    directPathTarget({ direct_origin: TAILNET }, PUBLIC, false),
  ).toBeNull();
});
