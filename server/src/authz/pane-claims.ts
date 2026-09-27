import type { PaneClaim } from "./authorize";

/**
 * The bridge's view of pane claims on one connection, for single-writer
 * checks. Herdr (or the bridge-local fallback) owns claims; this mirror is
 * replaced by every full collaboration snapshot and updated at once by the
 * results of claim, release and leave calls made through this bridge.
 */

type Entry = PaneClaim & { expiresAt: number };

export type ClaimTracker = ReturnType<typeof createClaimTracker>;

export function createClaimTracker(now: () => number = Date.now) {
  let claims = new Map<string, Entry>();

  function entry(value: unknown): [string, Entry] | null {
    if (!value || typeof value !== "object") return null;
    const claim = value as Record<string, unknown>;
    if (
      typeof claim.pane_id !== "string" ||
      typeof claim.participant_id !== "string"
    )
      return null;
    return [
      claim.pane_id,
      {
        participantId: claim.participant_id,
        expiresAt:
          typeof claim.expires_at_unix_ms === "number"
            ? claim.expires_at_unix_ms
            : Number.POSITIVE_INFINITY,
        ...(typeof claim.protected_until_unix_ms === "number"
          ? { protectedUntil: claim.protected_until_unix_ms }
          : {}),
      },
    ];
  }

  return {
    /** Replace the mirror with a full presence snapshot's claims. */
    observeSnapshot(snapshot: unknown) {
      const list = (snapshot as { pane_claims?: unknown } | null)?.pane_claims;
      if (!Array.isArray(list)) return;
      const next = new Map<string, Entry>();
      for (const item of list) {
        const parsed = entry(item);
        if (parsed) next.set(parsed[0], parsed[1]);
      }
      claims = next;
    },

    /** Apply a collaboration RPC result the bridge received. */
    observeResult(
      method: string,
      params: Record<string, unknown>,
      result: unknown,
    ) {
      const value = result as Record<string, unknown> | null;
      if (value?.snapshot) this.observeSnapshot(value.snapshot);
      if (method === "collaboration.claim" && value?.granted === true) {
        const parsed = entry(value.claim);
        if (parsed) claims.set(parsed[0], parsed[1]);
      } else if (
        method === "collaboration.release" &&
        value?.released === true &&
        typeof params.pane_id === "string"
      ) {
        claims.delete(params.pane_id);
      } else if (method === "collaboration.leave") {
        for (const [pane, claim] of claims)
          if (claim.participantId === params.participant_id)
            claims.delete(pane);
      }
    },

    get(paneId: string): PaneClaim | null {
      const claim = claims.get(paneId);
      if (!claim) return null;
      if (claim.expiresAt <= now()) {
        claims.delete(paneId);
        return null;
      }
      return {
        participantId: claim.participantId,
        ...(claim.protectedUntil !== undefined
          ? { protectedUntil: claim.protectedUntil }
          : {}),
      };
    },
  };
}
