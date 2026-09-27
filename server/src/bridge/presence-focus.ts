/**
 * Bridge-side presence that Herdr's collaboration API does not carry: when a
 * browser participant was last active and whom it follows. A change of focus
 * (workspace, tab, pane), activity, or follow target is announced at once as
 * a small `collaboration.focus` event carrying only ids, while full presence
 * snapshots stay throttled (see COLLABORATION_FORWARD_INTERVAL_MS).
 */

export type PresenceFocus = {
  participant_id: string;
  workspace_id?: string;
  tab_id?: string;
  pane_id?: string;
  activity: string;
  /** Presence key (person id, or `participant:<id>`) this page follows. */
  following?: string;
  /** Last focus change, typing, or return to the page. */
  active_at_unix_ms: number;
};

type Entry = { focus: PresenceFocus; seenAt: number };

/** Focus fields a snapshot takes from the bridge, present or absent. */
const FOCUS_FIELDS = [
  "workspace_id",
  "tab_id",
  "pane_id",
  "following",
] as const;

/** Params only the bridge understands; never forwarded to Herdr. */
const BRIDGE_ONLY_PARAMS = ["following"];
/** Longer than Herdr's 45 s participant lease. */
const ENTRY_TTL_MS = 60_000;

const optionalId = (value: unknown) =>
  typeof value === "string" && value && value.length <= 160 ? value : undefined;

function focusKey(focus: Omit<PresenceFocus, "active_at_unix_ms">) {
  return JSON.stringify([
    focus.workspace_id ?? null,
    focus.tab_id ?? null,
    focus.pane_id ?? null,
    focus.activity,
    focus.following ?? null,
  ]);
}

export function createPresenceFocusTracker(
  options: { now?: () => number } = {},
) {
  const now = () => options.now?.() ?? Date.now();
  const entries = new Map<string, Entry>();

  const prune = (at: number) => {
    for (const [id, entry] of entries) {
      if (at - entry.seenAt > ENTRY_TTL_MS) entries.delete(id);
    }
  };

  return {
    /**
     * Split a `collaboration.update` into Herdr's params and a `commit` that
     * records it and returns the focus when it changed, plus a `rollback` for
     * an update Herdr then rejects.
     */
    prepare(params: Record<string, unknown>) {
      const herdrParams = { ...params };
      for (const key of BRIDGE_ONLY_PARAMS) delete herdrParams[key];
      const participantId = optionalId(params.participant_id);
      const commit = (): {
        changed: PresenceFocus | null;
        rollback: () => void;
      } => {
        if (!participantId) return { changed: null, rollback: () => {} };
        const at = now();
        prune(at);
        const workspaceId = optionalId(params.workspace_id);
        const tabId = optionalId(params.tab_id);
        const paneId = optionalId(params.pane_id);
        const following = optionalId(params.following);
        const focus = {
          participant_id: participantId,
          ...(workspaceId ? { workspace_id: workspaceId } : {}),
          ...(tabId ? { tab_id: tabId } : {}),
          ...(paneId ? { pane_id: paneId } : {}),
          activity:
            params.activity === "idle" || params.activity === "away"
              ? params.activity
              : "active",
          ...(following ? { following } : {}),
        };
        const previousEntry = entries.get(participantId);
        const previous = previousEntry?.focus;
        const changed = !previous || focusKey(previous) !== focusKey(focus);
        const active =
          !previous ||
          (focus.activity === "active" && (changed || params.typing === true));
        const next: PresenceFocus = {
          ...focus,
          active_at_unix_ms: active ? at : (previous?.active_at_unix_ms ?? at),
        };
        const entry = { focus: next, seenAt: at };
        entries.set(participantId, entry);
        return {
          changed: changed ? next : null,
          rollback: () => {
            if (entries.get(participantId) !== entry) return;
            if (previousEntry) entries.set(participantId, previousEntry);
            else entries.delete(participantId);
          },
        };
      };
      return { herdrParams, commit };
    },

    forget(participantId: unknown) {
      if (typeof participantId === "string") entries.delete(participantId);
    },

    /**
     * Overlay the latest focus the bridge forwarded on a snapshot's browser
     * participants, so a snapshot captured before a focus change and delivered
     * after its `collaboration.focus` event never moves anyone back.
     */
    annotate<T>(snapshot: T): T {
      const value = snapshot as { participants?: unknown } | null;
      if (
        !value ||
        typeof value !== "object" ||
        !Array.isArray(value.participants) ||
        entries.size === 0
      )
        return snapshot;
      let changed = false;
      const participants = value.participants.map((participant) => {
        const id = (participant as { participant_id?: unknown } | null)
          ?.participant_id;
        const focus =
          typeof id === "string" ? entries.get(id)?.focus : undefined;
        if (!focus) return participant;
        changed = true;
        const next: Record<string, unknown> = {
          ...(participant as Record<string, unknown>),
          activity: focus.activity,
          active_at_unix_ms: focus.active_at_unix_ms,
        };
        for (const field of FOCUS_FIELDS) {
          if (focus[field]) next[field] = focus[field];
          else delete next[field];
        }
        return next;
      });
      return changed ? ({ ...value, participants } as T) : snapshot;
    },
  };
}

export type PresenceFocusTracker = ReturnType<
  typeof createPresenceFocusTracker
>;
