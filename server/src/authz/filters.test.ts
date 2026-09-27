import { describe, expect, test } from "bun:test";
import type { WorkspaceRole } from "../accounts/store";
import {
  annotateOwnerAccess,
  filterBridgeStatus,
  filterDisplayOwners,
  filterEvent,
  filterListResult,
  filterPresenceSnapshot,
} from "./filters";

const roles: Record<string, WorkspaceRole> = { w1: "viewer", w3: "editor" };
const roleOf = (workspace: string) => roles[workspace] ?? null;

describe("result filters", () => {
  test("lists keep readable workspaces and mark the caller's role", () => {
    const result = {
      workspaces: [
        { workspace_id: "w1", label: "shared" },
        { workspace_id: "w2", label: "private" },
      ],
      tabs: [
        { tab_id: "w1:t1", workspace_id: "w1" },
        { tab_id: "w2:t1", workspace_id: "w2" },
      ],
      panes: [{ pane_id: "w2:p1" }, { pane_id: "w3:p1" }],
      navigation_mode: "browser-local",
    };
    expect(filterListResult(result, roleOf)).toEqual({
      workspaces: [{ workspace_id: "w1", label: "shared", access: "viewer" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
      panes: [{ pane_id: "w3:p1" }],
      navigation_mode: "browser-local",
    });
    expect(
      annotateOwnerAccess({ workspaces: [{ workspace_id: "w2" }] }),
    ).toEqual({ workspaces: [{ workspace_id: "w2", access: "owner" }] });
  });

  test("presence shows only people in readable workspaces", () => {
    const snapshot = {
      participants: [
        {
          participant_id: "a",
          workspace_id: "w1",
          person_id: "pa",
          device_id: "da",
        },
        {
          participant_id: "b",
          workspace_id: "w2",
          person_id: "pb",
          device_id: "db",
        },
        { participant_id: "c", person_id: "pc" },
      ],
      pane_claims: [
        { pane_id: "w1:p1", participant_id: "a" },
        { pane_id: "w2:p1", participant_id: "b" },
      ],
      people: { pa: { display_name: "A" }, pb: { display_name: "B" }, pc: {} },
      devices: { da: { name: "x" }, db: { name: "y" } },
      lease_ttl_ms: 45_000,
    };
    expect(filterPresenceSnapshot(snapshot, roleOf) as unknown).toEqual({
      participants: [snapshot.participants[0]],
      pane_claims: [snapshot.pane_claims[0]],
      people: { pa: { display_name: "A" } },
      devices: { da: { name: "x" } },
      lease_ttl_ms: 45_000,
    });
  });

  test("events are passed, filtered, reduced to a resync, or dropped", () => {
    const pass = (event: unknown) => filterEvent(event, roleOf);
    expect(pass({ event: "session.resync_required", data: {} })).toEqual({
      event: { event: "session.resync_required", data: {} },
    });
    const focused = {
      event: "pane.focused",
      data: { pane_id: "w1:p2", workspace_id: "w1" },
    };
    expect(pass(focused)).toEqual({ event: focused });
    expect(
      pass({
        event: "pane.created",
        data: { pane: { pane_id: "w2:p9", workspace_id: "w2" } },
      }),
    ).toBeNull();
    expect(
      pass({
        event: "workspace.renamed",
        data: { workspace_id: "w2", label: "x" },
      }),
    ).toBeNull();
    expect(
      pass({
        event: "pane.moved",
        data: {
          previous_pane_id: "w2:p1",
          previous_workspace_id: "w2",
          pane: { pane_id: "w1:p5", workspace_id: "w1" },
        },
      }),
    ).toEqual({ resync: true });
    expect(
      pass({
        event: "workspace.moved",
        data: {
          workspace_id: "w2",
          workspaces: [{ workspace_id: "w1" }, { workspace_id: "w2" }],
        },
      }),
    ).toEqual({
      event: {
        event: "workspace.moved",
        data: { workspaces: [{ workspace_id: "w1", access: "viewer" }] },
      },
    });
    expect(
      pass({
        event: "collaboration.updated",
        data: {
          snapshot: {
            participants: [{ participant_id: "b", workspace_id: "w2" }],
            pane_claims: [],
          },
        },
      }),
    ).toEqual({
      event: {
        event: "collaboration.updated",
        data: { snapshot: { participants: [], pane_claims: [] } },
      },
    });
    // Unknown events without a workspace fail closed.
    expect(
      pass({ event: "server.secret_thing", data: { path: "/etc" } }),
    ).toBeNull();
  });

  test("display owners are narrowed to readable panes", () => {
    const owners = [
      { pane_id: "w1:p1", participant_id: "a" },
      { pane_id: "w2:p1", participant_id: "b" },
    ];
    const kept = [{ pane_id: "w1:p1", participant_id: "a" }];
    expect(filterDisplayOwners({ display_owners: owners }, roleOf)).toEqual({
      display_owners: kept,
    });
    expect(
      filterEvent(
        {
          event: "collaboration.display",
          data: { type: "collaboration_display", display_owners: owners },
        },
        roleOf,
      ),
    ).toEqual({
      event: {
        event: "collaboration.display",
        data: { type: "collaboration_display", display_owners: kept },
      },
    });
    const snapshot = filterPresenceSnapshot(
      { participants: [], pane_claims: [], display_owners: owners },
      roleOf,
    ) as { display_owners: unknown };
    expect(snapshot.display_owners).toEqual(kept);
  });

  test("bridge status hides host details and other connections", () => {
    const status = {
      clients: 3,
      devices: 2,
      terminals: [{ terminal_id: "t1" }],
      default_connection_id: "c1",
      connections: [
        {
          id: "c1",
          label: "Local",
          state: "ready",
          generation: 1,
          source: "/sock",
          is_default: true,
        },
        {
          id: "c2",
          label: "ssh",
          state: "ready",
          generation: 1,
          ssh_destination: "root@host",
        },
      ],
    };
    expect(filterBridgeStatus(status, (id) => id === "c1")).toEqual({
      clients: 3,
      devices: 2,
      terminals: [],
      default_connection_id: "c1",
      connections: [
        {
          id: "c1",
          label: "Local",
          source: "/sock",
          is_default: true,
          state: "ready",
          generation: 1,
        },
      ],
    });
  });
});
