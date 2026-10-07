import { isCancelledError } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileDiff,
  Folder,
  RefreshCw,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ConnectionClient } from "../api";
import { thyraLocalStorage } from "../browserStorage";
import {
  GIT_DIFF_CODE_TONES,
  gitDiffCode,
  gitDiffCodeLabel,
} from "../gitDiffStatus";
import { t } from "../i18n";
import {
  type GitDiffSummaryMode,
  invalidateGitDiffFiles,
  refreshGitDiffSummary,
  useGitDiffSummaryState,
} from "../inspectorQueries";
import { store } from "../store";
import { copyTextFromUserGesture } from "../terminalClipboard";
import type { GitDiffEntry } from "../types";
import { TREE_DEPTH_INDENT } from "./treeIndent";
import { keyboardContextMenuPoint, treeKeyboardAction } from "./treeKeyboard";
import { ContextMenu } from "./ui/ContextMenu";
import { useLongPress } from "./useLongPress";
import { IconButton } from "./ui/IconButton";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Token } from "./ui/Token";
import "./ChangesList.css";

/** The file shown by Changes: every summary entry of one path in one scope. */
export type ChangesSelection = {
  mode: GitDiffSummaryMode;
  entries: GitDiffEntry[];
};

const MODE_KEY = "diffViewerScope";

type TreeNode = {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  entries: GitDiffEntry[];
};

/** Folders first, then files, each by name. */
export function buildChangesTree(entries: GitDiffEntry[]) {
  const root: TreeNode = {
    name: "",
    path: "",
    children: new Map(),
    entries: [],
  };
  for (const entry of entries) {
    let node = root;
    for (const name of entry.path.split("/").filter(Boolean)) {
      const path = node.path ? `${node.path}/${name}` : name;
      let child = node.children.get(name);
      if (!child) {
        child = { name, path, children: new Map(), entries: [] };
        node.children.set(name, child);
      }
      node = child;
    }
    node.entries.push(entry);
  }
  return root;
}

function sortedChildren(node: TreeNode) {
  return [...node.children.values()].sort(
    (a, b) =>
      Number(a.entries.length > 0) - Number(b.entries.length > 0) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

type Menu = { x: number; y: number; path: string; file: GitDiffEntry | null };

/** A tree row: click, right-click, the Menu key, or a long press. */
function TreeRow({
  depth,
  current,
  onActivate,
  onMenu,
  children,
}: {
  depth: number;
  current?: boolean;
  onActivate: () => void;
  onMenu: (x: number, y: number) => void;
  children: ReactNode;
}) {
  const longPress = useLongPress(onMenu);
  return (
    <button
      type="button"
      className="changes-row"
      style={{ paddingLeft: 6 + depth * TREE_DEPTH_INDENT }}
      aria-current={current ? "true" : undefined}
      onClick={(event) => {
        if (!longPress.consumeClick(event)) onActivate();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (treeKeyboardAction(event.key, event.shiftKey) !== "context-menu")
          return;
        event.preventDefault();
        const point = keyboardContextMenuPoint(event.currentTarget);
        onMenu(point.x, point.y);
      }}
      {...longPress.handlers}
    >
      {children}
    </button>
  );
}

function copyPath(path: string, absolute: boolean) {
  void copyTextFromUserGesture(path).then(
    () =>
      store.notify({
        kind: "success",
        message: absolute
          ? t("Absolute path copied")
          : t("Relative path copied"),
        detail: path,
        autoDismissMs: 5000,
      }),
    (error) =>
      store.notify({
        kind: "error",
        message: absolute
          ? t("Failed to copy absolute path")
          : t("Failed to copy relative path"),
        detail: error instanceof Error ? error.message : String(error),
      }),
  );
}

export function GitStatusTokens({ entries }: { entries: GitDiffEntry[] }) {
  return [...new Set(entries.map(gitDiffCode))].map((code) => (
    <Token
      key={code}
      tone={GIT_DIFF_CODE_TONES[code]}
      code
      role="img"
      aria-label={gitDiffCodeLabel(code)}
      title={gitDiffCodeLabel(code)}
    >
      {code}
    </Token>
  ));
}

/** The Changes list: scope, refresh, and a tree of the changed files. */
export function ChangesList({
  client,
  workspaceId,
  resourceKey,
  selection,
  onSelectionChange,
  onOpenFile,
}: {
  client: ConnectionClient;
  workspaceId: string;
  resourceKey: string;
  selection: ChangesSelection;
  onSelectionChange: (
    selection: ChangesSelection,
    meta?: { userInitiated?: boolean },
  ) => void;
  onOpenFile?: (entry: GitDiffEntry) => void;
}) {
  const [mode, setMode] = useState<GitDiffSummaryMode>(() =>
    thyraLocalStorage.getItem(MODE_KEY) === "branch-main"
      ? "branch-main"
      : "working",
  );
  const [error, setError] = useState<string | null>(null);
  const { summary, loading } = useGitDiffSummaryState(
    client,
    workspaceId,
    mode,
    resourceKey,
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<Menu | null>(null);
  const tree = useMemo(
    () => buildChangesTree(summary?.entries ?? []),
    [summary],
  );
  // Files in tree order, each with every entry of its path.
  const groups = useMemo(() => {
    const files: GitDiffEntry[][] = [];
    const visit = (node: TreeNode) => {
      for (const child of sortedChildren(node)) {
        if (child.entries.length) files.push(child.entries);
        else visit(child);
      }
    };
    visit(tree);
    return files;
  }, [tree]);
  const selectedPath =
    selection.mode === mode ? selection.entries[0]?.path : undefined;

  const load = useCallback(
    (restart: boolean) => {
      setError(null);
      if (restart) invalidateGitDiffFiles(client, workspaceId);
      refreshGitDiffSummary(client, workspaceId, mode, resourceKey, {
        afterCurrent: restart,
      }).catch((cause: Error) => {
        // A cancelled request was retired for a newer one.
        if (client.isCurrent() && !isCancelledError(cause)) {
          setError(cause.message);
        }
      });
    },
    [client, mode, resourceKey, workspaceId],
  );

  useEffect(() => {
    thyraLocalStorage.setItem(MODE_KEY, mode);
    load(false);
  }, [load, mode]);

  // Keep the shown file when it is still changed, else show the first one.
  useEffect(() => {
    const kept = groups.find((group) => group[0]?.path === selectedPath);
    onSelectionChange({ mode, entries: kept ?? groups[0] ?? [] });
    // Only a new summary (or scope) changes what is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, mode]);

  const renderTree = (node: TreeNode, depth: number): ReactNode[] =>
    sortedChildren(node).flatMap((child) => {
      const file = child.entries[0];
      if (!file) {
        const open = !collapsed.has(child.path);
        const Chevron = open ? ChevronDown : ChevronRight;
        return [
          <TreeRow
            key={child.path}
            depth={depth}
            onActivate={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (!next.delete(child.path)) next.add(child.path);
                return next;
              })
            }
            onMenu={(x, y) => setMenu({ x, y, path: child.path, file: null })}
          >
            <Chevron size={13} aria-hidden="true" />
            <Folder size={14} aria-hidden="true" />
            <span className="changes-row-name">{child.name}</span>
          </TreeRow>,
          ...(open ? renderTree(child, depth + 1) : []),
        ];
      }
      const additions = child.entries.reduce(
        (n, e) => n + (e.additions ?? 0),
        0,
      );
      const deletions = child.entries.reduce(
        (n, e) => n + (e.deletions ?? 0),
        0,
      );
      return [
        <TreeRow
          key={child.path}
          depth={depth}
          current={child.path === selectedPath}
          onActivate={() =>
            onSelectionChange(
              { mode, entries: child.entries },
              { userInitiated: true },
            )
          }
          onMenu={(x, y) => setMenu({ x, y, path: child.path, file })}
        >
          <span className="changes-row-twisty" />
          <File size={14} aria-hidden="true" />
          <span className="changes-row-name">{child.name}</span>
          <GitStatusTokens entries={child.entries} />
          {additions || deletions ? (
            <span className="changes-row-stats" aria-label={t("Line changes")}>
              <span className="changes-row-add">+{additions}</span>
              <span className="changes-row-del">-{deletions}</span>
            </span>
          ) : null}
        </TreeRow>,
      ];
    });

  return (
    <aside className="changes-list" aria-label={t("Diff Viewer")}>
      <div className="ui-bar changes-list-bar">
        <SegmentedControl
          className="changes-list-scope"
          stretch
          aria-label={t("Diff scope")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "working", label: t("Working tree") },
            { value: "branch-main", label: t("Against main") },
          ]}
        />
        <IconButton
          label={loading ? t("Refreshing changes") : t("Refresh changes")}
          aria-busy={loading}
          disabled={loading}
          onClick={() => load(true)}
          icon={
            <RefreshCw className={loading ? "is-spinning" : ""} size={15} />
          }
        />
      </div>
      {error ? <p className="modal-error">{error}</p> : null}
      <div className="changes-list-rows" aria-label={t("Changed files")}>
        {renderTree(tree, 0)}
        {groups.length ? null : (
          <div className="diff-content-state">
            {summary || !loading ? (
              <FileDiff size={16} aria-hidden="true" />
            ) : (
              <span className="file-loading-spinner" />
            )}
            {summary || !loading ? t("No changes") : t("Loading diff")}
          </div>
        )}
      </div>
      <ContextMenu
        position={menu}
        aria-label={t("Changed files")}
        header={menu ? { title: menu.path } : undefined}
        onClose={() => setMenu(null)}
        items={
          menu
            ? [
                ...(menu.file && onOpenFile && menu.file.status !== "deleted"
                  ? [
                      {
                        id: "open",
                        label: t("Open file"),
                        onAction: () => onOpenFile(menu.file!),
                      },
                    ]
                  : []),
                {
                  id: "copy-relative",
                  label: t("Copy relative path"),
                  onAction: () => copyPath(menu.path, false),
                },
                ...(summary?.root
                  ? [
                      {
                        id: "copy-absolute",
                        label: t("Copy absolute path"),
                        onAction: () =>
                          copyPath(`${summary.root}/${menu.path}`, true),
                      },
                    ]
                  : []),
              ]
            : []
        }
      />
    </aside>
  );
}
