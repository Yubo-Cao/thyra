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
import { t } from "../../i18n";
import { store } from "../../store";
import { copyTextFromUserGesture } from "../../terminalClipboard";
import type { FileExplorerEntry } from "../../types";
import { useDocumentTheme } from "../documentTheme";
import {
  type buildGitStatusMaps,
  createExplorerEntry,
  deleteExplorerEntry,
  uploadExplorerFile,
} from "../fileExplorerResources";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ContextMenu } from "../ui/ContextMenu";
import { Dialog } from "../ui/Dialog";
import {
  type FileClipboard,
  clipboardPathsFor,
  setFileClipboard,
  useFileClipboard,
} from "./fileClipboard";
import { type DroppedFile, droppedFiles } from "./fileDrop";
import { followArchiveJob, trashToast } from "./fileJobs";
import { FileManagerTools, FileSelectionBar } from "./FileManagerBars";
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
  type FileScope,
  type FileView,
  type MoveKey,
  type SortState,
  ancestorsBetween,
  baseName,
  extensionOf,
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
import {
  type FileTools,
  archiveFormatOf,
  fileOperations,
  isConflictError,
} from "./fileOperations";
import { CreateEntryRow, FileEntryRow, type RowContext } from "./FileRowView";
import { canDropInto, useFileDrag } from "./useFileDrag";
import { useFileListing } from "./useFileListing";
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

type Editing =
  | { kind: "rename"; path: string }
  | { kind: "create"; type: "file" | "directory"; folder: string }
  | null;
type TransferRequest = {
  paths: string[];
  destination: string;
  mode: "move" | "copy";
};
type Conflict = "fail" | "rename" | "replace";

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
const kinds = (list: string, kind: string) =>
  list.split(" ").map((extension) => [extension, kind]);
// Thumbnail kinds by extension; the host may lack the tool for some.
const THUMBNAIL_KINDS: Record<string, "raster" | "image" | "video" | "pdf"> =
  Object.fromEntries([
    ...kinds("png jpg jpeg jfif webp gif bmp", "raster"),
    ...kinds("avif heic heif tif tiff", "image"),
    ...kinds("mp4 m4v mov webm mkv avi ogv", "video"),
    ["pdf", "pdf"],
  ]);
// SVG has no server thumbnail; small ones are shown as-is (inert in <img>).
const INLINE_SVG_MAX_BYTES = 64 * 1024;

/**
 * The Inspector's file manager, for the workspace checkout or the host
 * filesystem: a tree (List) or tiles (Grid) with multi-select, inline
 * rename and create, clipboard, drag and drop, trash, archives and
 * thumbnails. Every operation runs on the host that owns the files.
 */
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
  const [view, setView] = useState<FileView>(() =>
    thyraLocalStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list",
  );
  const [sort, setSort] = useState<SortState>(() =>
    readSort(thyraLocalStorage.getItem(SORT_KEY)),
  );
  const [selection, setSelection] = useState(() => ({
    paths: new Set(activePath ? [activePath] : []),
    anchor: activePath ?? (null as string | null),
  }));
  const [focused, setFocused] = useState<string | null>(activePath ?? null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entries: FileExplorerEntry[];
  } | null>(null);
  const [folderMenuAt, setFolderMenuAt] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [pendingDelete, setPendingDelete] = useState<FileExplorerEntry[]>([]);
  const [conflict, setConflict] = useState<TransferRequest | null>(null);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [width, setWidth] = useState<"narrow" | "medium" | "wide">("wide");
  const [selectionMode, setSelectionMode] = useState(false);
  const [tools, setTools] = useState<FileTools | null>(null);
  const clipboard = useFileClipboard();
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadFolder = useRef("");
  const typeahead = useRef({ text: "", at: 0 });

  const listing = useFileListing({
    client,
    workspaceId,
    scope,
    resourceKey,
    rootPath,
    memoryContext,
    initialLocation,
    showHidden,
    onRootResolved,
    onReset: () => {
      setMenu(null);
      setEditing(null);
    },
  });
  const { cache, here, loading, isCurrent } = listing;
  const { children, expanded, search: filter, error } = cache;

  useEffect(() => {
    let current = true;
    ops.tools().then(
      (result) => {
        if (current) setTools(result);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [ops]);

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
    { toggle = false, range = false } = {},
  ) => {
    if (!path) {
      setSelection({ paths: new Set(), anchor: null });
      return;
    }
    setSelection((current) => {
      if (range) {
        const paths = toggle ? new Set(current.paths) : new Set<string>();
        for (const item of rangeBetween(rows, current.anchor, path)) {
          paths.add(item);
        }
        return { paths, anchor: current.anchor ?? path };
      }
      if (toggle) {
        const paths = new Set(current.paths);
        if (!paths.delete(path)) paths.add(path);
        return { paths, anchor: path };
      }
      return { paths: new Set([path]), anchor: path };
    });
    setFocused(path);
  };
  const selectAll = (paths: string[]) =>
    setSelection({ paths: new Set(paths), anchor: paths[0] ?? null });

  // Touch selection mode ends with its last selected row.
  useEffect(() => {
    if (selectionMode && !selection.paths.size) setSelectionMode(false);
  }, [selectionMode, selection.paths.size]);

  // Reveal the previewed file: show its folder and expand down to it.
  const reveal = (path: string | undefined) => {
    if (!path || isAbsolutePath(path) !== filesystem) return;
    const inside = isWithin(path, here) && path !== here;
    const base = inside ? here : filesystem ? parentPath(path, scope) : "";
    if (!inside) void listing.navigate(base);
    const folders = view === "list" ? ancestorsBetween(base, path, scope) : [];
    if (folders.some((folder) => !expanded.has(folder))) {
      listing.update((current) => ({
        expanded: new Set([...current.expanded, ...folders]),
      }));
      for (const folder of folders) void listing.load(folder);
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
  const focusPath = (path: string) => {
    setFocused(path);
    const element = rowElement(path);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest" });
  };

  const focusedVisible = !!focused && entries.has(focused);
  useEffect(() => {
    if (focusedVisible && focused) {
      rowElement(focused)?.scrollIntoView({ block: "nearest" });
    }
  }, [focused, view, focusedVisible]);

  const hasRows = rows.length > 0;
  useEffect(() => {
    const body = bodyRef.current;
    if (!keyboardActive || !body || body.contains(document.activeElement)) {
      return;
    }
    const target =
      (focused && rowElement(focused)) ||
      body.querySelector<HTMLElement>("[data-file-path]");
    target?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardActive, hasRows]);

  const open = (entry: FileExplorerEntry, intoFolder = view === "grid") => {
    select(entry.path);
    if (isDirectoryEntry(entry)) {
      if (intoFolder) void listing.navigate(entry.path);
      else listing.toggleFolder(entry.path);
    } else if (entry.type === "symlink" && entry.symlink_status === "broken") {
      store.notify({
        kind: "error",
        message: t("Cannot open symlink"),
        detail: t("The symlink target does not exist or cannot be resolved."),
      });
    } else onOpenFile(entry);
  };

  // --- Operations --------------------------------------------------------

  const notifyError = (message: string, reason: unknown) =>
    store.notify({
      kind: "error",
      message,
      detail: (reason as Error).message,
    });
  const notifyDone = (message: string, detail?: string) =>
    store.notify({ kind: "success", message, detail, autoDismissMs: 4000 });

  const markBusy = (paths: string[], on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      for (const path of paths) {
        if (on) next.add(path);
        else next.delete(path);
      }
      return next;
    });

  /**
   * Run one operation: mark its rows busy, ignore its outcome once the
   * explorer moved on, and report failures `failed` does not handle.
   */
  const operate = async <T,>(
    paths: string[],
    failure: string,
    run: () => Promise<T>,
    done: (result: T) => void,
    failed?: (reason: unknown) => boolean,
  ) => {
    const token = listing.token();
    markBusy(paths, true);
    try {
      const result = await run();
      if (isCurrent(token)) done(result);
    } catch (reason) {
      if (isCurrent(token) && !failed?.(reason)) notifyError(failure, reason);
    } finally {
      if (isCurrent(token)) markBusy(paths, false);
    }
  };

  /** Re-list the folders an operation touched, and report the change. */
  const afterChange = (folders: string[], change?: FileManagerChange) => {
    listing.reloadFolders(folders);
    if (change) onChanged?.(change);
  };

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

  const uploadFiles = async (folder: string, files: File[]) => {
    const list = files.filter((file) => file.name);
    if (!list.length || readOnly) return;
    const token = listing.token();
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
      notifyDone(
        paths.length === 1
          ? t("File uploaded")
          : t("{count} files uploaded", { count: paths.length }),
        folder || rootLabel,
      );
    }
    listing.expand(folder);
    afterChange([folder], { paths });
  };

  /** Make a folder, accepting one that already exists. */
  const ensureFolder = async (path: string) => {
    try {
      await createExplorerEntry(client, workspaceId, path, "directory");
    } catch (reason) {
      if (!isConflictError(reason)) throw reason;
    }
  };

  /** Upload a desktop drop, making its folders first. */
  const uploadDropped = async (folder: string, files: DroppedFile[]) => {
    const token = listing.token();
    const made = new Set<string>();
    const groups = new Map<string, File[]>();
    try {
      for (const { folders, file } of files) {
        let path = folder;
        for (const name of folders) {
          path = joinPath(path, name);
          if (!made.has(path)) await ensureFolder(path);
          made.add(path);
        }
        if (file) groups.set(path, [...(groups.get(path) ?? []), file]);
      }
    } catch (reason) {
      if (isCurrent(token)) notifyError(t("Cannot create folder"), reason);
      return;
    }
    if (!isCurrent(token)) return;
    if (made.size) afterChange([folder]);
    for (const [path, list] of groups) await uploadFiles(path, list);
  };

  /** Create `a/b/c.txt` inside a folder, making missing folders on the way. */
  const createEntry = (
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
    const path = parts.reduce(joinPath, folder);
    void operate(
      [],
      kind === "file" ? t("Cannot create file") : t("Cannot create folder"),
      async () => {
        let parent = folder;
        for (const name of parts.slice(0, -1)) {
          parent = joinPath(parent, name);
          await ensureFolder(parent);
        }
        await createExplorerEntry(client, workspaceId, path, kind);
      },
      () => {
        for (const ancestor of [
          folder,
          ...ancestorsBetween(folder, path, scope),
        ]) {
          listing.expand(ancestor);
        }
        afterChange([folder, parentPath(path, scope)], { paths: [path] });
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
      },
    );
  };

  const rename = (entry: FileExplorerEntry, name: string) =>
    void operate(
      [entry.path],
      t("Rename failed"),
      () => ops.rename(entry.path, name),
      ({ path }) => {
        if (expanded.has(entry.path)) {
          listing.update((current) => ({
            expanded: new Set([
              ...[...current.expanded].filter(
                (item) => !isWithin(item, entry.path),
              ),
              path,
            ]),
          }));
        }
        afterChange([parentPath(entry.path, scope)], {
          paths: [entry.path],
          removed: true,
          moved: [{ from: entry.path, path }],
        });
        select(path);
      },
    );

  const transfer = (request: TransferRequest, conflictPolicy?: Conflict) => {
    const policy =
      conflictPolicy ?? (request.mode === "copy" ? "rename" : "fail");
    void operate(
      request.paths,
      request.mode === "copy" ? t("Copy failed") : t("Move failed"),
      () => ops.transfer({ ...request, conflict: policy }),
      ({ items }) => {
        const moved = items.filter((item) => item.from !== item.path);
        if (request.mode === "move" && clipboard?.mode === "cut") {
          setFileClipboard(null);
        }
        listing.expand(request.destination);
        afterChange(
          [
            request.destination,
            ...request.paths.map((path) => parentPath(path, scope)),
          ],
          request.mode === "move"
            ? { paths: moved.map((item) => item.from), removed: true, moved }
            : { paths: items.map((item) => item.path) },
        );
        selectAll(items.map((item) => item.path));
        if (items[0]) setFocused(items[0].path);
        const count = request.mode === "copy" ? items.length : moved.length;
        if (count) {
          notifyDone(
            request.mode === "copy"
              ? count === 1
                ? t("Copied 1 item")
                : t("Copied {count} items", { count })
              : count === 1
                ? t("Moved 1 item")
                : t("Moved {count} items", { count }),
            request.destination || rootLabel,
          );
        }
      },
      (reason) => {
        // A name clash on move asks to Replace or Keep both.
        if (policy !== "fail" || !isConflictError(reason)) return false;
        setConflict(request);
        return true;
      },
    );
  };

  const remove = (list: FileExplorerEntry[]) => {
    const paths = list.map((entry) => entry.path);
    void operate(
      paths,
      t("Delete failed"),
      async () => {
        for (const path of paths) {
          await deleteExplorerEntry(client, workspaceId, path);
        }
      },
      () => {
        select(null);
        afterChange(
          paths.map((path) => parentPath(path, scope)),
          { paths, removed: true },
        );
        notifyDone(
          paths.length === 1
            ? t("Deleted {name}", { name: baseName(paths[0]!) })
            : t("Deleted {count} items", { count: paths.length }),
        );
      },
    );
  };

  /** Move to the host's trash, with an Undo toast. */
  const trash = (list: FileExplorerEntry[]) => {
    const paths = list.map((entry) => entry.path);
    const folders = paths.map((path) => parentPath(path, scope));
    void operate(
      paths,
      t("Move to trash failed"),
      () => ops.trash(paths),
      ({ items, method }) => {
        select(null);
        setSelectionMode(false);
        afterChange(folders, { paths, removed: true });
        trashToast(
          method,
          items.map((item) => item.path),
          () =>
            void operate(
              [],
              t("Undo failed"),
              () => ops.restore(items.map((item) => item.token)),
              ({ paths: restored }) => {
                afterChange(folders, { paths: restored });
                selectAll(restored);
              },
            ),
        );
      },
    );
  };

  const runArchive = (
    start: () => Promise<{ job_id: string }>,
    titles: { running: string; done: string; failed: string },
    folder: string,
  ) => {
    const token = listing.token();
    void followArchiveJob(ops, start, titles).then((result) => {
      if (!result || !isCurrent(token)) return;
      afterChange([folder], { paths: [result] });
      select(result);
    });
  };

  /** The folder a paste or new entry targets for the current selection. */
  const targetFolder = (list: FileExplorerEntry[] = selected) => {
    const first = list[0];
    if (!first) return here;
    if (list.length === 1 && isDirectoryEntry(first)) return first.path;
    return parentPath(first.path, scope);
  };

  const target = {
    connectionId: client.connectionId,
    workspaceId,
    filesystem,
    root: rootPath,
  };
  const sourceOf = (
    mode: FileClipboard["mode"],
    paths: string[],
  ): FileClipboard => ({ mode, ...target, paths });

  const toClipboard = (mode: "copy" | "cut", list: FileExplorerEntry[]) => {
    if (!list.length) return;
    setFileClipboard(
      sourceOf(
        mode,
        list.map((entry) => entry.path),
      ),
    );
    const count = list.length;
    store.notify({
      kind: "info",
      message:
        mode === "cut"
          ? count === 1
            ? t("Cut 1 item")
            : t("Cut {count} items", { count })
          : count === 1
            ? t("Copied 1 item to the clipboard")
            : t("Copied {count} items to the clipboard", { count }),
      detail: t("Paste with {key}+V in a folder", { key: modifierKey }),
      autoDismissMs: 3000,
    });
  };

  /** Move or copy clipboard or dragged paths into a folder. */
  const transferFrom = (
    source: FileClipboard,
    folder: string,
    copy: boolean,
  ) => {
    const paths = clipboardPathsFor(source, target);
    if (!paths) {
      store.notify({
        kind: "error",
        message: t("Cannot paste here"),
        detail: t(
          "Items from another workspace paste only in Filesystem mode.",
        ),
      });
    } else if (canDropInto(folder, paths)) {
      transfer({ paths, destination: folder, mode: copy ? "copy" : "move" });
    }
  };

  /** null: the host can; a string: what to install; undefined: not offered. */
  const needs = (available: true | string | undefined, format: string) =>
    available === true || !tools
      ? null
      : t("Needs {tool} on the host", { tool: available ?? format });

  const changeSort = (next: SortState) => {
    setSort(next);
    thyraLocalStorage.setItem(SORT_KEY, writeSort(next));
  };

  const actions: FileMenuActions = {
    open,
    download,
    copyPaths: (paths, relative) => void copyPaths(paths, relative),
    refresh: () => listing.reloadVisible(),
    ...(readOnly
      ? {}
      : {
          rename: (entry) => {
            setSelectionMode(false);
            setEditing({ kind: "rename", path: entry.path });
          },
          duplicate: (list) => {
            const groups = new Map<string, string[]>();
            for (const { path } of list) {
              const folder = parentPath(path, scope);
              groups.set(folder, [...(groups.get(folder) ?? []), path]);
            }
            for (const [destination, paths] of groups) {
              transfer({ paths, destination, mode: "copy" });
            }
          },
          cut: (list) => toClipboard("cut", list),
          copy: (list) => toClipboard("copy", list),
          ...(clipboard
            ? {
                paste: (folder: string) =>
                  transferFrom(clipboard, folder, clipboard.mode === "copy"),
              }
            : {}),
          create: (kind, folder) => {
            listing.expand(folder);
            setEditing({ kind: "create", type: kind, folder });
          },
          upload: (folder) => {
            uploadFolder.current = folder;
            uploadRef.current?.click();
          },
          trash,
          remove: setPendingDelete,
          extract: (entry) =>
            runArchive(
              () => ops.extract(entry.path),
              {
                running: t("Extracting {name}", { name: entry.name }),
                done: t("Extracted {name}", { name: entry.name }),
                failed: t("Could not extract {name}", { name: entry.name }),
              },
              parentPath(entry.path, scope),
            ),
          extractBlocked: (entry) => {
            const format = isDirectoryEntry(entry)
              ? null
              : archiveFormatOf(entry.name);
            return format ? needs(tools?.extract[format], format) : undefined;
          },
          compress: (list, format) =>
            runArchive(
              () =>
                ops.compress(
                  list.map((entry) => entry.path),
                  format,
                ),
              {
                running:
                  list.length === 1
                    ? t("Compressing {name}", { name: list[0]!.name })
                    : t("Compressing {count} items", { count: list.length }),
                done: t("Created a .{format} archive", { format }),
                failed: t("Could not compress"),
              },
              list[0] ? parentPath(list[0].path, scope) : here,
            ),
          compressBlocked: (format) => needs(tools?.compress[format], format),
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
    const kind = THUMBNAIL_KINDS[extension];
    // Skip requests the host cannot answer (no ffmpeg, pdftoppm or vips).
    if (!kind || (kind !== "raster" && tools && !tools.thumbnails[kind])) {
      return null;
    }
    const size = Math.min(256, Math.ceil(72 * (window.devicePixelRatio || 1)));
    return fileUrl("/file/thumbnail", {
      path: entry.path,
      size: String(size),
      mtime: String(Math.round(entry.mtime_ms)),
      bytes: String(entry.size),
    });
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

  const pathOf = (target: EventTarget | null) =>
    (target as HTMLElement | null)?.closest<HTMLElement>("[data-file-path]")
      ?.dataset.filePath ?? null;

  /** Where a drop on an element lands: a folder row, else its folder. */
  const dropFolder = (target: EventTarget | null) => {
    const entry = entries.get(pathOf(target) ?? "");
    if (!entry) return here;
    if (isDirectoryEntry(entry)) return entry.path;
    return view === "grid" ? here : parentPath(entry.path, scope);
  };

  const drag = useFileDrag({
    readOnly,
    body: bodyRef,
    here,
    entry: (path) => entries.get(path),
    isOpen: (path) => view === "list" && expanded.has(path),
    openFolder: (path) =>
      view === "list"
        ? listing.toggleFolder(path, true)
        : void listing.navigate(path),
    dropFolder,
    dragPaths: (path) => {
      if (selection.paths.has(path)) return selected.map((entry) => entry.path);
      select(path);
      return [path];
    },
    source: (paths) => sourceOf("cut", paths),
    downloadUrl: (entry) => fileUrl("/file/download", { path: entry.path }),
    hostPath: (path) => hostPathOf(rootPath, path),
    onDropRows: transferFrom,
    onDropFiles: (folder, transfer) =>
      void droppedFiles(transfer).then((files) => uploadDropped(folder, files)),
    onLongPress(path, x, y) {
      const entry = path ? entries.get(path) : undefined;
      if (!entry) {
        openMenuAt(null, x, y);
        return;
      }
      // Long-press selects; the selection bar holds the commands.
      navigator.vibrate?.(10);
      setSelectionMode(true);
      if (!selection.paths.has(entry.path)) {
        select(entry.path, { toggle: selectionMode });
      }
    },
    isEditing: !!editing,
  });

  // --- Events (delegated from the body) ----------------------------------

  const onBodyClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (drag.consumeClick()) return;
    const entry = entries.get(pathOf(event.target) ?? "");
    if (!entry) {
      if (event.target === event.currentTarget) select(null);
      return;
    }
    const element = event.target as HTMLElement;
    const action = element.closest(".file-row-action");
    if (action) {
      const rect = action.getBoundingClientRect();
      openMenuAt(entry.path, rect.left, rect.bottom);
    } else if (event.shiftKey || event.ctrlKey || event.metaKey) {
      select(entry.path, {
        range: event.shiftKey,
        toggle: event.ctrlKey || event.metaKey,
      });
    } else if (element.closest(".file-twisty")) {
      select(entry.path);
      listing.toggleFolder(entry.path);
    } else if (selectionMode) {
      // In touch selection mode a tap adds or removes the row.
      select(entry.path, { toggle: true });
    } else if (
      view === "grid" &&
      isDirectoryEntry(entry) &&
      drag.pointerType.current === "mouse"
    ) {
      // A mouse selects a folder tile; a tap (or double-click) opens it.
      select(entry.path);
    } else open(entry);
  };

  const columns = () => {
    const tiles =
      view === "grid"
        ? bodyRef.current?.querySelectorAll<HTMLElement>("[data-file-path]")
        : undefined;
    if (!tiles?.length) return 1;
    let count = 0;
    while (
      count < tiles.length &&
      tiles[count]!.offsetTop === tiles[0]!.offsetTop
    ) {
      count += 1;
    }
    return count;
  };

  const onBodyKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const element = event.target as HTMLElement;
    if (!element.matches("[data-file-path]")) return;
    const path = element.dataset.filePath!;
    const entry = entries.get(path);
    const index = rows.findIndex((row) => row.entry.path === path);
    if (!entry || index < 0) return;
    const { altKey, shiftKey, key } = event;
    const mod = event.ctrlKey || event.metaKey;
    const lower = key.toLowerCase();
    const targets = selection.paths.has(path) ? selected : [entry];
    const run = (action: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    const moveTo = (next: string | undefined, extend = false) => {
      if (!next) return;
      // Shift extends the selection; Ctrl/Cmd moves the cursor alone.
      if (extend) select(next, { range: true });
      else if (!mod) select(next);
      focusPath(next);
    };
    const removal = shiftKey ? actions.remove : actions.trash;
    if (altKey && (key === "ArrowLeft" || key === "ArrowRight")) {
      run(key === "ArrowLeft" ? listing.goBack : listing.goForward);
    } else if (event.metaKey && key === "Backspace" && actions.trash) {
      run(() => actions.trash?.(targets));
    } else if ((altKey && key === "ArrowUp") || key === "Backspace") {
      run(listing.goUp);
    } else if (altKey && key === "ArrowDown") {
      run(() => open(entry, true));
    } else if (shiftKey && altKey && lower === "c") {
      run(
        () =>
          void copyPaths(
            targets.map((item) => item.path),
            mod,
          ),
      );
    } else if (key === "ContextMenu" || (shiftKey && key === "F10")) {
      run(() => {
        const rect = element.getBoundingClientRect();
        openMenuAt(path, rect.left + 24, rect.top + rect.height / 2);
      });
    } else if (key === "F2" && actions.rename) {
      run(() => actions.rename?.(entry));
    } else if (key === "Delete" && removal) {
      run(() => removal(targets));
    } else if (mod && lower === "a") {
      run(() => selectAll(rows.map((row) => row.entry.path)));
    } else if (mod && (lower === "c" || lower === "x") && actions.copy) {
      run(() => (lower === "c" ? actions.copy : actions.cut)?.(targets));
    } else if (mod && lower === "v" && actions.paste) {
      run(() => actions.paste?.(targetFolder(targets)));
    } else if (key === "Escape" && (selection.paths.size > 1 || clipboard)) {
      run(() => {
        if (clipboard?.mode === "cut") setFileClipboard(null);
        select(path);
      });
    } else if (mod && key === " ") {
      run(() => select(path, { toggle: true }));
    } else if (key === "Enter" || key === " ") {
      run(() => open(entry));
    } else if (
      view === "list" &&
      !shiftKey &&
      !mod &&
      (key === "ArrowRight" || key === "ArrowLeft")
    ) {
      // Right expands, then steps in; Left collapses, then steps out.
      const folder = isDirectoryEntry(entry);
      const child = rows[index + 1];
      const parent = parentPath(path, scope);
      run(() => {
        if (key === "ArrowRight" && folder && !expanded.has(path)) {
          listing.toggleFolder(path, true);
        } else if (key === "ArrowRight") {
          if (folder && child?.depth === rows[index]!.depth + 1) {
            moveTo(child.entry.path);
          }
        } else if (folder && expanded.has(path)) {
          listing.toggleFolder(path, false);
        } else if (entries.has(parent)) moveTo(parent);
      });
    } else if (MOVE_KEYS.has(key)) {
      const next = moveIndex(index, key as MoveKey, rows.length, {
        columns: columns(),
      });
      run(() => moveTo(rows[next]?.entry.path, shiftKey));
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
      if (match >= 0) run(() => moveTo(rows[match]!.entry.path));
    }
  };

  // --- Rendering ---------------------------------------------------------

  const crumbs = locationCrumbs(listing.location, filesystem, rootLabel);
  const hereLabel = crumbs[crumbs.length - 1]?.label ?? listing.location;
  const clipboardPaths = clipboard
    ? clipboardPathsFor(clipboard, target)
    : null;
  const rowContext: RowContext = {
    view,
    light,
    parentName: (path) => baseName(parentPath(path, scope)),
    tabStop: focused ?? rows[0]?.entry.path,
    activePath,
    selected: selection.paths,
    expanded,
    dropTarget: drag.dropTarget,
    cut:
      clipboard?.mode === "cut" && clipboardPaths
        ? new Set(clipboardPaths)
        : null,
    busy: (path) => loading.has(path) || busy.has(path),
    gitStatus,
    renaming: editing?.kind === "rename" ? editing.path : null,
    thumbnail: thumbnailSrc,
    onFocus: setFocused,
    onRename: (entry, name) => {
      setEditing(null);
      rename(entry, name);
    },
    onRenameCancel: (path) => {
      setEditing(null);
      focusPath(path);
    },
  };
  const createRow = (folder: string, depth: number) =>
    editing?.kind === "create" && editing.folder === folder ? (
      <CreateEntryRow
        key={`create:${folder}`}
        type={editing.type}
        depth={depth}
        view={view}
        light={light}
        onCommit={(value) => createEntry(editing.type, folder, value)}
        onCancel={() => setEditing(null)}
      />
    ) : null;
  const conflictAction = (policy: Conflict) => {
    const request = conflict;
    setConflict(null);
    if (request) transfer(request, policy);
  };

  return (
    <div
      ref={rootRef}
      className={`file-manager is-${width}`}
      onMouseUp={(event) => {
        if (event.button === 3) listing.goBack();
        if (event.button === 4) listing.goForward();
      }}
    >
      <FileManagerNav
        workspaceId={workspaceId}
        filesystem={filesystem}
        location={listing.location}
        rootPath={rootPath}
        rootLabel={rootLabel}
        canBack={listing.canBack}
        canForward={listing.canForward}
        atRoot={listing.atRoot}
        loading={loading.size > 0}
        canReveal={!!activePath && isAbsolutePath(activePath) === filesystem}
        onBack={listing.goBack}
        onForward={listing.goForward}
        onUp={listing.goUp}
        onNavigate={(path) => void listing.navigate(path)}
        onRefresh={() => listing.reloadVisible()}
        onReveal={() => {
          reveal(activePath);
          if (activePath) focusPath(activePath);
        }}
      />
      <FileManagerTools
        filter={filter}
        onFilter={(value) => listing.update(() => ({ search: value }))}
        onFilterExit={() =>
          bodyRef.current
            ?.querySelector<HTMLElement>("[data-file-path]")
            ?.focus()
        }
        count={
          hereEntries ? { shown: rows.length, total: hereEntries.length } : null
        }
        view={view}
        onView={(next) => {
          setView(next);
          thyraLocalStorage.setItem(VIEW_KEY, next);
        }}
        sort={sort}
        onSort={changeSort}
        showHidden={showHidden}
        onShowHidden={onShowHiddenChange}
        onCreate={
          actions.create
            ? (kind) => actions.create?.(kind, targetFolder())
            : undefined
        }
        onUpload={
          actions.upload ? () => actions.upload?.(targetFolder()) : undefined
        }
      />
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
      {error ? (
        <p className="file-manager-message is-error" role="alert">
          {error}
        </p>
      ) : null}
      {cache.rootInfo?.truncated &&
      listing.listKey(cache.rootInfo.root) === here ? (
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
        className={`file-manager-body is-${view} ${drag.dropTarget === here ? "is-drop-target" : ""}`}
        role={view === "grid" ? "listbox" : "tree"}
        aria-multiselectable="true"
        aria-label={t("Files in {path}", { path: hereLabel })}
        aria-busy={hereLoading}
        onClick={onBodyClick}
        onDoubleClick={(event) => {
          const entry = entries.get(pathOf(event.target) ?? "");
          if (entry && isDirectoryEntry(entry)) {
            void listing.navigate(entry.path);
          }
        }}
        onKeyDown={onBodyKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          // Touch long-press is handled by the press gesture instead.
          if (drag.pointerType.current !== "mouse") return;
          openMenuAt(pathOf(event.target), event.clientX, event.clientY);
        }}
        {...drag.handlers}
      >
        {createRow(here, 0)}
        {hereLoading ? (
          <div className="file-manager-message" role="status">
            {t("Loading directory...")}
          </div>
        ) : rows.length ? (
          rows.flatMap((row) => [
            <FileEntryRow
              key={row.entry.path}
              row={row}
              context={rowContext}
            />,
            view === "list" && expanded.has(row.entry.path)
              ? createRow(row.entry.path, row.depth + 1)
              : null,
          ])
        ) : hereEntries && editing?.kind !== "create" ? (
          <div className="file-manager-message">
            {filter ? t("No loaded entries match.") : t("Empty directory")}
          </div>
        ) : null}
      </div>
      {selectionMode || selected.length > 1 ? (
        <FileSelectionBar
          selected={selected}
          actions={actions}
          folder={targetFolder()}
          onMore={(x, y) => setMenu({ x, y, entries: selected })}
          onDone={() => {
            setSelectionMode(false);
            select(null);
          }}
        />
      ) : null}
      {drag.ghost ? (
        <div
          className="file-manager-drag-badge is-touch"
          style={{ left: drag.ghost.x + 12, top: drag.ghost.y + 12 }}
          aria-hidden="true"
        >
          {drag.ghost.label}
        </div>
      ) : null}
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
        onConfirm={() => remove(pendingDelete)}
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
