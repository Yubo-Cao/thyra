import { describe, expect, test } from "bun:test";

import { createCollaborationService } from "../bridge/collaboration";
import { collaborationParams } from "./collaboration-params";

/** Two browsers sharing a bridge-local collaboration service. */
function setup() {
  const service = createCollaborationService({
    herdrCall: async () => {
      throw new Error("unknown method");
    },
  });
  const as =
    (participantId: string) =>
    (method: string, params: Record<string, unknown> = {}) =>
      service.call(method, collaborationParams(method, params, participantId));
  return { alice: as("web-alice"), mallory: as("web-mallory") };
}

describe("collaboration claims are bound to the socket's participant", () => {
  test("client-supplied participant ids and roles are replaced", () => {
    expect(
      collaborationParams(
        "collaboration.update",
        { participant_id: "web-alice", role: "owner", activity: "active" },
        "web-mallory",
      ),
    ).toEqual({
      participant_id: "web-mallory",
      role: "editor",
      activity: "active",
    });
    expect(
      collaborationParams(
        "collaboration.claim",
        {
          participant_id: "web-alice",
          pane_id: "p1",
          takeover: "yes",
          protect_ms: 15_000,
          extra: 1,
        },
        "web-mallory",
      ),
    ).toEqual({
      participant_id: "web-mallory",
      pane_id: "p1",
      protect_ms: 15_000,
    });
    expect(
      collaborationParams(
        "collaboration.leave",
        { participant_id: "web-alice" },
        "web-mallory",
      ),
    ).toEqual({ participant_id: "web-mallory" });
  });

  test("rejects claims without a valid pane id", () => {
    for (const pane_id of [undefined, "", 42, "x".repeat(257)]) {
      expect(() =>
        collaborationParams("collaboration.claim", { pane_id }, "web-a"),
      ).toThrow("pane_id required");
      expect(() =>
        collaborationParams("collaboration.release", { pane_id }, "web-a"),
      ).toThrow("pane_id required");
    }
    expect(() =>
      collaborationParams("collaboration.follow", {}, "web-a"),
    ).toThrow("unknown collaboration method");
  });

  test("another browser cannot release or leave for the owner of a claim", async () => {
    const { alice, mallory } = setup();
    await alice("collaboration.update", {});
    await mallory("collaboration.update", {});
    const claim = await alice("collaboration.claim", {
      pane_id: "p1",
      protect_ms: 60_000,
    });
    expect(claim).toMatchObject({ granted: true });

    const released = await mallory("collaboration.release", {
      pane_id: "p1",
      participant_id: "web-alice",
    });
    expect(released).toMatchObject({ released: false });
    // Leaving "as alice" only removes mallory herself.
    await mallory("collaboration.leave", { participant_id: "web-alice" });
    const afterLeave = (await alice("collaboration.list")) as {
      snapshot: { participants: unknown[]; pane_claims: unknown[] };
    };
    expect(afterLeave.snapshot.participants).toHaveLength(1);
    expect(afterLeave.snapshot.pane_claims).toHaveLength(1);
    await mallory("collaboration.update", { role: "owner" });
    const spoofedClaim = await mallory("collaboration.claim", {
      pane_id: "p1",
      participant_id: "web-alice",
    });
    expect(spoofedClaim).toMatchObject({
      granted: false,
      claim: { participant_id: "web-alice" },
    });
    const snapshot = (await alice("collaboration.list")) as {
      snapshot: { participants: { participant_id: string; role: string }[] };
    };
    expect(
      snapshot.snapshot.participants.map((participant) => [
        participant.participant_id,
        participant.role,
      ]),
    ).toEqual([
      ["web-alice", "editor"],
      ["web-mallory", "editor"],
    ]);
    expect(
      await alice("collaboration.release", { pane_id: "p1" }),
    ).toMatchObject({ released: true });
  });
});
