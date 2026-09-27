import { createStore, useStore } from "zustand";

/** Completed agent steps per connection and workspace, as revisions. */
export const lastStepCompletions = createStore<Record<string, number>>()(
  () => ({}),
);

export function lastStepCompletionKey(
  connectionId: string,
  workspaceId: string | undefined,
) {
  return `${connectionId}\u0000${workspaceId ?? ""}`;
}

export function publishLastStepCompletion(
  connectionId: string,
  workspaceId: string,
) {
  const key = lastStepCompletionKey(connectionId, workspaceId);
  lastStepCompletions.setState((revisions) => ({
    [key]: (revisions[key] ?? 0) + 1,
  }));
}

export function useLastStepCompletion(key: string) {
  return useStore(lastStepCompletions, (revisions) => revisions[key] ?? 0);
}
