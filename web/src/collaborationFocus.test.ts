import { describe, expect, test } from "bun:test";
import type {
  CollaborationParticipant,
  CollaborationSnapshot,
} from "./collaboration";
import {
  focusLocation,
  focusLocationLabel,
  followersOf,
  personFocus,
} from "./collaborationFocus";
import type { Pane, Tab, Workspace } from "./types";

function participant(
  id: string,
  overrides: Partial<CollaborationParticipant> = {},
): CollaborationParticipant {
  return {
    participant_id: id,
    display_name: id,
    color: "#0969da",
    role: "editor",
    activity: "active",
    surface: "web",
    updated_at_unix_ms: 1_000,
    expires_at_unix_ms: 100_000,
    ...overrides,
  };
}

function snapshot(
  participants: CollaborationParticipant[],
): CollaborationSnapshot {
  return {
    participants,
    pane_claims: [],
    lease_ttl_ms: 45_000,
    people: {
      yubo: { display_name: "Yubo", color: "#0969da" },
      alice: { display_name: "Alice", color: "#1a7f37" },
    },
    devices: {
      laptop: { name: "liveopt" },
      phone: { name: "iPhone" },
    },
  };
}

const self = { participantId: "web-self", personId: "alice" };

describe("person focus", () => {
  test("uses the most recently active device of a person", () => {
    const presence = snapshot([
      participant("web-laptop", {
        person_id: "yubo",
        device_id: "laptop",
        pane_id: "w1:p1",
        active_at_unix_ms: 5_000,
      }),
      participant("web-phone", {
        person_id: "yubo",
        device_id: "phone",
        workspace_id: "w2",
        tab_id: "w2:t1",
        pane_id: "w2:p3",
        active_at_unix_ms: 9_000,
      }),
    ]);
    expect(personFocus(presence, "yubo", self, 2_000)).toEqual({
      participantId: "web-phone",
      device: "iPhone",
      workspaceId: "w2",
      tabId: "w2:t1",
      paneId: "w2:p3",
    });
  });

  test("prefers a visible page over a more recent hidden one", () => {
    const presence = snapshot([
      participant("web-laptop", {
        person_id: "yubo",
        device_id: "laptop",
        pane_id: "w1:p1",
        active_at_unix_ms: 5_000,
      }),
      participant("web-phone", {
        person_id: "yubo",
        device_id: "phone",
        activity: "away",
        pane_id: "w2:p3",
        active_at_unix_ms: 9_000,
      }),
    ]);
    expect(personFocus(presence, "yubo", self, 2_000)?.device).toBe("liveopt");
  });

  test("never follows this page, and a person without live pages is gone", () => {
    const presence = snapshot([
      participant("web-self", { person_id: "alice", pane_id: "w1:p1" }),
      participant("web-old", {
        person_id: "yubo",
        pane_id: "w1:p2",
        expires_at_unix_ms: 1_500,
      }),
    ]);
    expect(personFocus(presence, "alice", self, 2_000)).toBeNull();
    expect(personFocus(presence, "yubo", self, 2_000)).toBeNull();
    expect(personFocus(null, "yubo", self, 2_000)).toBeNull();
  });

  test("lists who follows this person, once per person", () => {
    const presence = snapshot([
      participant("web-y1", { person_id: "yubo", following: "alice" }),
      participant("web-y2", { person_id: "yubo", following: "alice" }),
      participant("web-anon", {
        display_name: "Guest",
        following: "participant:someone-else",
      }),
    ]);
    expect(followersOf(presence, self, 2_000)).toEqual([
      { key: "yubo", name: "Yubo" },
    ]);
  });
});

describe("focus location", () => {
  const lists = {
    workspaces: [
      { workspace_id: "w2", label: "thyra", number: 2 } as Workspace,
    ],
    tabs: [
      {
        tab_id: "w2:t1",
        workspace_id: "w2",
        number: 1,
        label: "1",
        pane_count: 2,
      } as Tab,
    ],
    panes: [
      {
        pane_id: "w2:p3",
        tab_id: "w2:t1",
        workspace_id: "w2",
        cwd: "/home/yubo/server",
      } as Pane,
    ],
  };

  test("names workspace, tab and pane with its short id", () => {
    const location = focusLocation(
      { workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p3" },
      lists,
    );
    expect(location).toEqual({
      workspace: "thyra",
      tab: "Tab 1",
      pane: "server",
      paneId: "p3",
    });
    expect(location && focusLocationLabel(location)).toBe(
      "thyra \u203a Tab 1 \u203a server",
    );
  });

  test("does not repeat a pane named like its tab", () => {
    expect(
      focusLocationLabel({
        workspace: "alpha",
        tab: "logs",
        pane: "logs",
        paneId: "p3",
      }),
    ).toBe("alpha \u203a logs");
  });

  test("is unknown for a workspace this page does not list", () => {
    expect(focusLocation({ workspaceId: "w9" }, lists)).toBeNull();
  });
});
