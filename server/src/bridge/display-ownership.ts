/**
 * Which device's viewport sizes a pane (its display owner), separate from who
 * types into it (the holder of the pane's collaboration claim).
 *
 * A display owner is recorded when a browser pins a pane to its screen
 * ("Display on this device") or takes control and resizes it here. While a
 * pane has one, the terminal bridge ignores resize, relay resize, focus, and
 * attach sizes from every other device, and their input no longer claims
 * Herdr's size ownership. Panes without one keep the browser-side rules.
 *
 * A pin belongs to the device: another tab or a reload of the same device
 * keeps it, and it survives the device going idle, until the device unpins or
 * another device takes the display. An unpinned owner lasts as long as its
 * participant does. Records are bridge memory and end with the bridge.
 */

/** Who a browser socket is, as decided by the bridge. */
export type SocketIdentity = {
  participantId: string;
  /** Private device key; never sent to browsers. */
  deviceKey: string;
};

/** The public form sent to browsers in presence snapshots and events. */
export type DisplayOwner = {
  pane_id: string;
  participant_id: string;
  pinned: boolean;
  since_unix_ms: number;
};

type OwnerRecord = {
  participantId: string;
  deviceKey: string;
  pinned: boolean;
  since: number;
};

const MAX_PANE_ID_LENGTH = 256;
const MAX_OWNERS = 512;

export function validDisplayPaneId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PANE_ID_LENGTH
    ? value
    : null;
}

export function createDisplayOwnership(
  options: {
    now?: () => number;
    /** The owner list changed; announce it to browsers. */
    onChange?: (owners: DisplayOwner[]) => void;
  } = {},
) {
  const now = () => options.now?.() ?? Date.now();
  const owners = new Map<string, OwnerRecord>();

  const list = (): DisplayOwner[] =>
    Array.from(owners, ([paneId, owner]) => ({
      pane_id: paneId,
      participant_id: owner.participantId,
      pinned: owner.pinned,
      since_unix_ms: owner.since,
    })).sort((a, b) => a.pane_id.localeCompare(b.pane_id));

  const changed = () => options.onChange?.(list());

  return {
    /** Whether any pane has a display owner; enforcement is skipped otherwise. */
    active(): boolean {
      return owners.size > 0;
    },

    owner(paneId: string): DisplayOwner | null {
      const owner = owners.get(paneId);
      return owner
        ? {
            pane_id: paneId,
            participant_id: owner.participantId,
            pinned: owner.pinned,
            since_unix_ms: owner.since,
          }
        : null;
    },

    list,

    /** `authorize` without following a pinned device to a newer page. */
    permits(paneId: string | null, who: SocketIdentity | null): boolean {
      if (!paneId) return true;
      const owner = owners.get(paneId);
      if (!owner) return true;
      return (
        !!who &&
        (owner.participantId === who.participantId ||
          owner.deviceKey === who.deviceKey)
      );
    },

    /**
     * Whether `who` may size (resize, focus, attach at its viewport, claim
     * Herdr's size owner by typing) the pane. Panes without an owner, and
     * terminals without a pane, are unrestricted.
     */
    authorize(paneId: string | null, who: SocketIdentity | null): boolean {
      if (!paneId) return true;
      const owner = owners.get(paneId);
      if (!owner) return true;
      if (!who) return false;
      if (owner.participantId === who.participantId) return true;
      if (owner.deviceKey !== who.deviceKey) return false;
      // A reload or another tab of the pinned device: follow its newest page
      // so browsers see which participant now displays the pane.
      if (owner.pinned) {
        owner.participantId = who.participantId;
        changed();
      }
      return true;
    },

    /** Make `who` the display owner, replacing any other device. */
    claim(paneId: string, who: SocketIdentity, pinned: boolean): DisplayOwner {
      const previous = owners.get(paneId);
      if (!previous && owners.size >= MAX_OWNERS) {
        // Bounded: forget the oldest record rather than grow without limit.
        const oldest = owners.keys().next().value;
        if (oldest !== undefined) owners.delete(oldest);
      }
      const same =
        previous?.participantId === who.participantId &&
        previous.deviceKey === who.deviceKey &&
        previous.pinned === pinned;
      const record: OwnerRecord = {
        participantId: who.participantId,
        deviceKey: who.deviceKey,
        pinned,
        since:
          previous && previous.deviceKey === who.deviceKey
            ? previous.since
            : now(),
      };
      owners.set(paneId, record);
      if (!same) changed();
      return {
        pane_id: paneId,
        participant_id: record.participantId,
        pinned,
        since_unix_ms: record.since,
      };
    },

    /** Drop the pane's owner; only the owning device may. */
    release(paneId: string, who: SocketIdentity): boolean {
      const owner = owners.get(paneId);
      if (
        !owner ||
        (owner.participantId !== who.participantId &&
          owner.deviceKey !== who.deviceKey)
      )
        return false;
      owners.delete(paneId);
      changed();
      return true;
    },

    /** A participant left: its unpinned displays end with it. */
    forgetParticipant(participantId: unknown) {
      if (typeof participantId !== "string") return;
      let removed = false;
      for (const [paneId, owner] of owners) {
        if (!owner.pinned && owner.participantId === participantId) {
          owners.delete(paneId);
          removed = true;
        }
      }
      if (removed) changed();
    },

    /**
     * Reconcile with a presence snapshot: unpinned owners whose participant
     * is no longer present (its lease expired) end.
     */
    observeParticipants(snapshot: unknown) {
      const participants = (snapshot as { participants?: unknown } | null)
        ?.participants;
      if (!Array.isArray(participants) || owners.size === 0) return;
      const present = new Set<string>();
      for (const participant of participants) {
        const id = (participant as { participant_id?: unknown } | null)
          ?.participant_id;
        if (typeof id === "string") present.add(id);
      }
      let removed = false;
      for (const [paneId, owner] of owners) {
        if (!owner.pinned && !present.has(owner.participantId)) {
          owners.delete(paneId);
          removed = true;
        }
      }
      if (removed) changed();
    },

    /** Add `display_owners` to a presence snapshot. */
    annotate<T>(snapshot: T): T {
      if (
        !snapshot ||
        typeof snapshot !== "object" ||
        !Array.isArray((snapshot as { participants?: unknown }).participants)
      )
        return snapshot;
      return { ...snapshot, display_owners: list() } as T;
    },

    clear() {
      owners.clear();
    },
  };
}

export type DisplayOwnership = ReturnType<typeof createDisplayOwnership>;
