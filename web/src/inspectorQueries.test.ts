import { describe, expect, test } from "bun:test";
import { isCancelledError } from "@tanstack/react-query";
import { bridge, type ConnectionClient } from "./api";
import {
  inspectorQueries,
  refreshGitDiffSummary,
  retireGitDiffSummary,
  retireGitDiffSummaryResource,
  scopedKey,
} from "./inspectorQueries";
import { publishLastStepCompletion } from "./lastStepCompletionStore";
import { appStore } from "./store/core";
import type { GitDiffSummary } from "./types";

function summary(workspaceId: string): GitDiffSummary {
  return {
    workspace_id: workspaceId,
    root: "/repo",
    entries: [],
    counts: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      branch: 0,
      "last-step": 0,
    },
  };
}

/** A client whose calls stay pending until the test answers them. */
function manualClient(connectionId: string, generation = 1) {
  const calls: Array<{
    resolve: (value: GitDiffSummary) => void;
    signal?: AbortSignal;
  }> = [];
  const client: ConnectionClient = {
    connectionId,
    generation,
    serverRuntimeGeneration: generation,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
    call: (_method, _params, options) =>
      new Promise<GitDiffSummary>((resolve) => {
        calls.push({ resolve, signal: options?.signal });
      }),
  };
  return { client, calls };
}

const summaryKey = (
  client: ConnectionClient,
  workspaceId: string,
  mode: string,
  resourceKey = workspaceId,
) => scopedKey(client, "git-diff-summary", resourceKey, workspaceId, mode);

describe("inspector git diff summaries", () => {
  test("shares a running refresh and caches its snapshot", async () => {
    const { client, calls } = manualClient("shared-summary");
    const key = summaryKey(client, "workspace", "working", "checkout:stable");
    const first = refreshGitDiffSummary(
      client,
      "workspace",
      "working",
      "checkout:stable",
    );
    const second = refreshGitDiffSummary(
      client,
      "workspace",
      "working",
      "checkout:stable",
    );
    expect(calls).toHaveLength(1);
    expect(inspectorQueries.getQueryState(key)?.fetchStatus).toBe("fetching");

    const next = summary("workspace");
    calls[0]?.resolve(next);
    expect(await first).toBe(next);
    expect(await second).toBe(next);
    expect(inspectorQueries.getQueryState(key)).toMatchObject({
      data: next,
      fetchStatus: "idle",
    });
  });

  test("a refresh after a change aborts the running request", async () => {
    const { client, calls } = manualClient("restarted-summary");
    const key = summaryKey(client, "workspace", "working");
    const initial = refreshGitDiffSummary(client, "workspace", "working");
    const restarted = refreshGitDiffSummary(
      client,
      "workspace",
      "working",
      "workspace",
      { afterCurrent: true },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls[1]?.signal?.aborted).toBe(false);

    calls[0]?.resolve(summary("stale"));
    const fresh = summary("fresh");
    calls[1]?.resolve(fresh);
    // The first caller receives the restarted result.
    expect(await initial).toBe(fresh);
    expect(await restarted).toBe(fresh);
    expect(inspectorQueries.getQueryData<GitDiffSummary>(key)).toBe(fresh);
  });

  test("retiring a resource aborts its requests and forgets its snapshots", async () => {
    const { client, calls } = manualClient("retired-summary");
    const key = summaryKey(client, "workspace", "working", "checkout:stable");
    const retired = refreshGitDiffSummary(
      client,
      "workspace",
      "working",
      "checkout:stable",
    );
    retireGitDiffSummaryResource(client, "checkout:stable");
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(isCancelledError(await retired.catch((error) => error))).toBe(true);
    expect(inspectorQueries.getQueryState(key)).toBeUndefined();

    const current = refreshGitDiffSummary(
      client,
      "workspace",
      "working",
      "checkout:stable",
    );
    calls[0]?.resolve(summary("stale"));
    const fresh = summary("workspace");
    calls[1]?.resolve(fresh);
    expect(await current).toBe(fresh);
    expect(inspectorQueries.getQueryData<GitDiffSummary>(key)).toBe(fresh);
  });

  test("a finished agent step drops only that workspace's last-step summary", async () => {
    const { client, calls } = manualClient("last-step-edge");
    const lastStep = summaryKey(client, "workspace", "last-step");
    const working = summaryKey(client, "workspace", "working");
    const other = summaryKey(client, "other", "last-step");
    const loads = [
      refreshGitDiffSummary(client, "workspace", "last-step"),
      refreshGitDiffSummary(client, "workspace", "working"),
      refreshGitDiffSummary(client, "other", "last-step"),
    ];
    for (const call of calls) call.resolve(summary("snapshot"));
    await Promise.all(loads);

    publishLastStepCompletion("last-step-edge", "workspace");
    expect(inspectorQueries.getQueryData(lastStep)).toBeUndefined();
    expect(inspectorQueries.getQueryData(working)).toBeDefined();
    expect(inspectorQueries.getQueryData(other)).toBeDefined();

    retireGitDiffSummary(client, "workspace", "working");
    expect(inspectorQueries.getQueryData(working)).toBeUndefined();
  });

  test("switching connections drops every other connection scope", async () => {
    const generation = bridge.clientGeneration;
    const active = manualClient("scope-active", generation);
    const inactive = manualClient("scope-inactive", generation);
    const loads = [
      refreshGitDiffSummary(active.client, "workspace", "working"),
      refreshGitDiffSummary(inactive.client, "workspace", "working"),
    ];
    active.calls[0]?.resolve(summary("active"));
    const pending = loads[1]!.catch((error) => error);
    const previous = appStore.getState();
    try {
      appStore.setState({ activeConnectionId: "scope-active" });
      expect(inactive.calls[0]?.signal?.aborted).toBe(true);
      expect(isCancelledError(await pending)).toBe(true);
      expect(
        inspectorQueries.getQueryData(
          summaryKey(active.client, "workspace", "working"),
        ),
      ).toBeDefined();
    } finally {
      appStore.setState(previous, true);
    }
  });
});
