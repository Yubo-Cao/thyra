import { expect, test } from "bun:test";
import {
  paneControlClient,
  paneControlState,
  type PaneControlState,
} from "./paneControl";
import type { ConnectionClient } from "./api";
import type { CollaborationSnapshot } from "./collaboration";

const snapshot: CollaborationSnapshot = {
  participants: [
    {
      participant_id: "alice",
      display_name: "Alice",
      color: "#0969da",
      role: "editor",
      activity: "active",
      surface: "web",
      updated_at_unix_ms: 100,
      expires_at_unix_ms: 500,
    },
  ],
  pane_claims: [
    {
      participant_id: "alice",
      pane_id: "p1",
      acquired_at_unix_ms: 100,
      updated_at_unix_ms: 100,
      expires_at_unix_ms: 500,
      protected_until_unix_ms: 250,
    },
  ],
  lease_ttl_ms: 400,
};
test("layout ownership is pane-specific, expires, and does not grant input in view-only mode", () => {
  expect(paneControlState(snapshot, "p1", "bob", false, 200)).toMatchObject({
    ownsLayout: false,
    canResize: false,
    ownerName: "Alice",
    protectedUntil: 250,
  });
  expect(paneControlState(snapshot, "p2", "bob", false, 200).canResize).toBe(
    true,
  );
  expect(paneControlState(snapshot, "p1", "alice", true, 200)).toMatchObject({
    ownsLayout: true,
    canResize: false,
    viewOnly: true,
  });
  expect(paneControlState(snapshot, "p1", "bob", false, 501)).toMatchObject({
    ownerName: null,
    canResize: true,
  });
});
test("names the owner's device so another device of the same person is clear", () => {
  const annotated: CollaborationSnapshot = {
    ...snapshot,
    participants: [
      { ...snapshot.participants[0], person_id: "p-a", device_id: "d-phone" },
    ],
    devices: { "d-phone": { name: "iPhone" } },
  };
  expect(paneControlState(annotated, "p1", "bob", false, 200).ownerName).toBe(
    "Alice (iPhone)",
  );
});
test("one live gate blocks keys, IME, paste/composer and resizing while preserving history", async () => {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const base: ConnectionClient = {
    connectionId: "local",
    generation: 1,
    serverRuntimeGeneration: 1,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
    call: async (method, params) => {
      calls.push([method, params]);
      return { ok: true };
    },
  };
  let access: PaneControlState = {
    viewOnly: true,
    ownsLayout: false,
    canResize: false,
    ownerName: "Alice",
    protectedUntil: 0,
    display: null,
    inputOnly: false,
  };
  const client = paneControlClient(base, () => access);
  for (const method of [
    "terminal.input",
    "pane.send_input",
    "pane.send_key",
    "pane.paste",
  ])
    await expect(client.call(method, { data: "eA==" })).rejects.toThrow(
      "view only",
    );
  await client.call("terminal.focus");
  await client.call("terminal.resize", { cols: 160, rows: 50 });
  await client.call("terminal.relay_resize", { cols: 160, rows: 50 });
  expect(calls).toEqual([]);
  await client.call("terminal.scroll", { direction: "up", source: "wheel" });
  expect(calls[calls.length - 1]).toEqual([
    "terminal.scroll",
    { direction: "up", source: "history" },
  ]);
  await client.call("terminal.attach", {
    terminal_id: "t1",
    cols: 80,
    rows: 24,
  });
  expect(calls[calls.length - 1]?.[1]?.preserve_size).toBe(true);
  access = { ...access, viewOnly: false, canResize: true, ownsLayout: true };
  await client.call("terminal.input", { data: "eA==" });
  expect(calls[calls.length - 1]?.[0]).toBe("terminal.input");
  access = { ...access, viewOnly: true, canResize: false };
  await expect(
    client.call("pane.send_input", { text: "late paste" }),
  ).rejects.toThrow("view only");
});

const participant = (
  id: string,
  device: string,
  activity: "active" | "away" = "active",
) => ({
  ...snapshot.participants[0],
  participant_id: id,
  display_name: id,
  device_id: device,
  activity,
});
const displayed = (
  claimHolder: string,
  owner: { participant_id: string; pinned: boolean },
  ipadActivity: "active" | "away" = "active",
): CollaborationSnapshot => ({
  ...snapshot,
  participants: [
    participant("ipad", "d-ipad", ipadActivity),
    participant("ipad-reloaded", "d-ipad"),
    participant("phone", "d-phone"),
  ],
  devices: { "d-ipad": { name: "iPad" }, "d-phone": { name: "iPhone" } },
  pane_claims: [
    {
      ...snapshot.pane_claims[0],
      participant_id: claimHolder,
      protected_until_unix_ms: undefined,
    },
  ],
  display_owners: [{ pane_id: "p1", since_unix_ms: 1, ...owner }],
});

test("a device typing into a pane another device displays is input-only", () => {
  // The iPad pinned the pane; the phone took input control ("Type here").
  const state = displayed("phone", { participant_id: "ipad", pinned: true });
  expect(paneControlState(state, "p1", "phone", false, 200)).toMatchObject({
    ownsLayout: true,
    canResize: false,
    inputOnly: true,
    display: { mine: false, pinned: true, name: "ipad (iPad)", active: true },
  });
  // The iPad keeps sizing the pane without holding the claim.
  expect(paneControlState(state, "p1", "ipad", false, 200)).toMatchObject({
    ownsLayout: false,
    canResize: true,
    inputOnly: false,
    display: { mine: true },
  });
  // A reloaded iPad page is the same device, so the pin is still its own.
  expect(
    paneControlState(state, "p1", "ipad-reloaded", false, 200).canResize,
  ).toBe(true);
  // Viewing only never sizes or types, even for the display owner.
  expect(paneControlState(state, "p1", "ipad", true, 200)).toMatchObject({
    canResize: false,
    inputOnly: false,
  });
});

test("taking control and resizing here moves the display to this device", () => {
  const taken = displayed("phone", { participant_id: "phone", pinned: false });
  expect(paneControlState(taken, "p1", "phone", false, 200)).toMatchObject({
    canResize: true,
    inputOnly: false,
  });
  expect(paneControlState(taken, "p1", "ipad", false, 200)).toMatchObject({
    canResize: false,
    inputOnly: false,
    display: { mine: false, pinned: false },
  });
  // An unpinned display is this page's alone, not its device's.
  expect(
    paneControlState(taken, "p1", "ipad-reloaded", false, 200).display?.mine,
  ).toBe(false);
});

test("reports whether the displaying device is active", () => {
  const away = displayed(
    "phone",
    { participant_id: "ipad", pinned: true },
    "away",
  );
  expect(paneControlState(away, "p1", "phone", false, 200).display).toEqual({
    participantId: "ipad",
    mine: false,
    pinned: true,
    name: "ipad (iPad)",
    active: false,
  });
});

test("a device that does not display the pane never resizes or focuses it", async () => {
  const calls: string[] = [];
  const base: ConnectionClient = {
    connectionId: "local",
    generation: 1,
    serverRuntimeGeneration: 1,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
    call: async (method) => {
      calls.push(method);
      return { ok: true };
    },
  };
  const state = paneControlState(
    displayed("phone", { participant_id: "ipad", pinned: true }),
    "p1",
    "phone",
    false,
    200,
  );
  const client = paneControlClient(base, () => state);
  await client.call("terminal.resize", { cols: 45, rows: 30 });
  await client.call("terminal.focus", { terminal_id: "t1" });
  await client.call("terminal.input", { data: "eA==" });
  await client.call("pane.send_input", { text: "hi" });
  expect(calls).toEqual(["terminal.input", "pane.send_input"]);
});
