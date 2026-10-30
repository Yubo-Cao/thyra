import { getShortcutSnapshot } from "./shortcutPreferences";
import { matchesShortcut, type ShortcutBindings } from "./shortcutBindings";
import type { Workspace } from "./types";
import { connectionStorageKey } from "./connectionStorage";

export const WORKSPACE_INSPECTOR_REQUEST_EVENT =
  "thyra:workspace-inspector-request";

export function isWorkspaceInspectorShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat"
  >,
  bindings: ShortcutBindings = getShortcutSnapshot().preset.bindings,
): boolean {
  return !event.repeat && matchesShortcut(event, "inspector.toggle", bindings);
}

export interface WorkspaceInspectorRequest {
  connectionId: string;
  generation: number;
  workspaceId: string;
}

export type InspectorDock = "right" | "bottom";

export const INSPECTOR_MIN_RIGHT = 360;
export const INSPECTOR_MIN_BOTTOM = 220;
export const TERMINAL_MIN_WIDTH = 480;
export const TERMINAL_MIN_HEIGHT = 240;
export const INSPECTOR_SEPARATOR_SIZE = 7;

export function inspectorMaximumSize(
  dock: InspectorDock,
  availableWidth: number,
  availableHeight: number,
): number {
  return dock === "right"
    ? Math.max(
        INSPECTOR_MIN_RIGHT,
        Math.min(
          availableWidth * 0.65,
          availableWidth - TERMINAL_MIN_WIDTH - INSPECTOR_SEPARATOR_SIZE,
        ),
      )
    : Math.max(
        INSPECTOR_MIN_BOTTOM,
        availableHeight - TERMINAL_MIN_HEIGHT - INSPECTOR_SEPARATOR_SIZE,
      );
}

export type ResourceScope =
  | {
      kind: "worktree";
      connectionId: string;
      repoKey: string;
      checkoutKey: string;
      checkoutPath: string;
      workspaceId: string;
    }
  | {
      kind: "workspace";
      connectionId: string;
      workspaceId: string;
    };

/** A file the editor should open; `nonce` repeats a request for the same file. */
export interface InspectorFileRequest {
  path: string;
  line?: number;
  nonce: number;
}

export interface WorkspaceInspectorState {
  scope: ResourceScope;
  open: boolean;
  dock: InspectorDock;
  size: number;
  expanded: boolean;
  returnTabId?: string;
  file?: InspectorFileRequest;
}

export interface InspectorPreferences {
  dock: InspectorDock;
  expanded: boolean;
  rightSize: number;
  bottomSize: number;
}

const DEFAULT_RIGHT_SIZE = 520;
const DEFAULT_BOTTOM_SIZE = 360;
const INSPECTOR_PREFERENCES_PREFIX = "workspaceInspector:";

function normalizedCheckoutPath(path: string): string {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}

export function checkoutKeyForWorkspace(workspace: Workspace): string | null {
  const worktree = workspace.worktree;
  if (!worktree) return null;
  const repoKey = worktree.gui_settings_key?.trim() || worktree.repo_key.trim();
  const checkoutPath = normalizedCheckoutPath(worktree.checkout_path);
  if (!repoKey || !checkoutPath) return null;
  // Keep the endpoint-qualified repository identity when a profile is repointed.
  // The path separates its main checkout from linked worktrees.
  return JSON.stringify([repoKey, checkoutPath]);
}

export function resourceScopeForWorkspace(
  connectionId: string,
  workspace: Workspace,
): ResourceScope {
  const checkoutKey = checkoutKeyForWorkspace(workspace);
  const worktree = workspace.worktree;
  if (checkoutKey && worktree) {
    return {
      kind: "worktree",
      connectionId,
      repoKey: worktree.repo_key,
      checkoutKey,
      checkoutPath: normalizedCheckoutPath(worktree.checkout_path),
      workspaceId: workspace.workspace_id,
    };
  }
  return {
    kind: "workspace",
    connectionId,
    workspaceId: workspace.workspace_id,
  };
}

export function resourceOwnerKey(scope: ResourceScope): string {
  return scope.kind === "worktree"
    ? `checkout:${scope.checkoutKey}`
    : `workspace:${scope.workspaceId}`;
}

export function resourceStateKey(scope: ResourceScope): string {
  return JSON.stringify([scope.connectionId, resourceOwnerKey(scope)]);
}

export function sameResourceOwner(
  left: ResourceScope,
  right: ResourceScope,
): boolean {
  return (
    left.connectionId === right.connectionId &&
    resourceOwnerKey(left) === resourceOwnerKey(right)
  );
}

export function resolveWorkspaceForScope(
  scope: ResourceScope,
  workspaces: Workspace[],
): Workspace | undefined {
  const exact = workspaces.find(
    (workspace) => workspace.workspace_id === scope.workspaceId,
  );
  if (exact) {
    const exactScope = resourceScopeForWorkspace(scope.connectionId, exact);
    if (sameResourceOwner(scope, exactScope)) return exact;
  }
  if (scope.kind !== "worktree") return undefined;
  return workspaces.find(
    (workspace) => checkoutKeyForWorkspace(workspace) === scope.checkoutKey,
  );
}

export function relativePathWithinCheckout(
  checkoutPath: string,
  candidatePath?: string | null,
): string | undefined {
  if (!candidatePath) return undefined;
  const root = normalizedCheckoutPath(checkoutPath);
  const candidate = normalizedCheckoutPath(candidatePath);
  if (!root || !candidate) return undefined;
  if (candidate === root) return "";
  const prefix = root === "/" ? "/" : `${root}/`;
  if (!candidate.startsWith(prefix)) return undefined;
  const relative = candidate.slice(prefix.length);
  if (!relative || relative.split("/").some((part) => part === "..")) {
    return undefined;
  }
  return relative;
}

function preferencesStorageKey(scope: ResourceScope): string {
  return connectionStorageKey(
    scope.connectionId,
    `${INSPECTOR_PREFERENCES_PREFIX}${resourceOwnerKey(scope)}`,
  );
}

function finiteSize(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function readInspectorPreferences(
  storage: Pick<Storage, "getItem">,
  scope: ResourceScope,
  defaults: Partial<
    Pick<InspectorPreferences, "rightSize" | "bottomSize">
  > = {},
): InspectorPreferences {
  const fallback: InspectorPreferences = {
    dock: "right",
    expanded: false,
    rightSize: finiteSize(defaults.rightSize, DEFAULT_RIGHT_SIZE),
    bottomSize: finiteSize(defaults.bottomSize, DEFAULT_BOTTOM_SIZE),
  };
  try {
    const raw = storage.getItem(preferencesStorageKey(scope));
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<InspectorPreferences>;
    return {
      dock: value.dock === "bottom" ? "bottom" : "right",
      expanded: value.expanded === true,
      rightSize: finiteSize(value.rightSize, DEFAULT_RIGHT_SIZE),
      bottomSize: finiteSize(value.bottomSize, DEFAULT_BOTTOM_SIZE),
    };
  } catch {
    return fallback;
  }
}

export function writeInspectorPreferences(
  storage: Pick<Storage, "getItem" | "setItem">,
  state: WorkspaceInspectorState,
): void {
  const previous = readInspectorPreferences(storage, state.scope);
  const next: InspectorPreferences = {
    dock: state.dock,
    expanded: state.expanded,
    rightSize: state.dock === "right" ? state.size : previous.rightSize,
    bottomSize: state.dock === "bottom" ? state.size : previous.bottomSize,
  };
  storage.setItem(preferencesStorageKey(state.scope), JSON.stringify(next));
}
