import { describe, expect, test } from "bun:test";
import { createCollaborationService } from "./collaboration";
import { createPresenceFocusTracker } from "./presence-focus";

function update(overrides: Record<string, unknown> = {}) {
  return {
    participant_id: "web-a",
    display_name: "Alice",
    color: "#0969da",
    activity: "active",
    surface: "web",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p1",
    ...overrides,
  };
}

describe("presence focus tracker", () => {
  test("announces focus and activity changes, not heartbeats", () => {
    const tracker = createPresenceFocusTracker({ now: () => 1_000 });
    expect(tracker.prepare(update()).commit().changed).toEqual({
      participant_id: "web-a",
      workspace_id: "w1",
      tab_id: "w1:t1",
      pane_id: "w1:p1",
      activity: "active",
    });
    expect(
      tracker.prepare(update({ typing: true })).commit().changed,
    ).toBeNull();
    expect(
      tracker.prepare(update({ pane_id: "w1:p2" })).commit().changed,
    ).toEqual({
      participant_id: "web-a",
      workspace_id: "w1",
      tab_id: "w1:t1",
      pane_id: "w1:p2",
      activity: "active",
    });
    expect(
      tracker.prepare(update({ pane_id: "w1:p2", activity: "away" })).commit()
        .changed,
    ).toMatchObject({ activity: "away" });
  });

  test("overlays the latest focus on an older snapshot", () => {
    const tracker = createPresenceFocusTracker({ now: () => 1_000 });
    tracker
      .prepare(
        update({ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2" }),
      )
      .commit();
    const stale = {
      participants: [
        {
          participant_id: "web-a",
          workspace_id: "w1",
          tab_id: "w1:t1",
          pane_id: "w1:p1",
          activity: "active",
        },
        { participant_id: "tui-1", pane_id: "w1:p3" },
      ],
      pane_claims: [],
    };
    const annotated = tracker.annotate(stale);
    expect(annotated.participants[0]).toMatchObject({
      workspace_id: "w2",
      tab_id: "w2:t1",
      pane_id: "w2:p9",
    });
    expect(annotated.participants[1]).toBe(stale.participants[1]);

    tracker.forget("web-a");
    expect(tracker.annotate(stale)).toBe(stale);
  });
});

describe("collaboration service focus events", () => {
  test("sends a focus event per change at once", async () => {
    const herdrParams: Record<string, unknown>[] = [];
    const focus: unknown[] = [];
    const service = createCollaborationService({
      herdrCall: async (_method, params = {}) => {
        herdrParams.push(params);
        return {
          type: "collaboration_snapshot",
          snapshot: {
            participants: [{ ...params, updated_at_unix_ms: 1 }],
            pane_claims: [],
            lease_ttl_ms: 45_000,
          },
        };
      },
      presence: createPresenceFocusTracker({ now: () => 7 }),
      onFocus: (change) => focus.push(change),
    });

    const result = await service.call("collaboration.update", update());
    await service.call("collaboration.update", update());
    await service.call("collaboration.update", update({ pane_id: "w1:p4" }));

    expect(herdrParams).toHaveLength(3);
    expect(focus).toHaveLength(2);
    expect(focus[1]).toMatchObject({ pane_id: "w1:p4" });
    expect(result.snapshot.participants[0]).toMatchObject({
      pane_id: "w1:p1",
      activity: "active",
    });
  });

  test("announces before Herdr answers and forgets an update it rejected", async () => {
    const focus: unknown[] = [];
    const presence = createPresenceFocusTracker();
    let reject = false;
    let answered = false;
    const service = createCollaborationService({
      herdrCall: async () => {
        expect(focus.length).toBeGreaterThan(0);
        answered = true;
        if (reject) throw new Error("invalid_color");
        return { snapshot: { participants: [], pane_claims: [] } };
      },
      presence,
      onFocus: (change) => focus.push(change),
    });
    await service.call("collaboration.update", update());
    expect(answered).toBe(true);
    reject = true;
    await expect(
      service.call("collaboration.update", update({ pane_id: "w1:p9" })),
    ).rejects.toThrow("invalid_color");
    expect(focus).toHaveLength(2);
    const snapshot = presence.annotate({
      participants: [{ participant_id: "web-a" }],
    });
    expect(snapshot.participants[0]).toMatchObject({ pane_id: "w1:p1" });
  });
});
