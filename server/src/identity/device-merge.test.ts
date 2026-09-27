import { describe, expect, test } from "bun:test";
import { deviceHintsFrom, deviceLabel, hintsMatch } from "./device-hints";
import {
  chooseMergeTarget,
  MERGE_FRESH_MS,
  MERGE_WINDOW_MS,
} from "./device-merge";
import type { DeviceRecord } from "./identity-store";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
// Home screen apps drop the "Version/... Safari/..." suffix.
const IPHONE_PWA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const PIXEL_CHROME =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

const phoneHints = {
  screen: { width: 390, height: 844, dpr: 3 },
  timezone: "America/Los_Angeles",
  language: "en-US",
};

describe("device hints", () => {
  test("derive OS, device and browser from the user agent", () => {
    expect(deviceHintsFrom(IPHONE_SAFARI, phoneHints)).toEqual({
      os: "iOS",
      osVersion: "18",
      device: "iPhone",
      browser: "Safari",
      screen: "390x844@3",
      timezone: "America/Los_Angeles",
      language: "en-US",
    });
    expect(deviceHintsFrom(IPAD_DESKTOP, { touch_points: 5 }).device).toBe(
      "iPad",
    );
    expect(deviceHintsFrom(IPAD_DESKTOP, {}).device).toBe("Mac");
  });

  test("prefer UA-CH platform and model where offered", () => {
    const hints = deviceHintsFrom(PIXEL_CHROME, {
      platform: "Android",
      platform_version: "15.0.0",
      model: "Pixel 8",
    });
    expect(hints).toMatchObject({
      os: "Android",
      osVersion: "15",
      device: "Pixel 8",
      browser: "Chrome",
    });
    expect(deviceLabel(hints)).toBe("Pixel 8");
    expect(deviceLabel(deviceHintsFrom("curl/8", {}))).toBe("");
  });

  test("screen size ignores orientation and bounds client strings", () => {
    const landscape = deviceHintsFrom(IPHONE_PWA, {
      ...phoneHints,
      screen: { width: 844, height: 390, dpr: 3 },
      standalone: true,
    });
    expect(landscape.screen).toBe("390x844@3");
    expect(landscape.standalone).toBe(true);
    expect(
      deviceHintsFrom(IPHONE_SAFARI, { timezone: "x".repeat(500) }).timezone,
    ).toHaveLength(64);
  });

  test("Safari and its home screen app on one phone match; other phones do not", () => {
    const safari = deviceHintsFrom(IPHONE_SAFARI, phoneHints);
    const pwa = deviceHintsFrom(IPHONE_PWA, {
      ...phoneHints,
      standalone: true,
    });
    expect(hintsMatch(safari, pwa)).toBe(true);
    expect(
      hintsMatch(
        safari,
        deviceHintsFrom(IPHONE_SAFARI, {
          ...phoneHints,
          screen: { width: 430, height: 932, dpr: 3 },
        }),
      ),
    ).toBe(false);
    expect(
      hintsMatch(
        safari,
        deviceHintsFrom(IPHONE_SAFARI, { ...phoneHints, timezone: "UTC" }),
      ),
    ).toBe(false);
    // Too little information never matches.
    expect(
      hintsMatch(
        deviceHintsFrom(IPHONE_SAFARI, {}),
        deviceHintsFrom(IPHONE_PWA, {}),
      ),
    ).toBe(false);
  });
});

describe("device merge heuristic", () => {
  const now = 10 * MERGE_WINDOW_MS;
  const safari: DeviceRecord = {
    createdAt: now - 30 * 24 * 3600_000,
    lastSeenAt: now - 60_000,
    addressHash: "home",
    addressSeenAt: now - 60_000,
    hints: deviceHintsFrom(IPHONE_SAFARI, phoneHints),
  };
  const pwa: DeviceRecord = {
    createdAt: now - 1_000,
    lastSeenAt: now,
    addressHash: "home",
    addressSeenAt: now,
    hints: deviceHintsFrom(IPHONE_PWA, { ...phoneHints, standalone: true }),
  };
  const choose = (
    device: DeviceRecord,
    devices: Record<string, DeviceRecord>,
    addressHash = "home",
  ) =>
    chooseMergeTarget({
      deviceId: "pwa",
      device,
      addressHash,
      devices: Object.entries(devices),
      rootId: (id) => devices[id]?.aliasOf ?? id,
      now,
    });

  test("a new context joins the one matching device on the same address", () => {
    expect(choose(pwa, { safari, pwa })).toBe("safari");
  });

  test("the same address alone never merges different devices", () => {
    const laptop: DeviceRecord = {
      ...safari,
      hints: deviceHintsFrom(IPAD_DESKTOP, {
        screen: { width: 1512, height: 982, dpr: 2 },
        timezone: "America/Los_Angeles",
      }),
    };
    expect(choose(pwa, { laptop, pwa })).toBeNull();
  });

  test("matching hints from another address never merge", () => {
    expect(choose(pwa, { safari, pwa }, "office")).toBeNull();
  });

  test("identical devices on one address are ambiguous and stay separate", () => {
    expect(choose(pwa, { safari, twin: { ...safari }, pwa })).toBeNull();
    // Contexts already merged into one device are not ambiguous.
    expect(
      choose(pwa, { safari, chrome: { ...safari, aliasOf: "safari" }, pwa }),
    ).toBe("safari");
  });

  test("established or already matched contexts are never merged later", () => {
    expect(
      choose({ ...pwa, createdAt: now - MERGE_FRESH_MS - 1 }, { safari, pwa }),
    ).toBeNull();
    expect(choose({ ...pwa, aliasOf: "other" }, { safari, pwa })).toBeNull();
  });

  test("a device not seen on this address recently is not a candidate", () => {
    expect(
      choose(pwa, {
        safari: { ...safari, addressSeenAt: now - MERGE_WINDOW_MS - 1 },
        pwa,
      }),
    ).toBeNull();
  });
});
