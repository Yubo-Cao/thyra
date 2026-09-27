import { hintsMatch } from "./device-hints";
import type { DeviceRecord } from "./identity-store";

/** A new cookie context may join an existing device only this soon after creation. */
export const MERGE_FRESH_MS = 10 * 60_000;
/** The existing device must have used the same address this recently. */
export const MERGE_WINDOW_MS = 12 * 60 * 60_000;

/**
 * Pick the existing device a new browser context belongs to, for contexts
 * that cannot share cookies (an iOS home screen app and Safari, or two
 * browsers on one computer). All of these must hold:
 *
 * - the context's cookie is new (created within `MERGE_FRESH_MS`) and not
 *   already matched, so two long-lived devices are never merged later;
 * - the candidate used the same client address within `MERGE_WINDOW_MS`;
 * - OS, screen, time zone (and model, OS version, language when both
 *   report them) match;
 * - exactly one device qualifies. Several identical phones behind one NAT
 *   are ambiguous and stay separate.
 *
 * The same address alone never merges: home and office NATs share one
 * public address among many devices. This is a medium-confidence match.
 */
export function chooseMergeTarget(args: {
  deviceId: string;
  device: DeviceRecord;
  addressHash: string | undefined;
  devices: Iterable<[string, DeviceRecord]>;
  rootId: (id: string) => string;
  now: number;
  freshMs?: number;
  windowMs?: number;
}): string | null {
  const { device, addressHash, now } = args;
  if (!addressHash || device.aliasOf) return null;
  if (now - device.createdAt > (args.freshMs ?? MERGE_FRESH_MS)) return null;
  const windowStart = now - (args.windowMs ?? MERGE_WINDOW_MS);
  const roots = new Set<string>();
  for (const [id, candidate] of args.devices) {
    if (id === args.deviceId) continue;
    if (candidate.addressHash !== addressHash) continue;
    if ((candidate.addressSeenAt ?? 0) < windowStart) continue;
    if (!hintsMatch(device.hints, candidate.hints)) continue;
    const root = args.rootId(id);
    if (root !== args.deviceId) roots.add(root);
  }
  return roots.size === 1 ? [...roots][0] : null;
}
