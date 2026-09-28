import type { ConnectionClient } from "../../api";
import type {
  ShellHistoryEntry,
  ShellHistoryResult,
} from "../../../../shared/shell";

type Cache = {
  entries: ShellHistoryEntry[];
  loaded: number;
  pending?: Promise<void>;
};
const caches = new Map<string, Cache>();
export function historyCache(client: ConnectionClient) {
  const key = JSON.stringify([
    client.connectionId,
    client.generation,
    client.serverRuntimeGeneration,
  ]);
  let cache = caches.get(key);
  if (!cache) {
    cache = { entries: [], loaded: 0 };
    caches.set(key, cache);
  }
  return cache;
}
export function refreshHistory(client: ConnectionClient, pane: string) {
  const cache = historyCache(client);
  if (cache.pending) return cache.pending;
  if (Date.now() - cache.loaded < 60_000) return Promise.resolve();
  cache.pending = client
    .call("shell.history", { pane_id: pane, latest: true, limit: 2000 })
    .then((result: ShellHistoryResult) => {
      if (!client.isCurrent()) return;
      cache.entries = [...cache.entries, ...result.entries]
        .sort((a, b) => b.start_ts - a.start_ts)
        .filter(
          (entry, index, all) =>
            all.findIndex(
              (e) => e.command === entry.command && e.cwd === entry.cwd,
            ) === index,
        )
        .slice(0, 2000);
      cache.loaded = Date.now();
    })
    .finally(() => {
      cache.pending = undefined;
    });
  return cache.pending;
}
const drafts = new Map<string, string>();
export const readDraft = (key: string) => drafts.get(key) ?? "";
export function writeDraft(key: string, text: string) {
  if (text) drafts.set(key, text);
  else drafts.delete(key);
}
