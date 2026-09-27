import { describe, expect, test } from "bun:test";
import {
  createDisplayOwnership,
  validDisplayPaneId,
} from "./display-ownership";

const ipad = { participantId: "web-ipad", deviceKey: "device:ipad" };
const ipadReloaded = { participantId: "web-ipad-2", deviceKey: "device:ipad" };
const phone = { participantId: "web-phone", deviceKey: "device:phone" };

function ownership() {
  const changes: unknown[] = [];
  let now = 1_000;
  const display = createDisplayOwnership({
    now: () => now,
    onChange: (owners) => changes.push(owners),
  });
  return { display, changes, advance: (ms: number) => (now += ms) };
}

describe("display ownership", () => {
  test("panes without an owner stay unrestricted", () => {
    const { display } = ownership();
    expect(display.active()).toBe(false);
    expect(display.authorize("p1", phone)).toBe(true);
    expect(display.authorize(null, null)).toBe(true);
  });

  test("a pinned device alone sizes the pane, across reloads", () => {
    const { display, changes } = ownership();
    display.claim("p1", ipad, true);
    expect(display.active()).toBe(true);
    expect(display.authorize("p1", phone)).toBe(false);
    expect(display.authorize("p1", null)).toBe(false);
    expect(display.authorize("p2", phone)).toBe(true);
    expect(display.authorize("p1", ipad)).toBe(true);
    // A reloaded page of the same device keeps the pin and becomes its face.
    expect(display.permits("p1", ipadReloaded)).toBe(true);
    expect(display.owner("p1")?.participant_id).toBe("web-ipad");
    expect(display.authorize("p1", ipadReloaded)).toBe(true);
    expect(display.owner("p1")?.participant_id).toBe("web-ipad-2");
    expect(changes).toHaveLength(2);
  });

  test("a pin outlives its participant; an unpinned display does not", () => {
    const { display } = ownership();
    display.claim("p1", ipad, true);
    display.claim("p2", phone, false);
    display.forgetParticipant("web-ipad");
    display.forgetParticipant("web-phone");
    expect(display.owner("p1")?.pinned).toBe(true);
    expect(display.owner("p2")).toBeNull();

    display.claim("p2", phone, false);
    display.observeParticipants({ participants: [] });
    expect(display.owner("p2")).toBeNull();
    expect(display.owner("p1")).not.toBeNull();
  });

  test("taking the display replaces the pinned device", () => {
    const { display, advance } = ownership();
    display.claim("p1", ipad, true);
    advance(500);
    const taken = display.claim("p1", phone, false);
    expect(taken).toEqual({
      pane_id: "p1",
      participant_id: "web-phone",
      pinned: false,
      since_unix_ms: 1_500,
    });
    expect(display.authorize("p1", ipad)).toBe(false);
    expect(display.authorize("p1", phone)).toBe(true);
  });

  test("only the owning device may release", () => {
    const { display } = ownership();
    display.claim("p1", ipad, true);
    expect(display.release("p1", phone)).toBe(false);
    expect(display.release("p1", ipadReloaded)).toBe(true);
    expect(display.active()).toBe(false);
    expect(display.release("p1", ipad)).toBe(false);
  });

  test("snapshots carry the public owner list without device keys", () => {
    const { display } = ownership();
    display.claim("p1", ipad, true);
    const annotated: unknown = display.annotate({
      participants: [],
      pane_claims: [],
    });
    expect(annotated).toEqual({
      participants: [],
      pane_claims: [],
      display_owners: [
        {
          pane_id: "p1",
          participant_id: "web-ipad",
          pinned: true,
          since_unix_ms: 1_000,
        },
      ],
    });
    expect(JSON.stringify(annotated)).not.toContain("device:ipad");
    expect(display.annotate(null)).toBeNull();
    expect(display.annotate({ other: true })).toEqual({ other: true });
  });

  test("repeating the same claim does not re-announce it", () => {
    const { display, changes } = ownership();
    display.claim("p1", ipad, true);
    display.claim("p1", ipad, true);
    expect(changes).toHaveLength(1);
  });

  test("validates pane ids", () => {
    expect(validDisplayPaneId("p1")).toBe("p1");
    expect(validDisplayPaneId("")).toBeNull();
    expect(validDisplayPaneId(7)).toBeNull();
    expect(validDisplayPaneId("x".repeat(257))).toBeNull();
  });
});
