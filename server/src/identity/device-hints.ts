/**
 * Lightweight, non-invasive device hints: the User-Agent, User-Agent Client
 * Hints (platform/model where the browser offers them), screen size, time
 * zone and language. No canvas, audio or font fingerprinting.
 */

export type DeviceHints = {
  /** `iOS`, `iPadOS`, `Android`, `macOS`, `Windows`, `Linux` or `ChromeOS`. */
  os?: string;
  /** Major OS version when the browser reports it. */
  osVersion?: string;
  /** `iPhone`, `iPad`, `Mac` or a UA-CH model such as `Pixel 8`. */
  device?: string;
  browser?: string;
  /** Screen as `<short>x<long>@<dpr>`, independent of orientation. */
  screen?: string;
  timezone?: string;
  language?: string;
  /** An installed (home screen) app context. */
  standalone?: boolean;
};

function clean(value: unknown, max = 64): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[^\x20-\x7e]/g, "").trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function finite(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

const UA_CH_OS: Record<string, string> = {
  android: "Android",
  "chrome os": "ChromeOS",
  chromeos: "ChromeOS",
  ios: "iOS",
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
};

function userAgentHints(userAgent: string, touchPoints: number | undefined) {
  const hints: DeviceHints = {};
  const iosVersion = /\bOS (\d+)[_.]\d+/.exec(userAgent)?.[1];
  if (/\biPhone\b/.test(userAgent)) {
    hints.os = "iOS";
    hints.device = "iPhone";
    hints.osVersion = iosVersion;
  } else if (/\biPad\b/.test(userAgent)) {
    hints.os = "iPadOS";
    hints.device = "iPad";
    hints.osVersion = iosVersion;
  } else if (/\bMacintosh\b/.test(userAgent)) {
    // iPadOS Safari requests the desktop site with a Mac user agent.
    if ((touchPoints ?? 0) > 1) {
      hints.os = "iPadOS";
      hints.device = "iPad";
    } else {
      hints.os = "macOS";
      hints.device = "Mac";
    }
  } else if (/\bAndroid\b/.test(userAgent)) {
    hints.os = "Android";
    hints.osVersion = /\bAndroid (\d+)/.exec(userAgent)?.[1];
  } else if (/\bCrOS\b/.test(userAgent)) {
    hints.os = "ChromeOS";
  } else if (/\bWindows\b/.test(userAgent)) {
    hints.os = "Windows";
  } else if (/\bLinux\b/.test(userAgent)) {
    hints.os = "Linux";
  }
  if (/\bEdgi?A?\//.test(userAgent)) hints.browser = "Edge";
  else if (/\b(Firefox|FxiOS)\//.test(userAgent)) hints.browser = "Firefox";
  else if (/\b(Chrome|CriOS|Chromium)\//.test(userAgent))
    hints.browser = "Chrome";
  else if (/\bSafari\//.test(userAgent) || /\bAppleWebKit\//.test(userAgent))
    hints.browser = "Safari";
  return hints;
}

/**
 * Combine the request User-Agent with the hints a page reported. Client
 * values are bounded and only refine the User-Agent's coarse answer.
 */
export function deviceHintsFrom(
  userAgent: string | null | undefined,
  reported: unknown,
): DeviceHints {
  const client =
    reported && typeof reported === "object"
      ? (reported as Record<string, unknown>)
      : {};
  const touchPoints = finite(client.touch_points);
  const hints = userAgentHints(clean(userAgent, 512) ?? "", touchPoints);
  const platform = clean(client.platform)?.toLowerCase();
  if (platform && UA_CH_OS[platform] && hints.os !== "iPadOS") {
    hints.os = UA_CH_OS[platform];
  }
  const platformVersion = clean(client.platform_version);
  if (platformVersion && hints.os !== "Windows") {
    hints.osVersion = platformVersion.split(".")[0] || hints.osVersion;
  }
  const model = clean(client.model, 48);
  if (model) hints.device = model;
  const screen = client.screen as Record<string, unknown> | undefined;
  const width = finite(screen?.width);
  const height = finite(screen?.height);
  const dpr = finite(screen?.dpr);
  if (width && height) {
    const [short, long] = [width, height]
      .map((value) => Math.round(value))
      .sort((a, b) => a - b);
    hints.screen = `${short}x${long}@${dpr ? Math.round(dpr * 100) / 100 : 1}`;
  }
  const timezone = clean(client.timezone);
  if (timezone) hints.timezone = timezone;
  const language = clean(client.language, 35);
  if (language) hints.language = language;
  if (client.standalone === true) hints.standalone = true;
  for (const key of Object.keys(hints) as (keyof DeviceHints)[]) {
    if (hints[key] === undefined) delete hints[key];
  }
  return hints;
}

/** Hints strong enough to consider merging two cookie contexts. */
export function hintsAreSpecific(hints: DeviceHints | undefined) {
  return Boolean(hints?.os && hints.screen && hints.timezone);
}

function sameWhenBoth(a: string | undefined, b: string | undefined) {
  return a === undefined || b === undefined || a === b;
}

/**
 * Whether two browser contexts plausibly run on the same device: the same
 * OS, screen and time zone, and no contradicting model, OS version or
 * primary language. The browser itself may differ (Safari and its home
 * screen app, or Chrome and Firefox on one computer).
 */
export function hintsMatch(
  a: DeviceHints | undefined,
  b: DeviceHints | undefined,
) {
  if (!hintsAreSpecific(a) || !hintsAreSpecific(b) || !a || !b) return false;
  return (
    a.os === b.os &&
    a.screen === b.screen &&
    a.timezone === b.timezone &&
    sameWhenBoth(a.device, b.device) &&
    sameWhenBoth(a.osVersion, b.osVersion) &&
    sameWhenBoth(
      a.language?.split("-")[0]?.toLowerCase(),
      b.language?.split("-")[0]?.toLowerCase(),
    )
  );
}

/** A short device label such as `iPhone`, `Pixel 8` or `Windows`. */
export function deviceLabel(hints: DeviceHints | undefined): string {
  return hints?.device ?? hints?.os ?? "";
}
