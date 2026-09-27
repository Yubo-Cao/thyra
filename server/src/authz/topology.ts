/**
 * Where each terminal, pane and tab of one Herdr connection lives, for
 * authorization. Loaded from `pane.list` on demand, marked stale by
 * structural Herdr events and refreshed on the next lookup. Unknown ids
 * trigger at most one reload per second, so guessing ids cannot flood Herdr.
 */

export type Location = { workspace: string; pane?: string; tab?: string };

const MISS_RELOAD_INTERVAL_MS = 1000;

const STRUCTURAL_EVENT = /^(workspace|tab|pane|layout|worktree)[._]/;

export function isStructuralEvent(name: unknown): boolean {
  return typeof name === "string" && STRUCTURAL_EVENT.test(name);
}

export type Topology = ReturnType<typeof createTopology>;

export function createTopology(args: {
  listPanes: () => Promise<unknown>;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  let terminals = new Map<string, Location>();
  let panes = new Map<string, Location>();
  let tabs = new Map<string, Location>();
  let stale = true;
  let loadedAt = 0;
  let loading: Promise<void> | null = null;

  async function load() {
    const result = (await args.listPanes()) as { panes?: unknown } | null;
    const list = Array.isArray(result?.panes) ? result.panes : [];
    const nextTerminals = new Map<string, Location>();
    const nextPanes = new Map<string, Location>();
    const nextTabs = new Map<string, Location>();
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const pane = item as Record<string, unknown>;
      const workspace = pane.workspace_id;
      const paneId = pane.pane_id;
      if (typeof workspace !== "string" || !workspace) continue;
      const tab =
        typeof pane.tab_id === "string" && pane.tab_id
          ? { tab: pane.tab_id }
          : {};
      if (typeof paneId === "string" && paneId) {
        nextPanes.set(paneId, { workspace, pane: paneId, ...tab });
        if (typeof pane.terminal_id === "string" && pane.terminal_id)
          nextTerminals.set(pane.terminal_id, {
            workspace,
            pane: paneId,
            ...tab,
          });
      }
      if (typeof pane.tab_id === "string" && pane.tab_id)
        nextTabs.set(pane.tab_id, { workspace });
    }
    terminals = nextTerminals;
    panes = nextPanes;
    tabs = nextTabs;
    loadedAt = now();
  }

  function reload(): Promise<void> {
    stale = false;
    loading ??= load()
      .catch(() => {
        // Keep the previous map; the next lookup retries.
        stale = true;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  function find(target: {
    tab?: string;
    pane?: string;
    terminal?: string;
  }): Location | null {
    if (target.terminal) return terminals.get(target.terminal) ?? null;
    if (target.pane) return panes.get(target.pane) ?? null;
    if (target.tab) return tabs.get(target.tab) ?? null;
    return null;
  }

  return {
    invalidate() {
      stale = true;
    },
    /** The last loaded location, without waiting (event filtering). */
    peek(target: {
      tab?: string;
      pane?: string;
      terminal?: string;
    }): Location | null {
      return find(target);
    },
    async locate(target: {
      tab?: string;
      pane?: string;
      terminal?: string;
    }): Promise<Location | null> {
      if (loading) await loading;
      if (stale) await reload();
      const found = find(target);
      if (found || now() - loadedAt < MISS_RELOAD_INTERVAL_MS) return found;
      await reload();
      return find(target);
    },
  };
}
