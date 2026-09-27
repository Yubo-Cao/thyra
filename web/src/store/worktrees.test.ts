import { describe, expect, test } from "bun:test";
import {
  summarizeDirectHookResult,
  worktreeRemovalCompletionNotice,
} from "./worktrees";

describe("worktree hook notices", () => {
  test("dismisses successful hook output after a short actionable window", () => {
    expect(
      summarizeDirectHookResult({
        event: "worktree.created",
        status: "succeeded",
        stdout: "configured checkout",
      }),
    ).toMatchObject({
      kind: "success",
      autoDismissMs: 15_000,
    });
  });

  test("leaves failed hooks on the shared default timeout", () => {
    const notice = summarizeDirectHookResult({
      event: "worktree.before_remove",
      status: "failed",
      exit_code: 1,
      stderr: "cleanup failed",
    });
    expect(notice).toMatchObject({ kind: "error" });
    expect(notice?.autoDismissMs).toBeUndefined();
  });
});

describe("worktree removal notices", () => {
  test("keeps a removed-hook failure visible after stale checkout recovery", () => {
    expect(
      worktreeRemovalCompletionNotice(
        {
          recovered_stale_checkout: true,
          terminated_processes: 2,
          preserved_path: "/work/repo.recovered",
        },
        {
          kind: "error",
          message: "Worktree removed hook failed (exit 1)",
          detail: "cleanup failed",
          detailMode: "output",
          detailTitle: "Worktree removed hook output",
        },
      ),
    ).toEqual({
      kind: "error",
      message: "Worktree removed hook failed (exit 1)",
      detail:
        "cleanup failed\nStopped 2 processes still using the checkout.\nStale files were preserved at /work/repo.recovered.",
      detailMode: "output",
      detailTitle: "Worktree removal details",
    });
  });

  test("summarizes recovery when no removed hook ran", () => {
    expect(
      worktreeRemovalCompletionNotice(
        {
          recovered_stale_checkout: true,
          terminated_processes: 0,
        },
        null,
      ),
    ).toEqual({
      kind: "success",
      message: "Worktree removed",
      detail:
        "The checkout was already absent; stale Herdr state was reconciled.",
    });
  });

  test("reports a successful Herdr remove with incomplete local cleanup", () => {
    expect(
      worktreeRemovalCompletionNotice(
        {
          terminated_processes: 0,
          warning: "process 42 survived",
        },
        {
          kind: "success",
          message: "Worktree removed hook completed",
        },
      ),
    ).toEqual({
      kind: "error",
      message: "Worktree removed with cleanup warning",
      detail: "Worktree removed hook completed\nprocess 42 survived",
      detailTitle: "Worktree removal details",
    });
  });
});
