import { describe, expect, test } from "bun:test";
import { worktreeRemovalCompletionNotice } from "./worktrees";

describe("worktree removal notices", () => {
  test("reports a plain removal", () => {
    expect(worktreeRemovalCompletionNotice(undefined)).toEqual({
      kind: "success",
      message: "Worktree removed",
    });
  });

  test("summarizes stale checkout recovery", () => {
    expect(
      worktreeRemovalCompletionNotice({
        recovered_stale_checkout: true,
        terminated_processes: 2,
        preserved_path: "/work/repo.recovered",
      }),
    ).toEqual({
      kind: "success",
      message: "Worktree removed",
      detail:
        "Stopped 2 processes still using the checkout.\nStale files were preserved at /work/repo.recovered.",
    });
    expect(
      worktreeRemovalCompletionNotice({
        recovered_stale_checkout: true,
        terminated_processes: 0,
      }),
    ).toEqual({
      kind: "success",
      message: "Worktree removed",
      detail:
        "The checkout was already absent; stale Herdr state was reconciled.",
    });
  });

  test("reports a successful Herdr remove with incomplete local cleanup", () => {
    expect(
      worktreeRemovalCompletionNotice({
        terminated_processes: 0,
        warning: "process 42 survived",
      }),
    ).toEqual({
      kind: "error",
      message: "Worktree removed with cleanup warning",
      detail: "process 42 survived",
    });
  });
});
