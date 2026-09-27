import { describe, expect, test } from "bun:test";
import type {
  CollaborationParticipant,
  CollaborationSnapshot,
} from "./collaboration";
import {
  collaboratorGroups,
  collaboratorLabel,
  panePresence,
  panePresenceLabel,
  panePresenceSignature,
  presencePeople,
} from "./collaborationGroups";

function participant(
  id: string,
  extra: Partial<CollaborationParticipant> = {},
): CollaborationParticipant {
  return {
    participant_id: id,
    display_name: id,
    color: "#0969da",
    role: "editor",
    activity: "active",
    surface: "web",
    updated_at_unix_ms: 0,
    expires_at_unix_ms: 10_000,
    ...extra,
  };
}

// Yubo: two tabs on the iPhone (Safari + home screen app) and liveopt.
// Alice: one browser without Tailscale. A real Herdr TUI on the host.
const snapshot: CollaborationSnapshot = {
  participants: [
    participant("web-phone-safari", {
      person_id: "yubo",
      device_id: "iphone",
      pane_id: "p1",
    }),
    participant("web-phone-pwa", {
      person_id: "yubo",
      device_id: "iphone",
      pane_id: "p1",
    }),
    participant("web-liveopt", {
      person_id: "yubo",
      device_id: "liveopt",
      pane_id: "p2",
    }),
    participant("web-alice", {
      display_name: "Alice",
      person_id: "alice",
      device_id: "alice-mac",
      pane_id: "p1",
      typing: true,
      typing_expires_at_unix_ms: 9_000,
    }),
    participant("web-alice-hidden", {
      person_id: "alice",
      device_id: "alice-mac",
      pane_id: "p3",
      activity: "away",
    }),
    participant("tui:4", {
      display_name: "Herdr TUI 4",
      surface: "tui",
      person_id: "tui-host",
      device_id: "host",
      pane_id: "p2",
    }),
    participant("web-old", { pane_id: "p1", expires_at_unix_ms: 500 }),
  ],
  pane_claims: [
    {
      pane_id: "p2",
      participant_id: "web-liveopt",
      acquired_at_unix_ms: 0,
      updated_at_unix_ms: 0,
      expires_at_unix_ms: 10_000,
    },
  ],
  lease_ttl_ms: 45_000,
  people: {
    yubo: {
      display_name: "Yubo",
      color: "#1a7f37",
      avatar_url: "https://example.com/y.png",
    },
    alice: { display_name: "Alice", color: "#cf222e" },
    "tui-host": { display_name: "Herdr TUI", color: "#8250df" },
  },
  devices: {
    iphone: { name: "iphone", match: "tailscale" },
    liveopt: { name: "liveopt", match: "tailscale" },
    "alice-mac": { name: "Mac", match: "cookie" },
    host: { name: "liveopt" },
  },
};

describe("presence grouping", () => {
  test("groups by person, lists devices once, and collapses tabs", () => {
    const groups = collaboratorGroups(
      snapshot,
      {
        participantId: "web-phone-safari",
        personId: "yubo",
        deviceId: "iphone",
      },
      1_000,
    );
    expect(groups.map((group) => group.name)).toEqual([
      "Yubo",
      "Alice",
      "Herdr TUI",
    ]);
    const [yubo, alice] = groups;
    expect(yubo.isSelf).toBe(true);
    expect(yubo.avatarUrl).toBe("https://example.com/y.png");
    expect(
      yubo.devices.map(({ name, contexts, isSelf }) => ({
        name,
        contexts,
        isSelf,
      })),
    ).toEqual([
      { name: "iphone", contexts: 2, isSelf: true },
      { name: "liveopt", contexts: 1, isSelf: false },
    ]);
    expect(collaboratorLabel(yubo)).toBe("Yubo · iphone (2), liveopt");
    expect(alice.typing).toBe(true);
    expect(alice.activity).toBe("active");
    expect(alice.devices).toHaveLength(1);
  });

  test("participants without bridge identity stay individual", () => {
    const groups = collaboratorGroups(
      {
        participants: [
          participant("a", { display_name: "A" }),
          participant("b", { display_name: "B", surface: "tui" }),
        ],
        pane_claims: [],
        lease_ttl_ms: 45_000,
      },
      { participantId: "a" },
      1_000,
    );
    expect(groups.map((group) => [group.name, group.devices[0].name])).toEqual([
      ["A", "Browser"],
      ["B", "Herdr TUI"],
    ]);
    expect(groups[0].isSelf).toBe(true);
  });
});

describe("pane presence", () => {
  const self = {
    participantId: "web-phone-safari",
    personId: "yubo",
    deviceId: "iphone",
  };

  test("lists other people looking at a pane, one avatar per person", () => {
    const presence = panePresence(snapshot, ["p1"], self, 1_000);
    expect(presence.controller).toBeNull();
    expect(
      presence.viewers.map((viewer) => [viewer.name, viewer.devices]),
    ).toEqual([
      ["Alice", ["Mac"]],
      // This page is not a viewer, but the home screen app on it is.
      ["Yubo", ["iphone"]],
    ]);
    expect(panePresenceLabel(presence)).toBe(
      "Viewing: Alice (Mac), You (iphone)",
    );
  });

  test("marks the controller and counts a real Herdr TUI as a viewer", () => {
    const presence = panePresence(snapshot, ["p2"], self, 1_000);
    expect(presence.controller).toMatchObject({
      name: "Yubo",
      devices: ["liveopt"],
      isSelf: true,
    });
    expect(presence.viewers.map((viewer) => viewer.name)).toEqual([
      "Yubo",
      "Herdr TUI",
    ]);
    expect(panePresenceLabel(presence)).toBe(
      "Viewing: You (liveopt), Herdr TUI (liveopt); Controlling: You (liveopt)",
    );
  });

  test("hidden pages and expired leases are not viewers; tabs merge their panes", () => {
    expect(panePresence(snapshot, ["p3"], self, 1_000).viewers).toEqual([]);
    const tab = panePresence(snapshot, ["p1", "p2"], self, 1_000);
    expect(tab.viewers.map((viewer) => viewer.name)).toEqual([
      "Yubo",
      "Alice",
      "Herdr TUI",
    ]);
    expect(tab.viewers[0].devices).toEqual(["iphone", "liveopt"]);
    expect(panePresence(snapshot, ["p2"], self, 20_000).controller).toBeNull();
  });

  test("a tab shows one avatar per person, its controller first and marked", () => {
    const people = presencePeople(
      panePresence(snapshot, ["p1", "p2", "p3"], self, 1_000),
    );
    // Yubo views p1 from the phone app and controls p2 from liveopt: one
    // avatar, first, marked; Alice's hidden page on p3 adds no second one.
    expect(people.map(({ name, controller }) => [name, controller])).toEqual([
      ["Yubo", true],
      ["Alice", false],
      ["Herdr TUI", false],
    ]);
    const viewersOnly = presencePeople(
      panePresence(snapshot, ["p1"], self, 1_000),
    );
    expect(viewersOnly.some((person) => person.controller)).toBe(false);
    expect(presencePeople(panePresence(snapshot, [], self, 1_000))).toEqual([]);
  });

  test("signatures change only when the visible presence changes", () => {
    const first = panePresence(snapshot, ["p1"], self, 1_000);
    const again = panePresence(
      { ...snapshot, participants: [...snapshot.participants] },
      ["p1"],
      self,
      2_000,
    );
    expect(panePresenceSignature(again)).toBe(panePresenceSignature(first));
    expect(
      panePresenceSignature(panePresence(snapshot, ["none"], self, 1_000)),
    ).toBe("");
  });
});
