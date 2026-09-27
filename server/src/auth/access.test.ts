import { expect, test } from "bun:test";
import { openAccountDatabase } from "../accounts/database";
import { createAccountStore } from "../accounts/store";
import { guest } from "../authz/test-principals";
import { createAccessControl } from "./access";

test("share-link guests view one workspace and never receive Web Push", () => {
  const store = createAccountStore(openAccountDatabase(":memory:"));
  const access = createAccessControl(store);
  const workspaceGuest = guest("demo");
  expect(access.roleOn(workspaceGuest, "c1", "w1")).toBe("viewer");
  expect(access.roleOn(workspaceGuest, "c1", "w2")).toBeNull();
  expect(access.roleOn(workspaceGuest, "c2", "w1")).toBeNull();
  expect([...access.connectionsOf(workspaceGuest)]).toEqual(["c1"]);
  expect(access.editsConnection(workspaceGuest, null)).toBe(false);
  expect(access.editsConnection(workspaceGuest, "c1")).toBe(false);
  // Push subscriptions belong to accounts (or the host owner); a guest key,
  // or any other owner the bridge does not know, sees nothing.
  expect(access.subscriberSees(workspaceGuest.key, "c1", "w1")).toBe(false);
  expect(access.subscriberSees("guest:anything", "c1", "w1")).toBe(false);
  expect(access.subscriberSees("local", "c1", "w1")).toBe(true);
});
