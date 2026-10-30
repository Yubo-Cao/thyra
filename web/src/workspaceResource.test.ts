import { defaultShortcutBindings } from "./shortcutBindings";
import { describe, expect, test } from "bun:test";
import type { Workspace } from "./types";
import {
  checkoutKeyForWorkspace,
  inspectorMaximumSize,
  isWorkspaceInspectorShortcut as resolveShortcut,
  INSPECTOR_SEPARATOR_SIZE,
  readInspectorPreferences,
  relativePathWithinCheckout,
  resourceOwnerKey,
  resourceScopeForWorkspace,
  resourceStateKey,
  resolveWorkspaceForScope,
  sameResourceOwner,
  writeInspectorPreferences,
  type WorkspaceInspectorState,
} from "./workspaceResource";

const isWorkspaceInspectorShortcut = (
  event: Parameters<typeof resolveShortcut>[0],
) => resolveShortcut(event, defaultShortcutBindings("mac"));

function workspace(
  workspaceId: string,
  checkoutPath?: string,
  settingsKey?: string,
): Workspace {
  return {
    workspace_id: workspaceId,
    number: 1,
    label: workspaceId,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    agent_status: "unknown",
    ...(checkoutPath
      ? {
          worktree: {
            repo_key: "repo-key",
            repo_name: "repo",
            repo_root: "/repo",
            checkout_path: checkoutPath,
            is_linked_worktree: checkoutPath !== "/repo",
            gui_settings_key: settingsKey ?? "local:repo-key",
          },
        }
      : {}),
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

describe("workspace inspector shortcuts", () => {
  const event = (overrides: Partial<KeyboardEvent> = {}) => ({
    key: "B",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
    repeat: false,
    ...overrides,
  });

  test("recognizes Cmd+Shift+B without colliding with sidebar or Ctrl shortcuts", () => {
    expect(isWorkspaceInspectorShortcut(event())).toBe(true);
    expect(isWorkspaceInspectorShortcut(event({ shiftKey: false }))).toBe(
      false,
    );
    expect(
      isWorkspaceInspectorShortcut(
        event({ metaKey: false, ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    expect(isWorkspaceInspectorShortcut(event({ repeat: true }))).toBe(false);
  });
});

describe("workspace inspector geometry", () => {
  test("preserves terminal minimums at the dock boundary", () => {
    const inspector = inspectorMaximumSize("right", 1000, 800);
    expect(inspector).toBe(513);
    expect(1000 - inspector - INSPECTOR_SEPARATOR_SIZE).toBe(480);
    expect(inspectorMaximumSize("bottom", 1000, 600)).toBe(353);
  });
});

describe("workspace resource scope", () => {
  test("isolates main and sibling worktrees even with the same repository settings key", () => {
    const storage = memoryStorage();
    const main = resourceScopeForWorkspace("local", workspace("main", "/repo"));
    const auth = resourceScopeForWorkspace(
      "local",
      workspace("auth", "/repo/.worktrees/auth"),
    );
    const docs = resourceScopeForWorkspace(
      "local",
      workspace("docs", "/repo/.worktrees/docs"),
    );
    expect(new Set([main, auth, docs].map(resourceStateKey)).size).toBe(3);

    writeInspectorPreferences(storage, {
      scope: auth,
      open: true,
      dock: "bottom",
      size: 410,
      expanded: false,
    });
    expect(readInspectorPreferences(storage, main)).toMatchObject({
      dock: "right",
    });
    expect(readInspectorPreferences(storage, docs)).toMatchObject({
      dock: "right",
    });
  });

  test("does not rebind a closed worktree to a sibling or a reused workspace id", () => {
    const original = workspace("auth", "/repo/.worktrees/auth");
    const scope = resourceScopeForWorkspace("local", original);
    const main = workspace("main", "/repo");
    const reused = workspace("auth", "/repo/.worktrees/docs");
    expect(resolveWorkspaceForScope(scope, [main, reused])).toBeUndefined();
    const reopened = workspace("reopened", "/repo/.worktrees/auth/");
    expect(resolveWorkspaceForScope(scope, [main, reused, reopened])).toBe(
      reopened,
    );
  });

  test("preserves endpoint identity while normalizing checkout separators", () => {
    const first = workspace("first", "C:\\repo\\wt\\", " local:repo-key ");
    const second = workspace("second", "C:/repo/wt/", "local:repo-key");
    expect(
      sameResourceOwner(
        resourceScopeForWorkspace("local", first),
        resourceScopeForWorkspace("local", second),
      ),
    ).toBe(true);
  });

  test("falls back stably for missing settings keys without aliasing enriched identity", () => {
    const first = workspace("first", "/repo/");
    first.worktree!.gui_settings_key = undefined;
    first.worktree!.repo_key = " repo-key ";
    const reopened = workspace("reopened", "/repo", "   ");
    expect(checkoutKeyForWorkspace(first)).toBe(
      JSON.stringify(["repo-key", "/repo"]),
    );
    expect(checkoutKeyForWorkspace(reopened)).toBe(
      checkoutKeyForWorkspace(first),
    );
    const unknown = resourceScopeForWorkspace("ssh-profile", first);

    reopened.worktree!.gui_settings_key =
      "connection:ssh-profile:ssh:host-a:repo-key";
    const enriched = resourceScopeForWorkspace("ssh-profile", reopened);
    expect(sameResourceOwner(unknown, enriched)).toBe(false);
  });

  test("uses workspace scope when worktree or required checkout identity is missing", () => {
    expect(resourceScopeForWorkspace("local", workspace("plain"))).toEqual({
      kind: "workspace",
      connectionId: "local",
      workspaceId: "plain",
    });
    const emptyPath = workspace("empty-path", "   ");
    expect(checkoutKeyForWorkspace(emptyPath)).toBeNull();
    const emptyRepo = workspace("empty-repo", "/repo", "   ");
    emptyRepo.worktree!.repo_key = "   ";
    expect(checkoutKeyForWorkspace(emptyRepo)).toBeNull();
  });

  test("isolates persisted state across a repointed SSH profile and restores it after reconnect", () => {
    const storage = memoryStorage();
    const hostWorkspace = (id: string, host: string, path = "/repo") =>
      workspace(id, path, `connection:ssh-profile:ssh:${host}:repo-key`);
    const hostA = hostWorkspace("w1", "host-a");
    // Profile replacement can reuse both the profile and runtime workspace IDs.
    const hostB = hostWorkspace("w1", "host-b");
    const scopeA = resourceScopeForWorkspace("ssh-profile", hostA);
    const scopeB = resourceScopeForWorkspace("ssh-profile", hostB);

    writeInspectorPreferences(storage, {
      scope: scopeA,
      open: true,
      dock: "bottom",
      size: 410,
      expanded: false,
    });

    const sibling = resourceScopeForWorkspace(
      "ssh-profile",
      hostWorkspace("linked", "host-a", "/repo/.worktrees/auth"),
    );
    for (const isolated of [scopeB, sibling]) {
      expect(readInspectorPreferences(storage, isolated)).toMatchObject({
        dock: "right",
      });
      expect(sameResourceOwner(scopeA, isolated)).toBe(false);
      expect(resourceStateKey(scopeA)).not.toBe(resourceStateKey(isolated));
    }
    expect(resolveWorkspaceForScope(scopeA, [hostB])).toBeUndefined();

    // Reconstruct scopes as after reconnect/restart; runtime workspace IDs may change.
    for (const id of ["w1", "restarted-workspace"]) {
      const reopened = hostWorkspace(id, "host-a", "/repo/");
      const restored = resourceScopeForWorkspace("ssh-profile", reopened);
      expect(sameResourceOwner(scopeA, restored)).toBe(true);
      expect(resolveWorkspaceForScope(scopeA, [hostB, reopened])).toBe(
        reopened,
      );

      expect(readInspectorPreferences(storage, restored)).toMatchObject({
        dock: "bottom",
        bottomSize: 410,
      });
    }
  });

  test("encodes repository and checkout paths without delimiter collisions", () => {
    const first = workspace("first", "/wt");
    first.worktree!.repo_key = "repo:x";
    first.worktree!.gui_settings_key = "local:repo:x";
    const second = workspace("second", "x:/wt");
    second.worktree!.repo_key = "repo";
    second.worktree!.gui_settings_key = "local:repo";
    expect(checkoutKeyForWorkspace(first)).not.toBe(
      checkoutKeyForWorkspace(second),
    );
  });

  test("does not restore ambiguous legacy repository-wide state", () => {
    const storage = memoryStorage();
    const scope = resourceScopeForWorkspace(
      "legacy-default",
      workspace("auth", "/repo/.worktrees/auth"),
    );
    storage.setItem(
      "workspaceInspector:checkout:local:repo-key",
      JSON.stringify({ dock: "bottom" }),
    );

    expect(readInspectorPreferences(storage, scope)).toMatchObject({
      dock: "right",
    });
  });

  test("uses stable checkout identity instead of a runtime workspace id", () => {
    const first = workspace("w1", "/repo/.worktrees/auth/", "auth-settings");
    const reopened = workspace("w2", "/repo/.worktrees/auth", "auth-settings");
    const main = workspace("main", "/repo");

    expect(checkoutKeyForWorkspace(first)).toBe(
      JSON.stringify(["auth-settings", "/repo/.worktrees/auth"]),
    );
    expect(checkoutKeyForWorkspace(main)).toBe(
      JSON.stringify(["local:repo-key", "/repo"]),
    );

    const firstScope = resourceScopeForWorkspace("local", first);
    const reopenedScope = resourceScopeForWorkspace("local", reopened);
    expect(resourceOwnerKey(firstScope)).toBe(
      `checkout:${JSON.stringify(["auth-settings", "/repo/.worktrees/auth"])}`,
    );
    expect(sameResourceOwner(firstScope, reopenedScope)).toBe(true);
    expect(resolveWorkspaceForScope(firstScope, [reopened])).toBe(reopened);
  });

  test("keeps identical checkout paths isolated by repository and connection", () => {
    const left = resourceScopeForWorkspace(
      "left",
      workspace("w1", "/worktree"),
    );
    const rightConnection = resourceScopeForWorkspace(
      "right",
      workspace("w2", "/worktree"),
    );
    const rightRepoWorkspace = workspace("w3", "/worktree");
    if (rightRepoWorkspace.worktree) {
      rightRepoWorkspace.worktree.repo_key = "other";
      rightRepoWorkspace.worktree.gui_settings_key = "local:other";
    }
    const rightRepo = resourceScopeForWorkspace("left", rightRepoWorkspace);

    expect(sameResourceOwner(left, rightConnection)).toBe(false);
    expect(sameResourceOwner(left, rightRepo)).toBe(false);
    expect(resourceStateKey(left)).not.toBe(resourceStateKey(rightConnection));
    expect(resourceStateKey(left)).not.toBe(resourceStateKey(rightRepo));
  });

  test("accepts an agent cwd only when it is inside the checkout", () => {
    expect(relativePathWithinCheckout("/repo/wt", "/repo/wt/src/auth")).toBe(
      "src/auth",
    );
    expect(relativePathWithinCheckout("/repo/wt/", "/repo/wt")).toBe("");
    expect(relativePathWithinCheckout("/repo/wt", "/repo/wt-other/src")).toBe(
      undefined,
    );
    expect(relativePathWithinCheckout("/repo/wt", "/tmp/outside")).toBe(
      undefined,
    );
  });

  test("restores expanded state without losing dock sizes", () => {
    const storage = memoryStorage();
    const scope = resourceScopeForWorkspace("local", workspace("w1"));
    const state: WorkspaceInspectorState = {
      scope,
      open: true,
      dock: "right",
      size: 610,
      expanded: false,
    };
    writeInspectorPreferences(storage, state);

    writeInspectorPreferences(storage, { ...state, expanded: true });

    writeInspectorPreferences(storage, {
      ...state,
      open: false,
      expanded: true,
    });
    expect(readInspectorPreferences(storage, scope)).toMatchObject({
      expanded: true,
      rightSize: 610,
    });
    writeInspectorPreferences(storage, { ...state, dock: "bottom", size: 380 });
    expect(readInspectorPreferences(storage, scope)).toMatchObject({
      expanded: false,
      rightSize: 610,
      bottomSize: 380,
    });
    const other = resourceScopeForWorkspace("remote", workspace("w1"));
    expect(readInspectorPreferences(storage, other)).toMatchObject({
      expanded: false,
    });
  });

  test("defaults missing or invalid expanded state to false", () => {
    const storage = {
      getItem: () => JSON.stringify({}),
    };
    const scope = resourceScopeForWorkspace("local", workspace("w1"));
    expect(readInspectorPreferences(storage, scope)).toMatchObject({
      expanded: false,
    });
    expect(
      readInspectorPreferences(
        {
          getItem: () =>
            JSON.stringify({
              expanded: "true",
            }),
        },
        scope,
      ),
    ).toMatchObject({
      expanded: false,
    });
  });

  test("persists dock and size independently for each checkout", () => {
    const storage = memoryStorage();
    const scope = resourceScopeForWorkspace(
      "local",
      workspace("w1", "/repo/.worktrees/auth", "auth"),
    );
    const state: WorkspaceInspectorState = {
      scope,
      open: true,
      dock: "bottom",
      size: 410,
      expanded: false,
    };

    writeInspectorPreferences(storage, state);
    expect(readInspectorPreferences(storage, scope)).toEqual({
      dock: "bottom",
      expanded: false,
      rightSize: 520,
      bottomSize: 410,
    });

    writeInspectorPreferences(storage, { ...state, size: 150 });
    writeInspectorPreferences(storage, { ...state, dock: "right", size: 400 });
    expect(readInspectorPreferences(storage, scope).bottomSize).toBe(150);
    writeInspectorPreferences(storage, { ...state, size: 73 });
    expect(readInspectorPreferences(storage, scope).bottomSize).toBe(73);
    expect(
      readInspectorPreferences(memoryStorage(), scope, { bottomSize: 0 })
        .bottomSize,
    ).toBe(360);
  });
});
