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
  test("announces focus, activity and follow changes, not heartbeats", () => {
    let now = 1_000;
    const tracker = createPresenceFocusTracker({ now: () => now });
    const first = tracker.prepare(update({ following: "person-b" }));
    expect(first.herdrParams).not.toHaveProperty("following");
    expect(first.commit().changed).toEqual({
      participant_id: "web-a",
      workspace_id: "w1",
      tab_id: "w1:t1",
      pane_id: "w1:p1",
      activity: "active",
      following: "person-b",
      active_at_unix_ms: 1_000,
    });

    now = 2_000;
    expect(
      tracker.prepare(update({ following: "person-b" })).commit().changed,
    ).toBeNull();

    now = 3_000;
    expect(
      tracker.prepare(update({ pane_id: "w1:p2" })).commit().changed,
    ).toEqual({
      participant_id: "web-a",
      workspace_id: "w1",
      tab_id: "w1:t1",
      pane_id: "w1:p2",
      activity: "active",
      active_at_unix_ms: 3_000,
    });

    now = 4_000;
    const away = tracker.prepare(
      update({ pane_id: "w1:p2", activity: "away" }),
    );
    expect(away.commit().changed).toMatchObject({
      activity: "away",
      active_at_unix_ms: 3_000,
    });
  });

  test("typing refreshes activity silently", () => {
    let now = 1_000;
    const tracker = createPresenceFocusTracker({ now: () => now });
    tracker.prepare(update()).commit();
    now = 5_000;
    expect(
      tracker.prepare(update({ typing: true })).commit().changed,
    ).toBeNull();
    const snapshot = tracker.annotate({
      participants: [{ participant_id: "web-a", pane_id: "w1:p1" }],
    });
    expect(snapshot.participants[0]).toMatchObject({
      active_at_unix_ms: 5_000,
    });
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
      active_at_unix_ms: 1_000,
    });
    expect(annotated.participants[1]).toBe(stale.participants[1]);

    tracker.forget("web-a");
    expect(tracker.annotate(stale)).toBe(stale);
  });
});

describe("collaboration service focus events", () => {
  test("sends a focus event per change at once and hides bridge-only params from Herdr", async () => {
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

    const result = await service.call(
      "collaboration.update",
      update({ following: "person-b" }),
    );
    await service.call(
      "collaboration.update",
      update({ following: "person-b" }),
    );
    await service.call("collaboration.update", update({ pane_id: "w1:p4" }));

    expect(herdrParams.every((params) => !("following" in params))).toBe(true);
    expect(focus).toHaveLength(2);
    expect(focus[1]).toMatchObject({ pane_id: "w1:p4" });
    expect(result.snapshot.participants[0]).toMatchObject({
      following: "person-b",
      active_at_unix_ms: 7,
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
