import { describe, expect, test } from "bun:test";
import { avatarLift, avatarSlots, initials } from "./avatarGroupModel";

describe("avatar group", () => {
  test("shows up to max avatars and counts the rest in a +N chip", () => {
    const people = ["a", "b", "c", "d", "e"];
    expect(avatarSlots(people, 3)).toEqual({
      shown: ["a", "b", "c"],
      overflow: 2,
    });
    expect(avatarSlots(people.slice(0, 3), 3)).toEqual({
      shown: ["a", "b", "c"],
      overflow: 0,
    });
    expect(avatarSlots([], 3)).toEqual({ shown: [], overflow: 0 });
    expect(avatarSlots(people, 0).shown).toEqual(["a"]);
  });

  test("the hovered avatar lifts most and neighbours fall off by distance", () => {
    expect([0, 1, 2, 3].map((index) => avatarLift(index, 1))).toEqual([
      -1.8, -4, -1.8, -0.81,
    ]);
    // avatar.css derives the focus-visible lift from the same falloff.
    expect([0, 1, 2, 3].map((index) => avatarLift(index, 0))).toEqual([
      -4, -1.8, -0.81, -0.365,
    ]);
  });

  test("initials take the first letter of up to two words", () => {
    expect(initials("Yubo Cao")).toBe("YC");
    expect(initials("  ada  lovelace byron ")).toBe("AL");
    expect(initials("张三")).toBe("张");
    expect(initials("")).toBe("");
  });
});
