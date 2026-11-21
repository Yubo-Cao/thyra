import { expect, test } from "bun:test";
import { LOCAL_PRINCIPAL } from "../auth/principal";
import { createPreviewGrants } from "./preview-grants";

test("HTML asset grants follow the live session and cannot change their target scope", () => {
  let live = true;
  const grants = createPreviewGrants(() => live);
  const address = "127.0.0.1";
  const origin = "https://thyra.test";
  const raw = {
    generation: "2",
    workspaceId: "w1",
    scope: "filesystem" as const,
    path: "/tmp/fixture/index.html",
    grant: "-",
  };
  const token = grants.issue({
    raw,
    connectionId: "local",
    principal: LOCAL_PRINCIPAL,
    address,
    origin,
  });
  const sibling = {
    ...raw,
    grant: token,
    path: "/tmp/fixture/assets/style.css",
  };
  expect(
    grants.authenticate(sibling, "local", address, origin)?.principal,
  ).toEqual(LOCAL_PRINCIPAL);
  expect(
    grants.authenticate(
      { ...sibling, path: "/tmp/private.txt" },
      "local",
      address,
      origin,
    ),
  ).toBeNull();
  expect(
    grants.authenticate(
      { ...sibling, generation: "3" },
      "local",
      address,
      origin,
    ),
  ).toBeNull();
  expect(grants.authenticate(sibling, "local", "127.0.0.2", origin)).toBeNull();
  live = false;
  expect(grants.authenticate(sibling, "local", address, origin)).toBeNull();
});
