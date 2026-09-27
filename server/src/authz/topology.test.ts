import { expect, test } from "bun:test";
import { createClaimTracker } from "./pane-claims";
import { createTopology, isStructuralEvent } from "./topology";

test("topology loads lazily, reloads when stale, and throttles misses", async () => {
  let now = 1000;
  let calls = 0;
  let panes = [
    {
      pane_id: "w1:p1",
      terminal_id: "t1",
      tab_id: "w1:t1",
      workspace_id: "w1",
    },
  ];
  const topology = createTopology({
    listPanes: async () => {
      calls += 1;
      return { panes };
    },
    now: () => now,
  });
  expect(await topology.locate({ terminal: "t1" })).toEqual({
    workspace: "w1",
    pane: "w1:p1",
    tab: "w1:t1",
  });
  expect(await topology.locate({ tab: "w1:t1" })).toEqual({ workspace: "w1" });
  // Pane-scoped share links ask which tab holds a pane, without waiting.
  expect(topology.peek({ pane: "w1:p1" })?.tab).toBe("w1:t1");
  expect(calls).toBe(1);
  // A pane moved: the next lookup after a structural event reloads.
  panes = [
    {
      pane_id: "w2:p1",
      terminal_id: "t1",
      tab_id: "w2:t1",
      workspace_id: "w2",
    },
  ];
  expect(isStructuralEvent("pane.moved")).toBe(true);
  expect(isStructuralEvent("collaboration.updated")).toBe(false);
  topology.invalidate();
  expect((await topology.locate({ terminal: "t1" }))?.workspace).toBe("w2");
  expect(calls).toBe(2);
  // Unknown ids reload at most once a second.
  expect(await topology.locate({ terminal: "guess-1" })).toBeNull();
  expect(await topology.locate({ terminal: "guess-2" })).toBeNull();
  expect(calls).toBe(2);
  now += 1500;
  expect(await topology.locate({ terminal: "guess-3" })).toBeNull();
  expect(calls).toBe(3);
});

test("claim mirror follows snapshots, results and expiry", () => {
  let now = 100;
  const claims = createClaimTracker(() => now);
  claims.observeSnapshot({
    pane_claims: [
      {
        pane_id: "w1:p1",
        participant_id: "a",
        expires_at_unix_ms: 500,
        protected_until_unix_ms: 200,
      },
    ],
  });
  expect(claims.get("w1:p1")).toEqual({
    participantId: "a",
    protectedUntil: 200,
  });
  claims.observeResult(
    "collaboration.claim",
    { pane_id: "w1:p2" },
    {
      granted: true,
      claim: { pane_id: "w1:p2", participant_id: "b", expires_at_unix_ms: 500 },
    },
  );
  expect(claims.get("w1:p2")?.participantId).toBe("b");
  claims.observeResult(
    "collaboration.release",
    { pane_id: "w1:p2" },
    { released: true },
  );
  expect(claims.get("w1:p2")).toBeNull();
  claims.observeResult(
    "collaboration.leave",
    { participant_id: "a" },
    { released: true },
  );
  expect(claims.get("w1:p1")).toBeNull();
  claims.observeSnapshot({
    pane_claims: [
      { pane_id: "w1:p3", participant_id: "c", expires_at_unix_ms: 150 },
    ],
  });
  now = 151;
  expect(claims.get("w1:p3")).toBeNull();
});
