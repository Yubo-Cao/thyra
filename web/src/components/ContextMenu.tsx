import { useRef, useState } from "react";
import { t } from "../i18n";
import type { Workspace } from "../types";
import { store, useStoreSelector } from "../store";
import {
  clearTerminalComposerDrafts,
  terminalComposerCloseWarning,
  terminalComposerDraftPaneIds,
} from "../terminalComposer";
import { luckyWorktreeBranchName } from "../luckyName";
import { ConfirmDialog, TextInputDialog } from "./ModalDialogs";
import { WorktreeHooksDialog } from "./WorktreeHooksDialog";
import { WorktreeOpenDialog } from "./WorktreeOpenDialog";
import { WorkspaceAutoSyncDialog } from "./WorkspaceAutoSyncDialog";
import { worktreeCreationSource } from "../worktree";
import { LazyWorktreeLifecycleDialog as WorktreeLifecycleDialog } from "./LazyWorktreeLifecycleDialog";
import { isWorkspacePinned } from "../workspacePins";
import { workspaceDisplayName } from "../workspaceTreeBadges";
import { copyTextFromUserGesture } from "../terminalClipboard";
import { ContextMenu as MenuAtPoint } from "./ui/ContextMenu";
import type { MenuItem } from "./ui/Menu";
import { ShareWorkspaceDialog } from "./ShareWorkspaceDialog";
import { useInstanceAdmin } from "../principal";

export interface ContextMenuState {
  x: number;
  y: number;
  workspace: Workspace;
}

/** The prompt or panel a menu item opened; `value` is its initial text. */
type Opened = {
  kind:
    | "new-worktree"
    | "rename-workspace"
    | "remove-worktree"
    | "close-workspace"
    | "open-worktree"
    | "worktree-hooks"
    | "auto-sync"
    | "lifecycle"
    | "share";
  workspaceId: string;
  value: string;
};

/** The workspace right-click / long-press menu and the dialogs it opens. */
export function ContextMenu({
  state,
  pinnedWorkspaceKeys,
  onPinnedChange,
  onBrowseFiles,
  onReviewChanges,
  onClose,
}: {
  state: ContextMenuState | null;
  pinnedWorkspaceKeys: ReadonlySet<string>;
  onPinnedChange: (workspace: Workspace, pinned: boolean) => void;
  onBrowseFiles?: (workspace: Workspace) => void;
  onReviewChanges?: (workspace: Workspace) => void;
  onClose: () => void;
}) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const activeConnectionId = useStoreSelector(
    (state) => state.activeConnectionId,
  );
  const connectionGeneration = useStoreSelector(
    (state) => state.connectionGeneration,
  );
  const panes = useStoreSelector((state) => state.panes);
  const [opened, setOpened] = useState<Opened | null>(null);
  const close = () => setOpened(null);
  const openedId = (kind: Opened["kind"]) =>
    opened?.kind === kind ? opened.workspaceId : null;
  const closingPaneIds = panes
    .filter((pane) => pane.workspace_id === openedId("close-workspace"))
    .map((pane) => pane.pane_id);

  // The menu keeps its last workspace while it animates closed.
  const shown = useRef(state);
  if (state) shown.current = state;
  const target = shown.current?.workspace;
  const w = target
    ? (workspaces.find((each) => each.workspace_id === target.workspace_id) ??
      target)
    : null;
  const isLinked = !!w?.worktree?.is_linked_worktree;
  // The bridge enforces roles; hide what this caller cannot do. Worktrees
  // and branch auto-update run host-side hooks: instance admins only.
  const admin = useInstanceAdmin();
  const role = w?.access ?? "owner";
  const editor = role !== "viewer";
  const owner = role === "owner";

  const sections = (() => {
    if (!w) return [];
    const pinned = isWorkspacePinned(pinnedWorkspaceKeys, w);
    const creationSource = worktreeCreationSource(workspaces, w);
    const open = (kind: Opened["kind"], value = w.label, id = w.workspace_id) =>
      setOpened({ kind, workspaceId: id, value });
    const copyCheckoutPath = () => {
      const path = w.worktree?.checkout_path;
      if (!path) return;
      void copyTextFromUserGesture(path).then(
        () =>
          store.notify({
            kind: "success",
            message: t("Checkout path copied"),
            detail: path,
            autoDismissMs: 5000,
          }),
        (error) =>
          store.notify({
            kind: "error",
            message: t("Failed to copy checkout path"),
            detail: error instanceof Error ? error.message : String(error),
          }),
      );
    };
    const worktreeItems: MenuItem[] = !admin
      ? []
      : [
          ...(creationSource
            ? [
                {
                  id: "new-worktree",
                  label: t("New worktree…"),
                  onAction: () =>
                    open(
                      "new-worktree",
                      luckyWorktreeBranchName(),
                      creationSource.workspace_id,
                    ),
                },
              ]
            : []),
          ...(w.worktree
            ? [
                {
                  id: "open-worktree",
                  label: t("Open worktree…"),
                  onAction: () => open("open-worktree"),
                },
                {
                  id: "lifecycle",
                  label: t("Worktree lifecycle…"),
                  onAction: () => open("lifecycle"),
                },
                {
                  id: "worktree-hooks",
                  label: t("Configure worktree hooks…"),
                  onAction: () => open("worktree-hooks"),
                },
              ]
            : []),
        ];
    return [
      {
        title: t("Inspect"),
        items: [
          {
            id: "browse-files",
            label: t("Browse files"),
            onAction: () => onBrowseFiles?.(w),
          },
          {
            id: "review-changes",
            label: t("Review changes"),
            onAction: () => onReviewChanges?.(w),
          },
        ],
      },
      {
        title: t("Organize"),
        items: [
          {
            id: "pin",
            label: pinned
              ? isLinked
                ? t("Unpin worktree")
                : t("Unpin workspace")
              : isLinked
                ? t("Pin worktree")
                : t("Pin workspace"),
            onAction: () => onPinnedChange(w, !pinned),
          },
          ...(owner
            ? [
                {
                  id: "share",
                  label: t("Share workspace…"),
                  onAction: () => open("share"),
                },
                {
                  id: "rename",
                  label: t("Rename workspace…"),
                  onAction: () => open("rename-workspace"),
                },
              ]
            : []),
          ...(w.worktree
            ? [
                {
                  id: "copy-checkout-path",
                  label: t("Copy checkout path"),
                  onAction: copyCheckoutPath,
                },
              ]
            : []),
        ],
      },
      { title: t("Worktrees"), items: worktreeItems },
      {
        title: t("Source control"),
        items: [
          ...(editor
            ? [
                {
                  id: "git-pull",
                  label: t("Pull from Git"),
                  onAction: () => void store.gitPullWorkspace(w.workspace_id),
                },
              ]
            : []),
          ...(admin
            ? [
                {
                  id: "auto-sync",
                  label: t("Configure branch auto-update…"),
                  onAction: () => open("auto-sync"),
                },
              ]
            : []),
        ],
      },
      {
        title: t("Close"),
        danger: true,
        items: [
          ...(isLinked && admin
            ? [
                {
                  id: "remove-worktree",
                  label: t("Remove worktree"),
                  onAction: () => open("remove-worktree"),
                },
              ]
            : []),
          ...(owner
            ? [
                {
                  id: "close-workspace",
                  label: t("Close workspace"),
                  onAction: () => open("close-workspace"),
                },
              ]
            : []),
        ],
      },
    ].filter((section) => section.items.length > 0);
  })();

  return (
    <>
      <MenuAtPoint
        position={state ? { x: state.x, y: state.y } : null}
        onClose={onClose}
        items={sections}
        aria-label={t("Workspace")}
        header={
          w
            ? {
                title: workspaceDisplayName(w),
                subtitle: isLinked
                  ? t("Linked worktree")
                  : w.worktree
                    ? t("Git workspace")
                    : t("Workspace"),
              }
            : undefined
        }
      />
      <TextInputDialog
        open={opened?.kind === "new-worktree"}
        title={t("New Worktree")}
        label={t("Branch")}
        initialValue={opened?.value}
        placeholder={t("Branch name")}
        submitLabel={t("Create")}
        onClose={close}
        onSubmit={(branch) => {
          const value = branch.trim();
          if (!opened || !value) return;
          store.createWorktree(opened.workspaceId, value);
          close();
        }}
      />
      <TextInputDialog
        open={opened?.kind === "rename-workspace"}
        title={t("Rename Workspace")}
        label={t("Name")}
        initialValue={opened?.value}
        submitLabel={t("Rename")}
        onClose={close}
        onSubmit={(label) => {
          const value = label.trim();
          if (!opened || !value) return;
          if (value !== opened.value)
            store.renameWorkspace(opened.workspaceId, value);
          close();
        }}
      />
      <ConfirmDialog
        open={opened?.kind === "remove-worktree"}
        title={t("Remove Worktree")}
        message={t('Remove worktree "{name}"?', { name: opened?.value ?? "" })}
        confirmLabel={t("Remove")}
        danger
        onClose={close}
        onConfirm={() => {
          if (opened) store.removeWorktree(opened.workspaceId, false);
        }}
      />
      <ConfirmDialog
        open={opened?.kind === "close-workspace"}
        title={t("Close Workspace")}
        message={t('Close workspace "{name}"?{warning}', {
          name: opened?.value ?? "",
          warning: terminalComposerCloseWarning(
            terminalComposerDraftPaneIds(
              activeConnectionId,
              connectionGeneration,
              closingPaneIds,
            ).length,
          ),
        })}
        confirmLabel={t("Close")}
        danger
        onClose={close}
        onConfirm={() => {
          if (!opened) return;
          clearTerminalComposerDrafts(
            activeConnectionId,
            connectionGeneration,
            closingPaneIds,
          );
          store.closeWorkspace(opened.workspaceId);
        }}
      />
      <ShareWorkspaceDialog
        open={opened?.kind === "share"}
        connectionId={activeConnectionId}
        workspaceId={openedId("share")}
        workspaceName={opened?.value ?? ""}
        onClose={close}
      />
      <WorktreeOpenDialog
        open={opened?.kind === "open-worktree"}
        workspaceId={openedId("open-worktree")}
        onClose={close}
      />
      <WorktreeHooksDialog
        open={opened?.kind === "worktree-hooks"}
        workspaceId={openedId("worktree-hooks") ?? undefined}
        onClose={close}
      />
      <WorkspaceAutoSyncDialog
        open={opened?.kind === "auto-sync"}
        workspaceId={openedId("auto-sync") ?? undefined}
        onClose={close}
      />
      <WorktreeLifecycleDialog
        open={opened?.kind === "lifecycle"}
        workspaceId={openedId("lifecycle")}
        onClose={close}
      />
    </>
  );
}
