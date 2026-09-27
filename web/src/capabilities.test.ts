import { expect, test } from "bun:test";
import type { BridgePrincipal } from "./api";
import { workspaceCan } from "./capabilities";
import { isInstanceAdmin } from "./principal";
import { endpointCreationReason } from "./store/navigation";
import type { State } from "./store";

const principal = (capabilities: "host"[]): BridgePrincipal => ({
  kind: "user",
  role: "member",
  user: null,
  capabilities,
});

test("the interface offers what the bridge reports, not what a role implies", () => {
  expect(workspaceCan({ capabilities: ["edit"] }, "edit")).toBe(true);
  expect(workspaceCan({ capabilities: ["edit"] }, "manage")).toBe(false);
  // Viewers and guests get no capabilities; unknown workspaces offer none.
  expect(workspaceCan({ capabilities: [] }, "edit")).toBe(false);
  expect(workspaceCan(undefined, "edit")).toBe(false);
  expect(isInstanceAdmin(principal(["host"]))).toBe(true);
  expect(isInstanceAdmin(principal([]))).toBe(false);
});

test("viewers cannot create tabs; creation offers no write it would refuse", () => {
  const snapshot = {
    navigationMode: "shared",
    browserNavigation: { workspaceId: "w1", tabIds: {}, paneIds: {} },
    workspaces: [
      { workspace_id: "w1", capabilities: [] },
      { workspace_id: "w2", capabilities: ["edit"] },
    ],
  } as unknown as State;
  expect(endpointCreationReason(snapshot, "tab.create", "w1")).toBe(
    "View only",
  );
  expect(endpointCreationReason(snapshot, "tab.create", "w2")).toBeNull();
});
