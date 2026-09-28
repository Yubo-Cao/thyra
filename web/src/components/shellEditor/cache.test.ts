import { expect, test } from "bun:test";
import type { ConnectionClient } from "../../api";
import { historyCache, readDraft, refreshHistory, writeDraft } from "./cache";

test("history is fetched once for concurrent panes and scoped to the connection generation", async () => {
  let calls = 0;
  const client: ConnectionClient = {
    connectionId: "cache-test",
    generation: 1,
    serverRuntimeGeneration: 1,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
    async call() {
      calls++;
      return { entries: [] };
    },
  };
  await Promise.all([
    refreshHistory(client, "one"),
    refreshHistory(client, "two"),
  ]);
  await refreshHistory(client, "three");
  expect(calls).toBe(1);
  const reconnected = { ...client, generation: 2 };
  expect(historyCache(reconnected)).not.toBe(historyCache(client));
  await refreshHistory(reconnected, "one");
  expect(calls).toBe(2);
});
test("drafts survive editor remounts and stay separate per pane", () => {
  writeDraft("pane-a", "unfinished");
  expect(readDraft("pane-a")).toBe("unfinished");
  expect(readDraft("pane-b")).toBe("");
  writeDraft("pane-a", "");
  expect(readDraft("pane-a")).toBe("");
});
