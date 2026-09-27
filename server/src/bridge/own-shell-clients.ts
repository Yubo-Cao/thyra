import { type Logger, silentLogger } from "../utils/logger";

/**
 * Herdr registers every active client-socket shell as a collaboration
 * participant named `tui:<client id>`. The bridge's own endpoint connections
 * (terminal sessions and the popup observer) are such shells, so without this
 * registry every browser would count them as extra "Herdr TUI" collaborators.
 *
 * Herdr does not tell a shell its client id, so the id is learned from the
 * handshake itself: Herdr registers the participant while it handles the
 * shell's hello, before any later control request. A `collaboration.list`
 * before the connect and another after it therefore bracket the new id.
 * Concurrent handshakes of this bridge may share a window; a window claims
 * its new ids only when there are no more of them than bridge handshakes in
 * flight, so a real client attaching at the same instant is never hidden
 * behind a guess.
 */

const TUI_PARTICIPANT_PREFIX = "tui:";
// Ids are never reused within one Herdr boot; this only bounds memory.
const MAX_OWN_IDS = 4096;

type ParticipantLike = { participant_id?: unknown };
type ClaimLike = { participant_id?: unknown };
type SnapshotLike = {
  participants?: ParticipantLike[];
  pane_claims?: ClaimLike[];
};

export type OwnShellClients = {
  /**
   * Run one endpoint handshake and attribute the Herdr participant it creates
   * to this bridge. `connect` resolves with the endpoint boot id.
   */
  track(connect: () => Promise<string | undefined>): Promise<void>;
  isOwn(participantId: unknown): boolean;
  /** Remove this bridge's own shells from a collaboration snapshot. */
  filterSnapshot<T>(snapshot: T): T;
  /** Called with Herdr's newest raw snapshot whenever own ids are learned. */
  onChange(listener: (snapshot: unknown) => void): () => void;
};

function snapshotOf(result: unknown): SnapshotLike | null {
  const snapshot = (result as { snapshot?: unknown } | null)?.snapshot;
  return snapshot && typeof snapshot === "object"
    ? (snapshot as SnapshotLike)
    : null;
}

function tuiParticipantIds(snapshot: SnapshotLike | null): Set<string> {
  const ids = new Set<string>();
  for (const participant of snapshot?.participants ?? []) {
    const id = participant?.participant_id;
    if (typeof id === "string" && id.startsWith(TUI_PARTICIPANT_PREFIX))
      ids.add(id);
  }
  return ids;
}

function collaborationUnsupported(error: unknown) {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    message.includes("unknown") ||
    message === "invalid response envelope from herdr"
  );
}

export function createOwnShellClients(args: {
  /** Herdr `collaboration.list` over the control socket. */
  list: () => Promise<unknown>;
  logger?: Logger;
}): OwnShellClients {
  const logger = args.logger ?? silentLogger;
  const own = new Set<string>();
  const listeners = new Set<(snapshot: unknown) => void>();
  const windows = new Set<{ overlap: number }>();
  let bootId: string | undefined;
  let unsupported = false;

  const isOwn = (participantId: unknown) =>
    typeof participantId === "string" && own.has(participantId);

  function observeBoot(nextBootId: string | undefined) {
    if (!nextBootId || nextBootId === bootId) return;
    // A restarted Herdr numbers its clients from 1 again.
    if (bootId) own.clear();
    bootId = nextBootId;
  }

  function claim(ids: string[]) {
    for (const id of ids) {
      own.delete(id);
      own.add(id);
    }
    while (own.size > MAX_OWN_IDS) {
      const oldest = own.values().next().value;
      if (oldest === undefined) break;
      own.delete(oldest);
    }
  }

  async function settle(
    window: { overlap: number },
    before: Set<string>,
    endpointBootId: string | undefined,
  ) {
    try {
      const result = await args.list();
      observeBoot(endpointBootId);
      const fresh = [...tuiParticipantIds(snapshotOf(result))].filter(
        (id) => !before.has(id) && !own.has(id),
      );
      if (fresh.length === 0) return;
      if (fresh.length > window.overlap) {
        logger.debug("own shell participant is ambiguous", {
          candidates: fresh.length,
          handshakes: window.overlap,
        });
        return;
      }
      claim(fresh);
      for (const listener of listeners) listener(result);
    } catch (error) {
      if (collaborationUnsupported(error)) unsupported = true;
    } finally {
      windows.delete(window);
    }
  }

  return {
    async track(connect) {
      if (unsupported) {
        await connect();
        return;
      }
      const window = { overlap: windows.size + 1 };
      for (const other of windows) other.overlap += 1;
      windows.add(window);
      let before: Set<string> | null = null;
      try {
        before = tuiParticipantIds(snapshotOf(await args.list()));
      } catch (error) {
        if (collaborationUnsupported(error)) unsupported = true;
      }
      let endpointBootId: string | undefined;
      try {
        endpointBootId = await connect();
      } catch (error) {
        windows.delete(window);
        throw error;
      }
      if (!before) {
        windows.delete(window);
        return;
      }
      // Attribution never delays the terminal; the caller gets its shell now.
      void settle(window, before, endpointBootId);
    },
    isOwn,
    filterSnapshot<T>(snapshot: T): T {
      const value = snapshot as SnapshotLike | null;
      if (own.size === 0 || !value || typeof value !== "object")
        return snapshot;
      const participants = Array.isArray(value.participants)
        ? value.participants.filter(
            (participant) => !isOwn(participant?.participant_id),
          )
        : value.participants;
      const claims = Array.isArray(value.pane_claims)
        ? value.pane_claims.filter((claim) => !isOwn(claim?.participant_id))
        : value.pane_claims;
      return {
        ...value,
        ...(participants ? { participants } : {}),
        ...(claims ? { pane_claims: claims } : {}),
      } as T;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Several connection profiles may name the same Herdr (for example the
 * environment-configured default and a saved local profile). Each runtime
 * opens its own shells, so they share one registry per client socket and
 * every runtime hides the others' shells too.
 */
const sharedRegistries = new Map<
  string,
  { clients: OwnShellClients; lists: Set<() => Promise<unknown>> }
>();

export function acquireOwnShellClients(
  clientSocketPath: string,
  list: () => Promise<unknown>,
  logger?: Logger,
): { clients: OwnShellClients; release: () => void } {
  let entry = sharedRegistries.get(clientSocketPath);
  if (!entry) {
    const lists = new Set<() => Promise<unknown>>();
    entry = {
      lists,
      clients: createOwnShellClients({
        list: () => {
          const first = lists.values().next().value;
          return first
            ? first()
            : Promise.reject(new Error("no Herdr control connection"));
        },
        logger,
      }),
    };
    sharedRegistries.set(clientSocketPath, entry);
  }
  const current = entry;
  current.lists.add(list);
  let released = false;
  return {
    clients: current.clients,
    release() {
      if (released) return;
      released = true;
      current.lists.delete(list);
      if (
        current.lists.size === 0 &&
        sharedRegistries.get(clientSocketPath) === current
      ) {
        sharedRegistries.delete(clientSocketPath);
      }
    },
  };
}
