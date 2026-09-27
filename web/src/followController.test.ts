import { afterEach, describe, expect, jest, test } from "bun:test";
import type {
  CollaborationParticipant,
  CollaborationSnapshot,
} from "./collaboration";
import type { PersonFocus } from "./collaborationFocus";
import { createFollowController } from "./followController";
import {
  followTarget,
  lastFollowStopReason,
  startFollowing,
  stopFollowing,
} from "./followState";

const self = { participantId: "web-self", personId: "bob" };

function presence(
  ...participants: Partial<CollaborationParticipant>[]
): CollaborationSnapshot {
  return {
    participants: participants.map((entry, index) => ({
      participant_id: `web-${index}`,
      display_name: "Yubo",
      color: "#0969da",
      role: "editor",
      activity: "active",
      surface: "web",
      person_id: "yubo",
      updated_at_unix_ms: 1_000,
      expires_at_unix_ms: Number.MAX_SAFE_INTEGER,
      ...entry,
    })),
    pane_claims: [],
    lease_ttl_ms: 45_000,
  };
}

function harness(navigate: (focus: PersonFocus) => boolean = () => true) {
  const visited: string[] = [];
  const controller = createFollowController({
    navigate: (focus) => {
      visited.push(focus.paneId ?? focus.tabId ?? focus.workspaceId ?? "");
      return navigate(focus);
    },
    graceMs: 3_000,
  });
  return { controller, visited };
}

afterEach(() => {
  stopFollowing("user");
  jest.useRealTimers();
});

describe("follow mode", () => {
  test("moves to the person's focus on start and on every change", () => {
    const { controller, visited } = harness();
    controller.update(presence({ pane_id: "w1:p1" }), self);
    expect(visited).toEqual([]);

    startFollowing({ key: "yubo", name: "Yubo" });
    controller.evaluate();
    controller.update(presence({ pane_id: "w1:p1", typing: true }), self);
    controller.update(presence({ pane_id: "w2:p3" }), self);
    controller.update(presence({ tab_id: "w3:t1" }), self);
    expect(visited).toEqual(["w1:p1", "w2:p3", "w3:t1"]);
  });

  test("follows the most recently active of several devices", () => {
    const { controller, visited } = harness();
    startFollowing({ key: "yubo", name: "Yubo" });
    controller.update(
      presence(
        { pane_id: "laptop-pane", active_at_unix_ms: 5 },
        { pane_id: "phone-pane", active_at_unix_ms: 9 },
      ),
      self,
    );
    controller.update(
      presence(
        { pane_id: "laptop-pane", active_at_unix_ms: 12 },
        { pane_id: "phone-pane", active_at_unix_ms: 9 },
      ),
      self,
    );
    expect(visited).toEqual(["phone-pane", "laptop-pane"]);
  });

  test("retries a pane this page does not know yet", () => {
    let known = false;
    const { controller, visited } = harness(() => known);
    startFollowing({ key: "yubo", name: "Yubo" });
    controller.update(presence({ pane_id: "new-pane" }), self);
    known = true;
    controller.evaluate();
    controller.evaluate();
    expect(visited).toEqual(["new-pane", "new-pane"]);
  });

  test("stops on the user's own navigation or Escape", () => {
    const { controller } = harness();
    startFollowing({ key: "yubo", name: "Yubo" });
    controller.userNavigated();
    expect(followTarget()).toBeNull();
    expect(lastFollowStopReason()).toBe("navigated");

    startFollowing({ key: "yubo", name: "Yubo" });
    controller.keyDown("Enter");
    expect(followTarget()?.key).toBe("yubo");
    controller.keyDown("Escape");
    expect(followTarget()).toBeNull();
    expect(lastFollowStopReason()).toBe("escape");
  });

  test("stops when the person disconnects, but survives a quick reconnect", () => {
    jest.useFakeTimers();
    const { controller, visited } = harness();
    startFollowing({ key: "yubo", name: "Yubo" });
    controller.update(presence({ pane_id: "w1:p1" }), self);

    controller.update(presence(), self);
    jest.advanceTimersByTime(2_000);
    controller.update(presence({ pane_id: "w1:p1" }), self);
    jest.advanceTimersByTime(5_000);
    expect(followTarget()?.key).toBe("yubo");
    expect(visited).toEqual(["w1:p1"]);

    controller.update(presence(), self);
    jest.advanceTimersByTime(3_000);
    expect(followTarget()).toBeNull();
    expect(lastFollowStopReason()).toBe("disconnected");
  });

  test("ignores the store update its own navigation causes", () => {
    const { controller, visited } = harness();
    let nested = false;
    const reentrant = createFollowController({
      navigate: (focus) => {
        visited.push(focus.paneId ?? "");
        if (!nested) {
          nested = true;
          reentrant.evaluate();
        }
        return true;
      },
    });
    startFollowing({ key: "yubo", name: "Yubo" });
    reentrant.update(presence({ pane_id: "w1:p1" }), self);
    expect(visited).toEqual(["w1:p1"]);
    controller.dispose();
  });
});
