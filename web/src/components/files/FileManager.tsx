import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Eye,
  EyeOff,
  FilePlus,
  FolderPlus,
  LayoutGrid,
  List,
  Upload,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ConnectionClient } from "../../api";
import { thyraLocalStorage } from "../../browserStorage";
import { connectionHttpPath } from "../../connectionHttp";
import { downloadFileFromUrl } from "../../downloadFile";
import {
  fileExplorerRefreshKey,
  useFileExplorerRefresh,
} from "../../fileExplorerRefresh";
import { normalizeFilesystemPath } from "../../filesystemPaths";
import { t } from "../../i18n";
import { store } from "../../store";
import { copyTextFromUserGesture } from "../../terminalClipboard";
import type { FileExplorerEntry, FileExplorerList } from "../../types";
import { useDocumentTheme } from "../documentTheme";
import {
  type FileExplorerCache,
  type buildGitStatusMaps,
  createExplorerEntry,
  deleteExplorerEntry,
  readExplorerCache,
  readExplorerViewMemory,
  symlinkDescription,
  uploadExplorerFile,
  writeExplorerCache,
  writeExplorerViewMemory,
} from "../fileExplorerResources";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ContextMenu } from "../ui/ContextMenu";
import { Dialog } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Menu } from "../ui/Menu";
import { SearchField } from "../ui/SearchField";
import { TextField } from "../ui/TextField";
import { Token } from "../ui/Token";
import { useLongPress } from "../useLongPress";
import {
  clipboardPathsFor,
  setFileClipboard,
  useFileClipboard,
} from "./fileClipboard";
import { FileManagerNav, locationCrumbs } from "./FileManagerNav";
import {
  type FileMenuActions,
  folderMenu,
  modifierKey,
  readSort,
  selectionMenu,
  sortMenu,
  writeSort,
} from "./fileManagerMenus";
import {
  type FileRow,
  type FileScope,
  type FileView,
  type MoveKey,
  type SortState,
  ancestorsBetween,
  baseName,
  extensionOf,
  formatSize,
  hostPathOf,
  isAbsolutePath,
  isDirectoryEntry,
  isWithin,
  joinPath,
  moveIndex,
  parentPath,
  rangeBetween,
  relativePathOf,
  typeaheadMatch,
  visibleRows,
} from "./fileManagerModel";
import { fileOperations, isConflictError } from "./fileOperations";
import { FileIcon, FileThumbnail } from "./FileVisual";
import "./FileManager.css";

type GitStatusMaps = ReturnType<typeof buildGitStatusMaps>;

export type FileManagerChange = {
  /** Paths whose content or existence changed. */
  paths: string[];
  /** The paths no longer exist (deleted or moved away). */
  removed?: boolean;
  /** Renamed or moved entries, old path to new. */
  moved?: Array<{ from: string; path: string }>;
};

export type FileManagerProps = {
  client: ConnectionClient;
  workspaceId: string;
  scope: FileScope;
  /** Cache identity of the checkout (Inspector resource key). */
  resourceKey: string;
  /** Absolute checkout root, for absolute paths in workspace scope. */
  rootPath: string;
  /** Repository or workspace name shown as the workspace root crumb. */
  rootLabel: string;
  /** Session-only memory key of the filesystem directory. */
  memoryContext: string;
  /** Filesystem scope: where to start without a remembered directory. */
  initialLocation?: string;
  readOnly: boolean;
  showHidden: boolean;
  onShowHiddenChange: (value: boolean) => void;
  /** The file shown in the preview; revealed and highlighted. */
  activePath?: string;
  keyboardActive?: boolean;
  gitStatus?: GitStatusMaps;
  onOpenFile: (entry: FileExplorerEntry) => void;
  onChanged?: (change: FileManagerChange) => void;
  /** Workspace scope: the checkout's real path, from its first listing. */
  onRootResolved?: (root: string) => void;
};

type MenuState = { x: number; y: number; entries: FileExplorerEntry[] };
type Editing =
  | { kind: "rename"; path: string }
  | { kind: "create"; type: "file" | "directory"; folder: string }
  | null;
type TransferRequest = {
  paths: string[];
  destination: string;
  mode: "move" | "copy";
};

const VIEW_KEY = "fileManagerView";
const SORT_KEY = "fileManagerSort";
const MOVE_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
const THUMBNAIL_EXTENSIONS = new Set(
  "png jpg jpeg jfif webp gif bmp avif heic heif tif tiff mp4 m4v mov webm mkv avi ogv pdf".split(
    " ",
  ),
);
// SVG has no server thumbnail; small ones are shown as-is (inert in <img>).
const INLINE_SVG_MAX_BYTES = 64 * 1024;

function shortDate(ms: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Inline name field for rename and new entries; Enter or blur commits. */
function NameInput({
  initial,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (commit && name && name !== initial) onCommit(name);
    else onCancel();
  };
  return (
    <TextField
      autoFocus
      className="file-name-field"
      inputClassName="file-name-input"
      aria-label={label}
      value={value}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onValueChange={setValue}
      onFocus={(event) => {
        // Select the stem, as VS Code does, so typing keeps the extension.
        const dot = initial.lastIndexOf(".");
        event.currentTarget.setSelectionRange(
          0,
          dot > 0 ? dot : initial.length,
        );
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

export function FileManager({
  client,
  workspaceId,
  scope,
  resourceKey,
  rootPath,
  rootLabel,
  memoryContext,
  initialLocation,
  readOnly,
  showHidden,
  onShowHiddenChange,
  activePath,
  keyboardActive = false,
  gitStatus,
  onOpenFile,
  onChanged,
  onRootResolved,
}: FileManagerProps) {
  const filesystem = scope === "filesystem";
  const light = useDocumentTheme() === "light";
  const ops = useMemo(
    () => fileOperations(client, workspaceId, filesystem),
    [client, workspaceId, filesystem],
  );
  const cacheKey = filesystem ? `${resourceKey}\u0000filesystem` : resourceKey;
  const readCache = () =>
    readExplorerCache(client, workspaceId, showHidden, cacheKey);
  const [cache, setCache] = useState<FileExplorerCache>(readCache);
  const [location, setLocation] = useState(() =>
    filesystem
      ? readExplorerViewMemory(memoryContext).directory ||
        initialLocation ||
        rootPath
      : (cache.location ?? ""),
  );
  const [history, setHistory] = useState<{ back: string[]; forward: string[] }>(
    { back: [], forward: [] },
  );
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [view, setView] = useState<FileView>(() =>
    thyraLocalStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list",
  );
  const [sort, setSort] = useState<SortState>(() =>
    readSort(thyraLocalStorage.getItem(SORT_KEY)),
  );
  const [selection, setSelection] = useState<{
    paths: Set<string>;
    anchor: string | null;
  }>(() => ({
    paths: new Set(activePath ? [activePath] : []),
    anchor: activePath ?? null,
  }));
  const [focused, setFocused] = useState<string | null>(activePath ?? null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [folderMenuAt, setFolderMenuAt] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [pendingDelete, setPendingDelete] = useState<FileExplorerEntry[]>([]);
  const [conflict, setConflict] = useState<TransferRequest | null>(null);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [width, setWidth] = useState<"narrow" | "medium" | "wide">("wide");
  const clipboard = useFileClipboard();
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadFolder = useRef("");
  const contextRef = useRef(0);
  const typeahead = useRef({ text: "", at: 0 });
  const pressedPath = useRef<string | null>(null);
  const pointerType = useRef("mouse");
  const { children, expanded, search: filter, error } = cache;
  const listKey = (path: string) =>
    filesystem ? normalizeFilesystemPath(path) : path;
  const here = listKey(location);

  // Widths come from a ResizeObserver class, not container queries: Chromium
  // drops the boxes of children inserted into size containers here.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => {
      const inline = entry?.contentRect.width ?? 0;
      setWidth(inline < 300 ? "narrow" : inline < 440 ? "medium" : "wide");
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const update = (
    patch: (current: FileExplorerCache) => Partial<FileExplorerCache>,
  ) =>
    setCache((current) => {
      const next = { ...current, ...patch(current) };
      writeExplorerCache(client, workspaceId, showHidden, next, cacheKey);
      return next;
    });

  const isCurrent = (token: number) =>
    client.isCurrent() && contextRef.current === token;

  /** List one directory; filesystem results are keyed by their real path. */
  const load = async (path: string, force = false): Promise<string | null> => {
    const key = listKey(path);
    if (!force && children[key]) return key;
    const token = contextRef.current;
    setLoading((current) => new Set(current).add(key));
    try {
      const list = (await client.call("file.list", {
        workspace_id: workspaceId,
        path,
        show_hidden: showHidden,
        ...(filesystem ? { scope: "filesystem" } : {}),
      })) as FileExplorerList & { scope?: string };
      if (!isCurrent(token)) return null;
      if (filesystem && list.scope !== "filesystem") {
        throw new Error(
          t("Filesystem browsing requires an updated Thyra bridge."),
        );
      }
      const listed = filesystem ? normalizeFilesystemPath(list.root) : path;
      if (!filesystem && !path) onRootResolved?.(list.root);
      update((current) => ({
        rootInfo: listed === listKey(location) ? list : current.rootInfo,
        children: { ...current.children, [listed]: list.entries },
        error: null,
      }));
      return listed;
    } catch (reason) {
      if (isCurrent(token)) {
        update(() => ({ error: (reason as Error).message }));
      }
      return null;
    } finally {
      if (isCurrent(token)) {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  };

  const reloadVisible = (extra: string[] = []) => {
    const paths = new Set([here, ...extra.map(listKey)]);
    for (const path of expanded) if (isWithin(path, here)) paths.add(path);
    for (const path of paths) void load(path, true);
  };

  // A new connection, workspace, scope or hidden-file setting starts over.
  const context = `${client.connectionId}\n${client.generation}\n${workspaceId}\n${cacheKey}\n${showHidden}`;
  useEffect(() => {
    contextRef.current += 1;
    const fresh = readCache();
    setCache(fresh);
    setLoading(new Set());
    setMenu(null);
    setEditing(null);
    const start = filesystem ? location : (fresh.location ?? "");
    void navigate(start, "replace");
    for (const path of fresh.expanded) {
      if (path && isWithin(path, start)) void load(path, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

  // Git mutations elsewhere (the Changes panel) re-list what is visible.
  const refreshVersion = useFileExplorerRefresh(
    fileExplorerRefreshKey(client, workspaceId),
  );
  const seenRefresh = useRef(refreshVersion);
  useEffect(() => {
    if (seenRefresh.current === refreshVersion) return;
    seenRefresh.current = refreshVersion;
    if (!filesystem) reloadVisible();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshVersion]);

  async function navigate(
    target: string,
    mode: "push" | "back" | "forward" | "replace" = "push",
  ) {
    const path = target.trim();
    if (filesystem && !path) return;
    const previous = location;
    const listed = await load(path, true);
    if (listed === null) return;
    setLocation(listed);
    setEditing(null);
    if (filesystem) {
      writeExplorerViewMemory(memoryContext, { directory: listed });
    } else update(() => ({ location: listed }));
    if (mode === "push" && listed !== previous) {
      setHistory((current) => ({
        back: [...current.back, previous].slice(-50),
        forward: [],
      }));
    }
  }

  const goBack = () => {
    const previous = history.back[history.back.length - 1];
    if (previous === undefined) return;
    setHistory((current) => ({
      back: current.back.slice(0, -1),
      forward: [location, ...current.forward],
    }));
    void navigate(previous, "back");
  };
  const goForward = () => {
    const next = history.forward[0];
    if (next === undefined) return;
    setHistory((current) => ({
      back: [...current.back, location],
      forward: current.forward.slice(1),
    }));
    void navigate(next, "forward");
  };
  const parentOfHere = parentPath(location, scope);
  const atRoot = filesystem
    ? normalizeFilesystemPath(parentOfHere) === here
    : location === "";
  const goUp = () => {
    if (!atRoot) void navigate(parentOfHere);
  };

  const rows = useMemo(
    () => visibleRows({ root: here, children, expanded, sort, filter, view }),
    [children, expanded, filter, here, sort, view],
  );
  const entries = useMemo(
    () => new Map(rows.map((row) => [row.entry.path, row.entry])),
    [rows],
  );
  const hereEntries = children[here];
  const hereLoading = loading.has(here) && !hereEntries;
  const selected = rows
    .filter((row) => selection.paths.has(row.entry.path))
    .map((row) => row.entry);

  const select = (
    path: string | null,
    {
      toggle = false,
      range = false,
    }: { toggle?: boolean; range?: boolean } = {},
  ) => {
    if (!path) {
      setSelection({ paths: new Set(), anchor: null });
      return;
    }
    setSelection((current) => {
      if (range) {
        const extent = rangeBetween(rows, current.anchor, path);
        const paths = toggle ? new Set(current.paths) : new Set<string>();
        for (const item of extent) paths.add(item);
        return { paths, anchor: current.anchor ?? path };
      }
      if (toggle) {
        const paths = new Set(current.paths);
        if (paths.has(path)) paths.delete(path);
        else paths.add(path);
        return { paths, anchor: path };
      }
      return { paths: new Set([path]), anchor: path };
    });
    setFocused(path);
  };

  const toggleFolder = (path: string, open?: boolean) => {
    const next = new Set(expanded);
    const opening = open ?? !next.has(path);
    if (opening) {
      next.add(path);
      void load(path);
    } else next.delete(path);
    update(() => ({ expanded: next }));
  };

  // Reveal the previewed file: show its folder and expand down to it.
  const reveal = (path: string | undefined) => {
    if (!path || isAbsolutePath(path) !== filesystem) return;
    const inside = isWithin(path, here) && path !== here;
    const base = inside ? here : filesystem ? parentPath(path, scope) : "";
    if (!inside) void navigate(base);
    const folders = view === "list" ? ancestorsBetween(base, path, scope) : [];
    if (folders.some((folder) => !expanded.has(folder))) {
      update((current) => ({
        expanded: new Set([...current.expanded, ...folders]),
      }));
      for (const folder of folders) void load(folder);
    }
    select(path);
  };
  useEffect(() => {
    if (activePath) reveal(activePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  const rowElement = (path: string) =>
    bodyRef.current?.querySelector<HTMLElement>(
      `[data-file-path="${CSS.escape(path)}"]`,
    ) ?? null;

  const focusedVisible = !!focused && entries.has(focused);
  useEffect(() => {
    if (focusedVisible && focused) {
      rowElement(focused)?.scrollIntoView({ block: "nearest" });
    }
  }, [focused, view, focusedVisible]);

  const hasRows = rows.length > 0;
  useEffect(() => {
    if (!keyboardActive) return;
    const body = bodyRef.current;
    if (!body || body.contains(document.activeElement)) return;
    const target =
      (focused && rowElement(focused)) ||
      body.querySelector<HTMLElement>("[data-file-path]");
    target?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardActive, hasRows]);

  const focusPath = (path: string) => {
    setFocused(path);
    const element = rowElement(path);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest" });
  };

  const open = (entry: FileExplorerEntry, intoFolder = view === "grid") => {
    select(entry.path);
    if (isDirectoryEntry(entry)) {
      if (intoFolder) void navigate(entry.path);
      else toggleFolder(entry.path);
      return;
    }
    if (entry.type === "symlink" && entry.symlink_status === "broken") {
      store.notify({
        kind: "error",
        message: t("Cannot open symlink"),
        detail: t("The symlink target does not exist or cannot be resolved."),
      });
      return;
    }
    onOpenFile(entry);
  };

  // --- Actions -----------------------------------------------------------

  const notifyError = (message: string, reason: unknown) =>
    store.notify({
      kind: "error",
      message,
      detail: (reason as Error).message,
    });

  const copyPaths = async (paths: string[], relative: boolean) => {
    const value = paths
      .map((path) =>
        relative ? relativePathOf(rootPath, path) : hostPathOf(rootPath, path),
      )
      .join("\n");
    try {
      await copyTextFromUserGesture(value);
      store.notify({
        kind: "success",
        message: paths.length > 1 ? t("Paths copied") : t("Path copied"),
        detail: value,
        autoDismissMs: 5000,
      });
    } catch (reason) {
      notifyError(t("Failed to copy path"), reason);
    }
  };

  const fileUrl = (endpoint: string, params: Record<string, string>) => {
    const url = new URL(
      connectionHttpPath(
        client.connectionId,
        endpoint,
        client.serverRuntimeGeneration,
      ),
      window.location.origin,
    );
    url.searchParams.set("workspace_id", workspaceId);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    if (filesystem) url.searchParams.set("scope", "filesystem");
    return url.toString();
  };

  const download = (entry: FileExplorerEntry) => {
    void downloadFileFromUrl({
      url: fileUrl("/file/download", { path: entry.path }),
      filename: isDirectoryEntry(entry)
        ? `${entry.name || "download"}.tar.gz`
        : entry.name,
    }).then((result) => {
      if (result === "shared" || !client.isCurrent()) return;
      store.notify({
        kind: "info",
        message: t("Download started"),
        detail: entry.path,
        autoDismissMs: 5000,
      });
    });
  };

  const markBusy = (paths: string[], on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      for (const path of paths) {
        if (on) next.add(path);
        else next.delete(path);
      }
      return next;
    });

  /** Re-list the folders an operation touched, and report the change. */
  const afterChange = (folders: string[], change?: FileManagerChange) => {
    for (const folder of new Set(folders.map(listKey))) {
      if (isWithin(folder, here)) void load(folder, true);
    }
    if (change) onChanged?.(change);
  };

  const uploadFiles = async (folder: string, files: File[]) => {
    const list = files.filter((file) => file.name);
    if (!list.length || readOnly) return;
    const token = contextRef.current;
    setUploading((count) => count + list.length);
    const paths: string[] = [];
    for (const file of list) {
      try {
        paths.push(
          (await uploadExplorerFile(client, workspaceId, folder, file)).path,
        );
      } catch (reason) {
        if (!isCurrent(token)) return;
        notifyError(t("Upload failed: {name}", { name: file.name }), reason);
      } finally {
        if (isCurrent(token)) setUploading((count) => Math.max(0, count - 1));
      }
    }
    if (!isCurrent(token)) return;
    if (paths.length) {
      store.notify({
        kind: "success",
        message:
          paths.length === 1
            ? t("File uploaded")
            : t("{count} files uploaded", { count: paths.length }),
        detail: folder || rootLabel,
        autoDismissMs: 5000,
      });
    }
    if (folder !== here && !expanded.has(folder)) toggleFolder(folder, true);
    afterChange([folder], { paths });
  };

  /** Create `a/b/c.txt` inside a folder, making missing folders on the way. */
  const createEntry = async (
    kind: "file" | "directory",
    folder: string,
    value: string,
  ) => {
    setEditing(null);
    const parts = value
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part && part !== ".");
    if (!parts.length || parts.includes("..")) return;
    const token = contextRef.current;
    let path = folder;
    try {
      for (const [index, part] of parts.entries()) {
        path = joinPath(path, part);
        const last = index === parts.length - 1;
        try {
          await createExplorerEntry(
            client,
            workspaceId,
            path,
            last ? kind : "directory",
          );
        } catch (reason) {
          if (last || !isConflictError(reason)) throw reason;
        }
      }
      if (!isCurrent(token)) return;
      const parent = parentPath(path, scope);
      for (const ancestor of [
        folder,
        ...ancestorsBetween(folder, path, scope),
      ]) {
        if (ancestor !== here && !expanded.has(ancestor)) {
          toggleFolder(ancestor, true);
        }
      }
      afterChange([folder, parent], { paths: [path] });
      select(path);
      if (kind === "file") {
        onOpenFile({
          name: baseName(path),
          path,
          type: "file",
          size: 0,
          mtime_ms: Date.now(),
          hidden: baseName(path).startsWith("."),
        });
      }
    } catch (reason) {
      if (!isCurrent(token)) return;
      notifyError(
        kind === "file" ? t("Cannot create file") : t("Cannot create folder"),
        reason,
      );
    }
  };

  const rename = async (entry: FileExplorerEntry, name: string) => {
    const token = contextRef.current;
    markBusy([entry.path], true);
    try {
      const { path } = await ops.rename(entry.path, name);
      if (!isCurrent(token)) return;
      if (expanded.has(entry.path)) {
        update((current) => {
          const next = new Set(
            [...current.expanded].filter((item) => !isWithin(item, entry.path)),
          );
          next.add(path);
          return { expanded: next };
        });
      }
      afterChange([parentPath(entry.path, scope)], {
        paths: [entry.path],
        removed: true,
        moved: [{ from: entry.path, path }],
      });
      select(path);
    } catch (reason) {
      if (isCurrent(token)) notifyError(t("Rename failed"), reason);
    } finally {
      if (isCurrent(token)) markBusy([entry.path], false);
    }
  };

  const transfer = async (
    request: TransferRequest,
    conflictPolicy: "fail" | "rename" | "replace" = request.mode === "copy"
      ? "rename"
      : "fail",
  ) => {
    const token = contextRef.current;
    markBusy(request.paths, true);
    try {
      const { items } = await ops.transfer({
        ...request,
        conflict: conflictPolicy,
      });
      if (!isCurrent(token)) return;
      const moved = items.filter((item) => item.from !== item.path);
      if (request.mode === "move" && clipboard?.mode === "cut") {
        setFileClipboard(null);
      }
      if (request.destination !== here && !expanded.has(request.destination)) {
        toggleFolder(request.destination, true);
      }
      afterChange(
        [
          request.destination,
          ...request.paths.map((path) => parentPath(path, scope)),
        ],
        request.mode === "move"
          ? { paths: moved.map((item) => item.from), removed: true, moved }
          : { paths: items.map((item) => item.path) },
      );
      setSelection({
        paths: new Set(items.map((item) => item.path)),
        anchor: items[0]?.path ?? null,
      });
      if (items[0]) setFocused(items[0].path);
      if (moved.length || request.mode === "copy") {
        store.notify({
          kind: "success",
          message:
            request.mode === "copy"
              ? items.length === 1
                ? t("Copied 1 item")
                : t("Copied {count} items", { count: items.length })
              : moved.length === 1
                ? t("Moved 1 item")
                : t("Moved {count} items", { count: moved.length }),
          detail: request.destination || rootLabel,
          autoDismissMs: 4000,
        });
      }
    } catch (reason) {
      if (!isCurrent(token)) return;
      if (conflictPolicy === "fail" && isConflictError(reason)) {
        setConflict(request);
      } else {
        notifyError(
          request.mode === "copy" ? t("Copy failed") : t("Move failed"),
          reason,
        );
      }
    } finally {
      if (isCurrent(token)) markBusy(request.paths, false);
    }
  };

  const remove = async (list: FileExplorerEntry[]) => {
    const token = contextRef.current;
    const paths = list.map((entry) => entry.path);
    markBusy(paths, true);
    const removed: string[] = [];
    for (const entry of list) {
      try {
        await deleteExplorerEntry(client, workspaceId, entry.path);
        removed.push(entry.path);
      } catch (reason) {
        if (!isCurrent(token)) return;
        notifyError(t("Delete failed"), reason);
        break;
      }
    }
    if (!isCurrent(token)) return;
    markBusy(paths, false);
    if (!removed.length) return;
    select(null);
    afterChange(
      removed.map((path) => parentPath(path, scope)),
      { paths: removed, removed: true },
    );
    store.notify({
      kind: "success",
      message:
        removed.length === 1
          ? t("Deleted {name}", { name: baseName(removed[0]!) })
          : t("Deleted {count} items", { count: removed.length }),
      autoDismissMs: 5000,
    });
  };

  /** The folder a paste or new entry targets for the current selection. */
  const targetFolder = (list: FileExplorerEntry[] = selected) => {
    const first = list[0];
    if (!first) return here;
    if (list.length === 1 && isDirectoryEntry(first)) return first.path;
    return parentPath(first.path, scope);
  };

  const toClipboard = (mode: "copy" | "cut", list: FileExplorerEntry[]) => {
    if (!list.length) return;
    setFileClipboard({
      mode,
      connectionId: client.connectionId,
      workspaceId,
      filesystem,
      root: rootPath,
      paths: list.map((entry) => entry.path),
    });
    store.notify({
      kind: "info",
      message:
        mode === "cut"
          ? list.length === 1
            ? t("Cut 1 item")
            : t("Cut {count} items", { count: list.length })
          : list.length === 1
            ? t("Copied 1 item to the clipboard")
            : t("Copied {count} items to the clipboard", {
                count: list.length,
              }),
      detail: t("Paste with {key}+V in a folder", { key: modifierKey }),
      autoDismissMs: 3000,
    });
  };

  const clipboardPaths = clipboard
    ? clipboardPathsFor(clipboard, {
        connectionId: client.connectionId,
        workspaceId,
        filesystem,
        root: rootPath,
      })
    : null;
  const paste = (folder: string) => {
    if (!clipboard) return;
    if (!clipboardPaths) {
      store.notify({
        kind: "error",
        message: t("Cannot paste here"),
        detail: t(
          "Items from another workspace paste only in Filesystem mode.",
        ),
      });
      return;
    }
    void transfer({
      paths: clipboardPaths,
      destination: folder,
      mode: clipboard.mode === "cut" ? "move" : "copy",
    });
  };

  const startCreate = (kind: "file" | "directory", folder: string) => {
    if (folder !== here && !expanded.has(folder)) toggleFolder(folder, true);
    setEditing({ kind: "create", type: kind, folder });
  };

  const actions: FileMenuActions = {
    open,
    download,
    copyPaths: (paths, relative) => void copyPaths(paths, relative),
    refresh: () => reloadVisible(),
    ...(readOnly
      ? {}
      : {
          rename: (entry) => setEditing({ kind: "rename", path: entry.path }),
          duplicate: (list) => {
            const groups = new Map<string, string[]>();
            for (const entry of list) {
              const folder = parentPath(entry.path, scope);
              groups.set(folder, [...(groups.get(folder) ?? []), entry.path]);
            }
            for (const [destination, paths] of groups) {
              void transfer({ paths, destination, mode: "copy" });
            }
          },
          cut: (list) => toClipboard("cut", list),
          copy: (list) => toClipboard("copy", list),
          ...(clipboard ? { paste } : {}),
          create: startCreate,
          upload: (folder) => {
            uploadFolder.current = folder;
            uploadRef.current?.click();
          },
          remove: (list) => setPendingDelete(list),
        }),
  };

  const thumbnailSrc = (entry: FileExplorerEntry) => {
    if (isDirectoryEntry(entry)) return null;
    const extension = extensionOf(entry.name);
    if (extension === "svg") {
      return entry.size <= INLINE_SVG_MAX_BYTES
        ? fileUrl("/file/download", { path: entry.path, inline: "1" })
        : null;
    }
    if (!THUMBNAIL_EXTENSIONS.has(extension)) return null;
    const size = Math.min(256, Math.ceil(72 * (window.devicePixelRatio || 1)));
    return fileUrl("/file/thumbnail", {
      path: entry.path,
      size: String(size),
      mtime: String(Math.round(entry.mtime_ms)),
      bytes: String(entry.size),
    });
  };

  const changeSort = (next: SortState) => {
    setSort(next);
    thyraLocalStorage.setItem(SORT_KEY, writeSort(next));
  };
  const changeView = (next: FileView) => {
    setView(next);
    thyraLocalStorage.setItem(VIEW_KEY, next);
  };

  /** Open the selection menu; a row outside the selection selects itself. */
  const openMenuAt = (path: string | null, x: number, y: number) => {
    const entry = path ? entries.get(path) : undefined;
    if (!entry) {
      select(null);
      setFolderMenuAt({ x, y });
      return;
    }
    const inSelection = selection.paths.has(entry.path);
    if (!inSelection) select(entry.path);
    setMenu({ x, y, entries: inSelection ? selected : [entry] });
  };

  const longPress = useLongPress((x, y) => {
    openMenuAt(pressedPath.current, x, y);
  });

  // --- Events (delegated from the body) ----------------------------------

  const pathFromEvent = (event: { target: EventTarget | null }) =>
    (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-file-path]",
    )?.dataset.filePath ?? null;

  const pressHandlers = {
    ...longPress.handlers,
    onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
      pointerType.current = event.pointerType;
      pressedPath.current = pathFromEvent(event);
      longPress.handlers.onPointerDown(event);
    },
  };

  const onBodyClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (longPress.consumeClick(event)) return;
    const entry = entries.get(pathFromEvent(event) ?? "");
    if (!entry) {
      if (event.target === event.currentTarget) select(null);
      return;
    }
    const target = event.target as HTMLElement;
    const action = target.closest(".file-row-action");
    if (action) {
      const rect = action.getBoundingClientRect();
      openMenuAt(entry.path, rect.left, rect.bottom);
      return;
    }
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      select(entry.path, {
        range: event.shiftKey,
        toggle: event.ctrlKey || event.metaKey,
      });
      return;
    }
    if (target.closest(".file-twisty")) {
      select(entry.path);
      toggleFolder(entry.path);
      return;
    }
    // Touch opens folders in the grid with one tap; a mouse selects first.
    if (
      view === "grid" &&
      isDirectoryEntry(entry) &&
      pointerType.current === "mouse"
    ) {
      select(entry.path);
      return;
    }
    open(entry);
  };

  const onBodyDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const entry = entries.get(pathFromEvent(event) ?? "");
    if (entry && isDirectoryEntry(entry)) void navigate(entry.path);
  };

  const columns = () => {
    if (view !== "grid") return 1;
    const tiles =
      bodyRef.current?.querySelectorAll<HTMLElement>("[data-file-path]");
    if (!tiles?.length) return 1;
    const top = tiles[0]!.offsetTop;
    let count = 0;
    for (const tile of tiles) {
      if (tile.offsetTop !== top) break;
      count += 1;
    }
    return Math.max(1, count);
  };

  const onBodyKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.matches("[data-file-path]")) return;
    const path = target.dataset.filePath!;
    const entry = entries.get(path);
    const index = rows.findIndex((row) => row.entry.path === path);
    if (!entry || index < 0) return;
    const { altKey, shiftKey, key } = event;
    const mod = event.ctrlKey || event.metaKey;
    const lower = key.toLowerCase();
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const targets = selection.paths.has(path) ? selected : [entry];
    if (altKey && (key === "ArrowLeft" || key === "ArrowRight")) {
      handled();
      if (key === "ArrowLeft") goBack();
      else goForward();
    } else if ((altKey && key === "ArrowUp") || key === "Backspace") {
      handled();
      goUp();
    } else if (altKey && key === "ArrowDown") {
      handled();
      open(entry, true);
    } else if (shiftKey && altKey && lower === "c") {
      handled();
      void copyPaths(
        targets.map((item) => item.path),
        mod,
      );
    } else if (key === "ContextMenu" || (shiftKey && key === "F10")) {
      handled();
      const rect = target.getBoundingClientRect();
      openMenuAt(path, rect.left + 24, rect.top + rect.height / 2);
    } else if (key === "F2" && actions.rename) {
      handled();
      actions.rename(entry);
    } else if (key === "Delete" && actions.remove) {
      handled();
      actions.remove(targets);
    } else if (mod && lower === "a") {
      handled();
      setSelection({
        paths: new Set(rows.map((row) => row.entry.path)),
        anchor: rows[0]?.entry.path ?? null,
      });
    } else if (mod && lower === "c" && actions.copy) {
      handled();
      actions.copy(targets);
    } else if (mod && lower === "x" && actions.cut) {
      handled();
      actions.cut(targets);
    } else if (mod && lower === "v" && actions.paste) {
      handled();
      actions.paste(targetFolder(targets));
    } else if (key === "Escape" && (selection.paths.size > 1 || clipboard)) {
      handled();
      if (clipboard?.mode === "cut") setFileClipboard(null);
      select(path);
    } else if (mod && key === " ") {
      handled();
      select(path, { toggle: true });
    } else if (key === "Enter" || key === " ") {
      handled();
      open(entry);
    } else if (
      view === "list" &&
      !shiftKey &&
      !mod &&
      (key === "ArrowRight" || key === "ArrowLeft")
    ) {
      handled();
      const folder = isDirectoryEntry(entry);
      const child = rows[index + 1];
      if (key === "ArrowRight") {
        if (folder && !expanded.has(path)) toggleFolder(path, true);
        else if (folder && child && child.depth === rows[index]!.depth + 1) {
          select(child.entry.path);
          focusPath(child.entry.path);
        }
      } else if (folder && expanded.has(path)) toggleFolder(path, false);
      else {
        const parent = parentPath(path, scope);
        if (entries.has(parent)) {
          select(parent);
          focusPath(parent);
        }
      }
    } else if (MOVE_KEYS.has(key)) {
      handled();
      const next =
        rows[
          moveIndex(index, key as MoveKey, rows.length, { columns: columns() })
        ];
      if (!next) return;
      // Shift extends the selection; Ctrl/Cmd moves the cursor alone.
      if (shiftKey) select(next.entry.path, { range: true });
      else if (!mod) select(next.entry.path);
      focusPath(next.entry.path);
    } else if (key.length === 1 && !mod && !altKey) {
      const now = Date.now();
      const text =
        now - typeahead.current.at < 700 ? typeahead.current.text + key : key;
      typeahead.current = { text, at: now };
      const match = typeaheadMatch(
        rows,
        text,
        text.length > 1 ? index - 1 : index,
      );
      if (match >= 0) {
        handled();
        select(rows[match]!.entry.path);
        focusPath(rows[match]!.entry.path);
      }
    }
  };

  const isFileDrag = (event: React.DragEvent) =>
    !readOnly && Array.from(event.dataTransfer.types).includes("Files");

  const dropFolder = (event: { target: EventTarget | null }) => {
    const entry = entries.get(pathFromEvent(event) ?? "");
    if (!entry) return here;
    if (isDirectoryEntry(entry)) return entry.path;
    return view === "grid" ? here : parentPath(entry.path, scope);
  };

  // --- Rendering ---------------------------------------------------------

  const crumbs = locationCrumbs(location, filesystem, rootLabel);
  const hereLabel = crumbs[crumbs.length - 1]?.label ?? location;
  const cutPaths =
    clipboard?.mode === "cut" && clipboardPaths
      ? new Set(clipboardPaths)
      : null;
  const iconSize = view === "grid" ? 40 : 16;
  const indent = (depth: number) =>
    view === "list" ? { paddingLeft: 4 + depth * 12 } : undefined;

  const createRow = (folder: string, depth: number) =>
    editing?.kind === "create" && editing.folder === folder ? (
      <div
        key={`create:${folder}`}
        className={`${view === "grid" ? "file-tile" : "file-row"} is-editing`}
        style={indent(depth)}
      >
        {view === "list" ? <span className="file-twisty" /> : null}
        <span className="file-icon">
          <FileIcon
            name=""
            directory={editing.type === "directory"}
            light={light}
            size={iconSize}
          />
        </span>
        <NameInput
          initial=""
          label={
            editing.type === "directory"
              ? t("New folder name")
              : t("New file name")
          }
          onCommit={(value) => void createEntry(editing.type, folder, value)}
          onCancel={() => setEditing(null)}
        />
      </div>
    ) : null;

  const renderRow = ({ entry, depth }: FileRow) => {
    const path = entry.path;
    const folder = isDirectoryEntry(entry);
    const isOpen = folder && expanded.has(path);
    const isSelected = selection.paths.has(path);
    const status = folder
      ? gitStatus?.directoryStatuses.get(path)
      : gitStatus?.fileStatuses.get(path);
    const meta = [
      symlinkDescription(entry),
      folder ? "" : formatSize(entry.size),
    ]
      .filter(Boolean)
      .join(" · ");
    const renaming = editing?.kind === "rename" && editing.path === path;
    const className = [
      view === "grid" ? "file-tile" : "file-row",
      isSelected ? "is-selected" : "",
      dropTarget === path ? "is-drop-target" : "",
      cutPaths?.has(path) ? "is-cut" : "",
      entry.ignored ? "is-ignored" : "",
      entry.hidden ? "is-hidden-entry" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const icon = (
      <FileIcon
        name={entry.name}
        directory={folder}
        open={isOpen}
        parent={baseName(parentPath(path, scope))}
        light={light}
        size={iconSize}
      />
    );
    const name = renaming ? (
      <NameInput
        initial={entry.name}
        label={t("New name for {name}", { name: entry.name })}
        onCommit={(value) => {
          setEditing(null);
          void rename(entry, value);
        }}
        onCancel={() => {
          setEditing(null);
          focusPath(path);
        }}
      />
    ) : (
      <span className="file-name">{entry.name}</span>
    );
    return [
      <div
        key={path}
        className={className}
        role={view === "grid" ? "option" : "treeitem"}
        data-file-path={path}
        tabIndex={path === (focused ?? rows[0]?.entry.path) ? 0 : -1}
        aria-level={view === "list" ? depth + 1 : undefined}
        aria-selected={isSelected}
        aria-expanded={view === "list" && folder ? isOpen : undefined}
        aria-current={path === activePath ? "true" : undefined}
        title={entry.ignored ? t("{path} · Ignored by Git", { path }) : path}
        style={indent(depth)}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setFocused(path);
        }}
      >
        {view === "list" ? (
          <>
            <span className="file-twisty" aria-hidden="true">
              {folder ? (
                isOpen ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )
              ) : null}
            </span>
            <span className="file-icon">{icon}</span>
            {name}
            {status ? (
              <span
                className="file-git-status"
                title={status.title}
                role="img"
                aria-label={status.title}
              >
                {status.codes.map((code) => (
                  <span
                    className={`git-status-code git-status-${code.toLowerCase()}`}
                    key={code}
                    aria-hidden="true"
                  >
                    {code}
                  </span>
                ))}
              </span>
            ) : null}
            {meta ? <span className="file-meta">{meta}</span> : null}
            <span className="file-meta file-meta-date">
              {shortDate(entry.mtime_ms)}
            </span>
          </>
        ) : (
          <>
            <FileThumbnail src={thumbnailSrc(entry)}>{icon}</FileThumbnail>
            {name}
          </>
        )}
        {loading.has(path) || busy.has(path) ? (
          <span className="row-spinner" />
        ) : null}
        <span className="file-row-action">
          <IconButton
            tabIndex={-1}
            label={t("Actions for {name}", { name: entry.name })}
            icon={<Ellipsis size={14} />}
          />
        </span>
      </div>,
      view === "list" && isOpen ? createRow(path, depth + 1) : null,
    ];
  };

  const counts = hereEntries
    ? filter
      ? `${rows.length}/${hereEntries.length}`
      : String(hereEntries.length)
    : null;
  const conflictAction = (policy: "rename" | "replace") => {
    const request = conflict;
    setConflict(null);
    if (request) void transfer(request, policy);
  };

  return (
    <div
      ref={rootRef}
      className={`file-manager is-${width}`}
      onMouseUp={(event) => {
        if (event.button === 3) goBack();
        if (event.button === 4) goForward();
      }}
    >
      <FileManagerNav
        workspaceId={workspaceId}
        filesystem={filesystem}
        location={location}
        rootPath={rootPath}
        rootLabel={rootLabel}
        canBack={history.back.length > 0}
        canForward={history.forward.length > 0}
        atRoot={atRoot}
        loading={loading.size > 0}
        canReveal={!!activePath && isAbsolutePath(activePath) === filesystem}
        onBack={goBack}
        onForward={goForward}
        onUp={goUp}
        onNavigate={(path) => void navigate(path)}
        onRefresh={() => reloadVisible()}
        onReveal={() => {
          reveal(activePath);
          if (activePath) focusPath(activePath);
        }}
      />
      <div className="ui-bar file-manager-tools">
        <SearchField
          className="file-manager-filter"
          fullWidth
          value={filter}
          onValueChange={(value) => update(() => ({ search: value }))}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            bodyRef.current
              ?.querySelector<HTMLElement>("[data-file-path]")
              ?.focus();
          }}
          placeholder={t("Filter")}
          aria-label={t("Filter loaded entries")}
          title={t(
            "Filter loaded names or paths. Globs: r*md, ?.txt, **/*.md, *.{md,txt}",
          )}
          maxLength={512}
        />
        {counts ? (
          <Token
            title={t("{count} entries", { count: hereEntries?.length ?? 0 })}
          >
            {counts}
          </Token>
        ) : null}
        <IconButton
          aria-pressed={view === "grid"}
          label={view === "grid" ? t("List view") : t("Grid view")}
          onClick={() => changeView(view === "grid" ? "list" : "grid")}
          icon={view === "grid" ? <List size={14} /> : <LayoutGrid size={14} />}
        />
        <Menu
          aria-label={t("Sort")}
          items={sortMenu(sort, changeSort)}
          trigger={
            <IconButton
              label={t("Sort")}
              icon={
                sort.descending ? (
                  <ArrowDownWideNarrow size={14} />
                ) : (
                  <ArrowUpNarrowWide size={14} />
                )
              }
            />
          }
        />
        <IconButton
          aria-pressed={showHidden}
          label={t("Show hidden files")}
          tooltip={showHidden ? t("Hide hidden files") : t("Show hidden files")}
          onClick={() => onShowHiddenChange(!showHidden)}
          icon={showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
        />
        {actions.create ? (
          <>
            <IconButton
              label={t("New file")}
              onClick={() => startCreate("file", targetFolder())}
              icon={<FilePlus size={14} />}
            />
            <IconButton
              label={t("New folder")}
              onClick={() => startCreate("directory", targetFolder())}
              icon={<FolderPlus size={14} />}
            />
            <IconButton
              label={t("Upload files")}
              tooltip={t("Upload files here")}
              onClick={() => actions.upload?.(targetFolder())}
              icon={<Upload size={14} />}
            />
          </>
        ) : null}
        <input
          ref={uploadRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void uploadFiles(uploadFolder.current || here, files);
          }}
        />
      </div>
      {error ? (
        <p className="file-manager-message is-error" role="alert">
          {error}
        </p>
      ) : null}
      {cache.rootInfo?.truncated && listKey(cache.rootInfo.root) === here ? (
        <p className="file-manager-message">
          {t("Showing the first {count} entries.", {
            count: hereEntries?.length ?? 0,
          })}
        </p>
      ) : null}
      {uploading ? (
        <p className="file-manager-message" role="status">
          <span className="row-spinner" />{" "}
          {uploading === 1
            ? t("Uploading 1 file")
            : t("Uploading {count} files", { count: uploading })}
        </p>
      ) : null}
      <div
        ref={bodyRef}
        className={`file-manager-body is-${view} ${dropTarget === here ? "is-drop-target" : ""}`}
        role={view === "grid" ? "listbox" : "tree"}
        aria-multiselectable="true"
        aria-label={t("Files in {path}", { path: hereLabel })}
        aria-busy={hereLoading}
        onClick={onBodyClick}
        onDoubleClick={onBodyDoubleClick}
        onKeyDown={onBodyKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenuAt(pathFromEvent(event), event.clientX, event.clientY);
        }}
        onDragOver={(event) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDropTarget(dropFolder(event));
        }}
        onDragLeave={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setDropTarget(null);
          }
        }}
        onDrop={(event) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          setDropTarget(null);
          void uploadFiles(
            dropFolder(event),
            Array.from(event.dataTransfer.files),
          );
        }}
        {...pressHandlers}
      >
        {createRow(here, 0)}
        {hereLoading ? (
          <div className="file-manager-message" role="status">
            {t("Loading directory...")}
          </div>
        ) : rows.length ? (
          rows.flatMap(renderRow)
        ) : hereEntries && editing?.kind !== "create" ? (
          <div className="file-manager-message">
            {filter ? t("No loaded entries match.") : t("Empty directory")}
          </div>
        ) : null}
      </div>
      <ContextMenu
        position={menu ? { x: menu.x, y: menu.y } : null}
        onClose={() => setMenu(null)}
        aria-label={t("File actions")}
        items={
          menu
            ? selectionMenu(menu.entries, targetFolder(menu.entries), actions)
            : []
        }
      />
      <ContextMenu
        position={folderMenuAt}
        onClose={() => setFolderMenuAt(null)}
        aria-label={t("Folder actions")}
        items={
          folderMenuAt
            ? folderMenu(here, actions, sortMenu(sort, changeSort))
            : []
        }
      />
      <ConfirmDialog
        open={pendingDelete.length > 0}
        onOpenChange={(next) => {
          if (!next) setPendingDelete([]);
        }}
        title={
          pendingDelete.length > 1
            ? t("Delete {count} Items", { count: pendingDelete.length })
            : pendingDelete[0] && isDirectoryEntry(pendingDelete[0])
              ? t("Delete Directory")
              : t("Delete File")
        }
        message={
          pendingDelete.length > 1
            ? t("Delete {count} items? This cannot be undone.", {
                count: pendingDelete.length,
              })
            : t('Delete "{path}"? This cannot be undone.', {
                path: pendingDelete[0]?.path ?? "",
              })
        }
        confirmLabel={t("Delete")}
        tone="danger"
        onConfirm={() => void remove(pendingDelete)}
      />
      <Dialog
        open={!!conflict}
        onOpenChange={(next) => {
          if (!next) setConflict(null);
        }}
        size="sm"
        title={t("Replace existing items?")}
        description={t(
          "The destination already has an item with the same name. Replace it, or keep both by giving the moved items a new name.",
        )}
        footer={
          <>
            <Button size="md" onClick={() => setConflict(null)}>
              {t("Cancel")}
            </Button>
            <Button
              size="md"
              variant="secondary"
              onClick={() => conflictAction("rename")}
            >
              {t("Keep both")}
            </Button>
            <Button
              size="md"
              variant="danger"
              onClick={() => conflictAction("replace")}
            >
              {t("Replace")}
            </Button>
          </>
        }
      />
    </div>
  );
}
