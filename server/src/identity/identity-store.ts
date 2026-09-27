import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assertSafeDataPath, defaultDataFile } from "../config/data-paths";
import { type Logger, silentLogger } from "../utils/logger";
import type { DeviceHints } from "./device-hints";

/**
 * Server-side identity state: browser device records (keyed by the
 * HttpOnly device cookie) and collaboration profiles (keyed by person or
 * device). Client addresses are stored only as keyed hashes. The file never
 * leaves this server.
 */

export type DeviceRecord = {
  createdAt: number;
  lastSeenAt: number;
  /** Another device this browser context was matched to. */
  aliasOf?: string;
  /** Keyed hash of the last client address and when it was seen. */
  addressHash?: string;
  addressSeenAt?: number;
  hints?: DeviceHints;
};

export type ProfileRecord = {
  displayName?: string;
  color?: string;
  updatedAt: number;
};

type IdentityData = {
  version: 1;
  secret: string;
  devices: Record<string, DeviceRecord>;
  profiles: Record<string, ProfileRecord>;
};

const DEVICE_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_DEVICES = 5000;
const MAX_PROFILES = 2000;
const WRITE_DELAY_MS = 2000;

export function identityStorePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.THYRA_IDENTITY_PATH?.trim();
  if (override) {
    assertSafeDataPath(override);
    return override;
  }
  return defaultDataFile("identities.json");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalize(raw: unknown, now: number): IdentityData {
  const root = object(raw);
  const secret =
    typeof root.secret === "string" && /^[0-9a-f]{64}$/.test(root.secret)
      ? root.secret
      : randomBytes(32).toString("hex");
  const devices: Record<string, DeviceRecord> = {};
  const entries = Object.entries(object(root.devices))
    .map(([id, value]) => [id, object(value)] as const)
    .filter(
      ([id, value]) =>
        /^[A-Za-z0-9_-]{16,64}$/.test(id) &&
        numberOr(value.lastSeenAt, 0) > now - DEVICE_RETENTION_MS,
    )
    .sort(
      ([, a], [, b]) => numberOr(b.lastSeenAt, 0) - numberOr(a.lastSeenAt, 0),
    )
    .slice(0, MAX_DEVICES);
  for (const [id, value] of entries) {
    devices[id] = {
      createdAt: numberOr(value.createdAt, now),
      lastSeenAt: numberOr(value.lastSeenAt, now),
      ...(typeof value.aliasOf === "string" ? { aliasOf: value.aliasOf } : {}),
      ...(typeof value.addressHash === "string"
        ? {
            addressHash: value.addressHash,
            addressSeenAt: numberOr(value.addressSeenAt, 0),
          }
        : {}),
      ...(value.hints && typeof value.hints === "object"
        ? { hints: value.hints as DeviceHints }
        : {}),
    };
  }
  // Drop aliases whose target was pruned.
  for (const record of Object.values(devices)) {
    if (record.aliasOf && !devices[record.aliasOf]) delete record.aliasOf;
  }
  const profiles: Record<string, ProfileRecord> = {};
  for (const [key, value] of Object.entries(object(root.profiles)).slice(
    0,
    MAX_PROFILES,
  )) {
    const record = object(value);
    profiles[key] = {
      ...(typeof record.displayName === "string"
        ? { displayName: record.displayName.slice(0, 80) }
        : {}),
      ...(typeof record.color === "string" &&
      /^#[0-9a-f]{6}$/i.test(record.color)
        ? { color: record.color }
        : {}),
      updatedAt: numberOr(record.updatedAt, now),
    };
  }
  return { version: 1, secret, devices, profiles };
}

export type IdentityStore = ReturnType<typeof createIdentityStore>;

export function createIdentityStore(
  args: { path?: string | null; now?: () => number; logger?: Logger } = {},
) {
  const now = args.now ?? Date.now;
  const logger = args.logger ?? silentLogger;
  const path = args.path ?? null;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let raw: unknown = null;
  if (path) {
    try {
      assertSafeDataPath(path);
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn("identity store unreadable; starting a new one", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const data: IdentityData = normalize(raw, now());
  if (path && !raw) dirty = true;

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty || !path) return;
    dirty = false;
    const temporary = join(
      dirname(path),
      `.identities-${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      assertSafeDataPath(path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      logger.warn("identity store write failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function changed(immediate = false) {
    dirty = true;
    if (immediate) return flush();
    if (timer) return;
    timer = setTimeout(flush, WRITE_DELAY_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  function rootId(id: string): string {
    let current = id;
    for (let hops = 0; hops < 8; hops += 1) {
      const next = data.devices[current]?.aliasOf;
      if (!next || next === id) return current;
      current = next;
    }
    return current;
  }

  return {
    get secret() {
      return data.secret;
    },
    device(id: string): DeviceRecord | undefined {
      return data.devices[id];
    },
    devices(): Iterable<[string, DeviceRecord]> {
      return Object.entries(data.devices);
    },
    /** Create or refresh a device record. */
    touchDevice(
      id: string,
      update: { addressHash?: string; hints?: DeviceHints } = {},
    ): DeviceRecord {
      const at = now();
      const existing = data.devices[id];
      const record: DeviceRecord = existing ?? {
        createdAt: at,
        lastSeenAt: at,
      };
      const hintsChanged =
        update.hints !== undefined &&
        JSON.stringify(update.hints) !== JSON.stringify(record.hints);
      const addressChanged =
        update.addressHash !== undefined &&
        update.addressHash !== record.addressHash;
      const stale = at - record.lastSeenAt > 60_000;
      record.lastSeenAt = at;
      if (update.addressHash !== undefined) {
        record.addressHash = update.addressHash;
        record.addressSeenAt = at;
      }
      if (update.hints !== undefined) record.hints = update.hints;
      data.devices[id] = record;
      if (!existing || hintsChanged || addressChanged || stale) changed();
      return record;
    },
    rootId,
    alias(id: string, target: string) {
      const record = data.devices[id];
      const root = rootId(target);
      if (!record || root === id) return;
      record.aliasOf = root;
      changed(true);
    },
    profile(key: string): ProfileRecord | undefined {
      return data.profiles[key];
    },
    setProfile(key: string, profile: Omit<ProfileRecord, "updatedAt">) {
      data.profiles[key] = { ...profile, updatedAt: now() };
      changed(true);
    },
    flush,
  };
}
