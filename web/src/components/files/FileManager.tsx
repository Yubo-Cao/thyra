import {
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpNarrowWide,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Eye,
  EyeOff,
  FilePlus,
  Folder,
  FolderPlus,
  LayoutGrid,
  List,
  RefreshCw,
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
import {
  filesystemBaseName,
  filesystemBreadcrumbs,
  normalizeFilesystemPath,
} from "../../filesystemPaths";
import { t } from "../../i18n";
import { store, useStoreSelector } from "../../store";
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
import { TextInputDialog } from "../ModalDialogs";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ContextMenu } from "../ui/ContextMenu";
import { IconButton } from "../ui/IconButton";
import { Menu, type MenuEntry } from "../ui/Menu";
import { SearchField } from "../ui/SearchField";
import { TextField } from "../ui/TextField";
import { Token } from "../ui/Token";
import { useLongPress } from "../useLongPress";
import {
  type FileRow,
  type FileScope,
  type FileView,
  type MoveKey,
  type SortKey,
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
  relativePathOf,
  typeaheadMatch,
  visibleRows,
} from "./fileManagerModel";
import { FileIcon, FileThumbnail } from "./FileVisual";
import "./FileManager.css";

type GitStatusMaps = ReturnType<typeof buildGitStatusMaps>;

export type FileManagerChange = {
  /** Paths whose content or existence changed. */
  paths: string[];
  /** The paths no longer exist (deleted or moved away). */
  removed?: boolean;
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

type MenuState = { x: number; y: number; path: string | null };

const VIEW_KEY = "fileManagerView";
const SORT_KEY = "fileManagerSort";
const SORT_KEYS: SortKey[] = ["name", "type", "size", "modified"];

function readSort(): SortState {
  const [key, order] = (thyraLocalStorage.getItem(SORT_KEY) ?? "").split(":");
  return {
    key: SORT_KEYS.includes(key as SortKey) ? (key as SortKey) : "name",
    descending: order === "desc",
  };
}

const THUMBNAIL_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "jfif",
  "webp",
  "gif",
  "bmp",
  "avif",
  "heic",
  "heif",
  "tif",
  "tiff",
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mkv",
  "avi",
  "ogv",
  "pdf",
]);
// SVG has no server thumbnail; small ones are shown as-is (inert in <img>).
const INLINE_SVG_MAX_BYTES = 64 * 1024;

function relativeTime(ms: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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
  const [sort, setSort] = useState<SortState>(readSort);
  const [selected, setSelected] = useState<string | null>(activePath ?? null);
  const [focused, setFocused] = useState<string | null>(activePath ?? null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [creating, setCreating] = useState<"file" | "directory" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FileExplorerEntry | null>(
    null,
  );
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<"narrow" | "medium" | "wide">("wide");
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
  const uploadRef = useRef<HTMLInputElement>(null);
  const contextRef = useRef(0);
  const typeahead = useRef({ text: "", at: 0 });
  const { children, expanded, search: filter, error } = cache;
  const listKey = (path: string) =>
    filesystem ? normalizeFilesystemPath(path) : path;
  const rootLocation = filesystem ? null : "";

  const update = (
    patch: (current: FileExplorerCache) => Partial<FileExplorerCache>,
  ) =>
    setCache((current) => {
      const next = { ...current, ...patch(current) };
      writeExplorerCache(client, workspaceId, showHidden, next, cacheKey);
      return next;
    });

  // A new connection, workspace, scope or hidden-file setting starts over.
  const context = `${client.connectionId}\n${client.generation}\n${workspaceId}\n${cacheKey}\n${showHidden}`;
  const contextKey = useRef(context);
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
      if (isCurrent(token))
        update(() => ({ error: (reason as Error).message }));
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
    const paths = new Set([listKey(location), ...extra]);
    for (const path of expanded) if (isWithin(path, location)) paths.add(path);
    for (const path of paths) void load(path, true);
  };

  useEffect(() => {
    contextKey.current = context;
    contextRef.current += 1;
    const fresh = readCache();
    setCache(fresh);
    setLoading(new Set());
    setMenu(null);
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
    setEditingPath(false);
    const previous = location;
    const listed = await load(path, true);
    if (listed === null) return;
    setLocation(listed);
    if (filesystem)
      writeExplorerViewMemory(memoryContext, { directory: listed });
    else update(() => ({ location: listed }));
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
  const parentOfLocation = parentPath(location, scope);
  const atRoot = filesystem
    ? normalizeFilesystemPath(parentOfLocation) ===
      normalizeFilesystemPath(location)
    : location === rootLocation;
  const goUp = () => {
    if (!atRoot) void navigate(parentOfLocation);
  };

  const rows = useMemo(
    () =>
      visibleRows({
        root: listKey(location),
        children,
        expanded,
        sort,
        filter,
        view,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [children, expanded, filter, location, sort, view],
  );
  const entries = useMemo(
    () => new Map(rows.map((row) => [row.entry.path, row.entry])),
    [rows],
  );
  const locationEntries = children[listKey(location)];
  const locationLoading = loading.has(listKey(location)) && !locationEntries;

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
    if (!path) return;
    if (isAbsolutePath(path) !== filesystem) return;
    const base = listKey(location);
    if (!isWithin(path, base) || path === base) {
      void navigate(filesystem ? parentPath(path, scope) : "");
      return;
    }
    const folders = ancestorsBetween(base, path, scope);
    if (folders.some((folder) => !expanded.has(folder))) {
      update((current) => ({
        expanded: new Set([...current.expanded, ...folders]),
      }));
      for (const folder of folders) void load(folder);
    }
    setSelected(path);
    setFocused(path);
  };
  useEffect(() => {
    if (activePath) reveal(activePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  const rowElement = (path: string) =>
    bodyRef.current?.querySelector<HTMLElement>(
      `[data-file-path="${CSS.escape(path)}"]`,
    ) ?? null;

  useEffect(() => {
    if (focused && entries.has(focused)) {
      rowElement(focused)?.scrollIntoView({ block: "nearest" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, view]);

  useEffect(() => {
    if (!keyboardActive) return;
    const body = bodyRef.current;
    if (!body || body.contains(document.activeElement)) return;
    const target =
      (focused && rowElement(focused)) ||
      body.querySelector<HTMLElement>("[data-file-path]");
    target?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardActive, rows.length > 0]);

  const focusPath = (path: string) => {
    setFocused(path);
    const element = rowElement(path);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest" });
  };

  const open = (entry: FileExplorerEntry, intoFolder = view === "grid") => {
    setSelected(entry.path);
    setFocused(entry.path);
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

  const hostPath = (path: string) => hostPathOf(rootPath, path);
  const relativePath = (path: string) => relativePathOf(rootPath, path);

  const copyPath = async (value: string) => {
    try {
      await copyTextFromUserGesture(value);
      store.notify({
        kind: "success",
        message: t("Path copied"),
        detail: value,
        autoDismissMs: 5000,
      });
    } catch (reason) {
      store.notify({
        kind: "error",
        message: t("Failed to copy path"),
        detail: (reason as Error).message,
      });
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
    const directory = isDirectoryEntry(entry);
    void downloadFileFromUrl({
      url: fileUrl("/file/download", { path: entry.path }),
      filename: directory ? `${entry.name || "download"}.tar.gz` : entry.name,
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

  const markBusy = (path: string, on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });

  const uploadFiles = async (directory: string, files: File[]) => {
    const list = files.filter((file) => file.name);
    if (!list.length || readOnly) return;
    const token = contextRef.current;
    setUploading((count) => count + list.length);
    let uploaded = 0;
    const paths: string[] = [];
    for (const file of list) {
      try {
        const result = await uploadExplorerFile(
          client,
          workspaceId,
          directory,
          file,
        );
        paths.push(result.path);
        uploaded += 1;
      } catch (reason) {
        if (!isCurrent(token)) return;
        store.notify({
          kind: "error",
          message: t("Upload failed: {name}", { name: file.name }),
          detail: (reason as Error).message,
        });
      } finally {
        if (isCurrent(token)) setUploading((count) => Math.max(0, count - 1));
      }
    }
    if (!isCurrent(token)) return;
    if (uploaded) {
      store.notify({
        kind: "success",
        message:
          uploaded === 1
            ? t("File uploaded")
            : t("{count} files uploaded", { count: uploaded }),
        detail: directory || rootLabel,
        autoDismissMs: 5000,
      });
      onChanged?.({ paths });
    }
    if (directory !== listKey(location) && !expanded.has(directory)) {
      toggleFolder(directory, true);
    }
    void load(directory, true);
  };

  const createEntry = async (kind: "file" | "directory", value: string) => {
    const name = value
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    if (!name) return;
    const token = contextRef.current;
    try {
      const created = await createExplorerEntry(
        client,
        workspaceId,
        joinPath(location, name),
        kind,
      );
      if (!isCurrent(token)) return;
      const parent = parentPath(created.path, scope);
      for (const folder of ancestorsBetween(
        listKey(location),
        created.path,
        scope,
      )) {
        if (!expanded.has(folder)) toggleFolder(folder, true);
      }
      await load(parent, true);
      setSelected(created.path);
      setFocused(created.path);
      onChanged?.({ paths: [created.path] });
      if (kind === "file") {
        onOpenFile({
          name: baseName(created.path),
          path: created.path,
          type: "file",
          size: 0,
          mtime_ms: Date.now(),
          hidden: baseName(created.path).startsWith("."),
        });
      }
    } catch (reason) {
      if (!isCurrent(token)) return;
      store.notify({
        kind: "error",
        message:
          kind === "file" ? t("Cannot create file") : t("Cannot create folder"),
        detail: (reason as Error).message,
      });
    }
  };

  const deleteEntry = async (entry: FileExplorerEntry) => {
    const token = contextRef.current;
    markBusy(entry.path, true);
    try {
      await deleteExplorerEntry(client, workspaceId, entry.path);
      if (!isCurrent(token)) return;
      onChanged?.({ paths: [entry.path], removed: true });
      void load(parentPath(entry.path, scope), true);
      store.notify({
        kind: "success",
        message:
          entry.type === "symlink"
            ? t("Symlink deleted")
            : isDirectoryEntry(entry)
              ? t("Directory deleted")
              : t("File deleted"),
        detail: entry.path,
        autoDismissMs: 5000,
      });
    } catch (reason) {
      if (!isCurrent(token)) return;
      store.notify({
        kind: "error",
        message: t("Delete failed"),
        detail: (reason as Error).message,
      });
    } finally {
      if (isCurrent(token)) markBusy(entry.path, false);
    }
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

  // --- Menus -------------------------------------------------------------

  const folderOf = (entry: FileExplorerEntry | undefined) =>
    entry
      ? isDirectoryEntry(entry)
        ? entry.path
        : parentPath(entry.path, scope)
      : listKey(location);

  const entryMenu = (entry: FileExplorerEntry): MenuEntry[] => {
    const directory = isDirectoryEntry(entry);
    return [
      {
        items: [
          {
            id: "open",
            label: directory ? t("Open folder") : t("Open"),
            onAction: () => open(entry, true),
          },
          {
            id: "download",
            label: directory ? t("Download directory") : t("Download file"),
            onAction: () => download(entry),
          },
        ],
      },
      {
        items: [
          {
            id: "copy-path",
            label: t("Copy path"),
            shortcut: "Shift+Alt+C",
            onAction: () => void copyPath(hostPath(entry.path)),
          },
          {
            id: "copy-relative-path",
            label: t("Copy relative path"),
            onAction: () => void copyPath(relativePath(entry.path)),
          },
        ],
      },
      ...(readOnly
        ? []
        : [
            {
              danger: true,
              items: [
                {
                  id: "delete",
                  label:
                    entry.type === "symlink"
                      ? t("Delete symlink")
                      : directory
                        ? t("Delete directory")
                        : t("Delete file"),
                  onAction: () => setPendingDelete(entry),
                },
              ],
            },
          ]),
    ];
  };

  const sortMenu: MenuEntry[] = [
    {
      title: t("Sort by"),
      selectionMode: "single",
      items: SORT_KEYS.map((key) => ({
        id: `sort-${key}`,
        label:
          key === "name"
            ? t("Name")
            : key === "type"
              ? t("Type")
              : key === "size"
                ? t("Size")
                : t("Modified"),
        checked: sort.key === key,
        onAction: () => changeSort({ key, descending: sort.descending }),
      })),
    },
    {
      selectionMode: "single",
      items: [
        {
          id: "sort-ascending",
          label: t("Ascending"),
          checked: !sort.descending,
          onAction: () => changeSort({ ...sort, descending: false }),
        },
        {
          id: "sort-descending",
          label: t("Descending"),
          checked: sort.descending,
          onAction: () => changeSort({ ...sort, descending: true }),
        },
      ],
    },
  ];

  const backgroundMenu = (): MenuEntry[] => [
    ...(readOnly
      ? []
      : [
          {
            items: [
              {
                id: "new-file",
                label: t("New file"),
                onAction: () => setCreating("file"),
              },
              {
                id: "new-folder",
                label: t("New folder"),
                onAction: () => setCreating("directory"),
              },
              {
                id: "upload",
                label: t("Upload files"),
                onAction: () => uploadRef.current?.click(),
              },
            ],
          },
        ]),
    {
      items: [
        {
          id: "copy-folder-path",
          label: t("Copy path"),
          onAction: () => void copyPath(hostPath(location)),
        },
        {
          id: "refresh",
          label: t("Refresh"),
          onAction: () => reloadVisible(),
        },
      ],
    },
    ...sortMenu,
  ];

  const changeSort = (next: SortState) => {
    setSort(next);
    thyraLocalStorage.setItem(
      SORT_KEY,
      `${next.key}:${next.descending ? "desc" : "asc"}`,
    );
  };
  const changeView = (next: FileView) => {
    setView(next);
    thyraLocalStorage.setItem(VIEW_KEY, next);
  };

  const openMenuAt = (path: string | null, x: number, y: number) => {
    if (path) {
      setSelected(path);
      setFocused(path);
    }
    setMenu({ x, y, path });
  };

  const pressedPath = useRef<string | null>(null);
  const pointerType = useRef("mouse");
  const longPress = useLongPress((x, y) => {
    openMenuAt(pressedPath.current, x, y);
  });
  const pressHandlers = {
    ...longPress.handlers,
    onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
      pointerType.current = event.pointerType;
      const path = pathFromEvent(event);
      pressedPath.current = path && entries.has(path) ? path : null;
      longPress.handlers.onPointerDown(event);
    },
  };

  // --- Events (delegated from the body) ----------------------------------

  const pathFromEvent = (event: { target: EventTarget | null }) =>
    (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-file-path]",
    )?.dataset.filePath ?? null;

  const onBodyClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (longPress.consumeClick(event)) return;
    const path = pathFromEvent(event);
    const entry = path ? entries.get(path) : undefined;
    if (!entry) {
      setSelected(null);
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest(".file-row-action")) {
      const rect = target.closest(".file-row-action")!.getBoundingClientRect();
      openMenuAt(entry.path, rect.left, rect.bottom);
      return;
    }
    if (target.closest(".file-twisty")) {
      setFocused(entry.path);
      toggleFolder(entry.path);
      return;
    }
    // Touch opens folders in the grid with one tap; a mouse selects first.
    const touch = pointerType.current !== "mouse";
    if (view === "grid" && isDirectoryEntry(entry) && !touch) {
      setSelected(entry.path);
      setFocused(entry.path);
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
    const { key, altKey, shiftKey, ctrlKey, metaKey } = event;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (altKey && (key === "ArrowLeft" || key === "ArrowRight")) {
      handled();
      if (key === "ArrowLeft") goBack();
      else goForward();
      return;
    }
    if ((altKey && key === "ArrowUp") || key === "Backspace") {
      handled();
      goUp();
      return;
    }
    if (altKey && key === "ArrowDown") {
      handled();
      open(entry, true);
      return;
    }
    if (shiftKey && altKey && key.toLowerCase() === "c") {
      handled();
      void copyPath(hostPath(path));
      return;
    }
    if (key === "ContextMenu" || (shiftKey && key === "F10")) {
      handled();
      const rect = target.getBoundingClientRect();
      openMenuAt(path, rect.left + 24, rect.top + rect.height / 2);
      return;
    }
    if (key === "Enter" || key === " ") {
      handled();
      open(entry);
      return;
    }
    if (view === "list" && (key === "ArrowRight" || key === "ArrowLeft")) {
      handled();
      const folder = isDirectoryEntry(entry);
      if (key === "ArrowRight") {
        if (folder && !expanded.has(path)) toggleFolder(path, true);
        else if (folder && rows[index + 1]?.depth === rows[index]!.depth + 1) {
          focusPath(rows[index + 1]!.entry.path);
        }
      } else if (folder && expanded.has(path)) toggleFolder(path, false);
      else {
        const parent = parentPath(path, scope);
        if (entries.has(parent)) focusPath(parent);
      }
      return;
    }
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ].includes(key) &&
      !ctrlKey &&
      !metaKey
    ) {
      handled();
      const next =
        rows[
          moveIndex(index, key as MoveKey, rows.length, { columns: columns() })
        ];
      if (next) {
        setSelected(next.entry.path);
        focusPath(next.entry.path);
      }
      return;
    }
    if (key.length === 1 && !ctrlKey && !metaKey && !altKey && key !== " ") {
      const now = Date.now();
      typeahead.current = {
        text:
          now - typeahead.current.at < 700 ? typeahead.current.text + key : key,
        at: now,
      };
      const match = typeaheadMatch(
        rows,
        typeahead.current.text,
        typeahead.current.text.length > 1 ? index - 1 : index,
      );
      if (match >= 0) {
        handled();
        setSelected(rows[match]!.entry.path);
        focusPath(rows[match]!.entry.path);
      }
    }
  };

  const isFileDrag = (event: React.DragEvent) =>
    !readOnly && Array.from(event.dataTransfer.types).includes("Files");

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const entry = entries.get(pathFromEvent(event) ?? "");
    setDropTarget(
      entry && view === "list" ? folderOf(entry) : listKey(location),
    );
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    const entry = entries.get(pathFromEvent(event) ?? "");
    const target =
      entry && (view === "list" || isDirectoryEntry(entry))
        ? folderOf(entry)
        : listKey(location);
    setDropTarget(null);
    void uploadFiles(target, Array.from(event.dataTransfer.files));
  };

  // --- Rendering ---------------------------------------------------------

  const crumbs = filesystem
    ? filesystemBreadcrumbs(location)
    : [
        { label: rootLabel || t("Workspace"), path: "" },
        ...location
          .split("/")
          .filter(Boolean)
          .map((part, index, parts) => ({
            label: part,
            path: parts.slice(0, index + 1).join("/"),
          })),
      ];
  const visibleCrumbs: Array<{
    label: string;
    path: string;
    collapsed?: boolean;
  }> =
    crumbs.length > 5
      ? [
          crumbs[0]!,
          {
            label: "...",
            path: crumbs[crumbs.length - 4]!.path,
            collapsed: true,
          },
          ...crumbs.slice(-3),
        ]
      : crumbs;

  const paneCwds = useStoreSelector((state) =>
    filesystem
      ? state.panes
          .filter((pane) => pane.workspace_id === workspaceId)
          .map((pane) => pane.foreground_cwd ?? pane.cwd ?? "")
          .filter(Boolean)
          .join("\n")
      : "",
  );
  const places = useMemo(() => {
    if (!filesystem) return [];
    const seen = new Set<string>();
    const result: Array<{
      key: string;
      label: string;
      path: string;
      title: string;
    }> = [];
    const add = (key: string, label: string, path: string, title = path) => {
      const normalized = path.startsWith("~")
        ? path
        : normalizeFilesystemPath(path);
      if (!path || seen.has(normalized)) return;
      seen.add(normalized);
      result.push({ key, label, path, title });
    };
    if (rootPath) add("workspace", t("Workspace"), rootPath);
    for (const cwd of paneCwds ? paneCwds.split("\n") : []) {
      add(
        `cwd:${cwd}`,
        filesystemBaseName(cwd),
        cwd,
        t("Pane directory {path}", { path: cwd }),
      );
    }
    add("home", t("Home"), "~", t("Home directory on the connected host"));
    add("root", "/", "/", t("Filesystem root"));
    return result;
  }, [filesystem, paneCwds, rootPath]);

  const renderRow = ({ entry, depth }: FileRow) => {
    const path = entry.path;
    const folder = isDirectoryEntry(entry);
    const isOpen = folder && expanded.has(path);
    const status = folder
      ? gitStatus?.directoryStatuses.get(path)
      : gitStatus?.fileStatuses.get(path);
    const meta = [
      symlinkDescription(entry),
      folder ? "" : formatSize(entry.size),
    ]
      .filter(Boolean)
      .join(" · ");
    const className = [
      view === "grid" ? "file-tile" : "file-row",
      path === selected || path === activePath ? "is-selected" : "",
      dropTarget === path ? "is-drop-target" : "",
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
        size={view === "grid" ? 40 : 16}
      />
    );
    return (
      <div
        key={path}
        className={className}
        role={view === "grid" ? "option" : "treeitem"}
        data-file-path={path}
        tabIndex={path === (focused ?? rows[0]?.entry.path) ? 0 : -1}
        aria-level={view === "list" ? depth + 1 : undefined}
        aria-selected={path === selected}
        aria-expanded={view === "list" && folder ? isOpen : undefined}
        title={entry.ignored ? t("{path} · Ignored by Git", { path }) : path}
        style={view === "list" ? { paddingLeft: 4 + depth * 12 } : undefined}
        onFocus={() => setFocused(path)}
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
            <span className="file-name">{entry.name}</span>
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
              {relativeTime(entry.mtime_ms)}
            </span>
          </>
        ) : (
          <>
            <FileThumbnail src={thumbnailSrc(entry)}>{icon}</FileThumbnail>
            <span className="file-name">{entry.name}</span>
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
      </div>
    );
  };

  const menuEntry = menu?.path ? entries.get(menu.path) : undefined;
  const counts = locationEntries
    ? filter
      ? `${rows.length}/${locationEntries.length}`
      : String(locationEntries.length)
    : null;

  return (
    <div
      ref={rootRef}
      className={`file-manager is-${width}`}
      onMouseUp={(event) => {
        if (event.button === 3) goBack();
        if (event.button === 4) goForward();
      }}
    >
      <div className="ui-bar file-manager-nav">
        <IconButton
          label={t("Back")}
          disabled={!history.back.length}
          onClick={goBack}
          icon={<ArrowLeft size={14} />}
        />
        <IconButton
          label={t("Forward")}
          disabled={!history.forward.length}
          onClick={goForward}
          icon={<ArrowRight size={14} />}
        />
        <IconButton
          label={t("Parent directory")}
          disabled={atRoot}
          onClick={goUp}
          icon={<ArrowUp size={14} />}
        />
        {editingPath ? (
          <form
            className="file-manager-path-form"
            onSubmit={(event) => {
              event.preventDefault();
              void navigate(pathDraft);
            }}
          >
            <TextField
              autoFocus
              fullWidth
              inputClassName="file-manager-path-input"
              aria-label={t("Directory path")}
              value={pathDraft}
              placeholder={t("/absolute/path or ~/path on the connected host")}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onValueChange={setPathDraft}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                setEditingPath(false);
              }}
              onBlur={() => setEditingPath(false)}
            />
          </form>
        ) : (
          <nav
            className="file-manager-crumbs"
            aria-label={t("Directory path")}
            onClick={(event) => {
              if (filesystem && event.target === event.currentTarget) {
                setPathDraft(location);
                setEditingPath(true);
              }
            }}
          >
            {visibleCrumbs.map((crumb, index) => (
              <span
                className={`file-manager-crumb ${index > 0 && index < visibleCrumbs.length - 1 && !crumb.collapsed ? "is-ancestor" : ""}`}
                key={`${crumb.path}:${index}`}
              >
                {index > 0 && visibleCrumbs[index - 1]?.label !== "/" ? (
                  <span className="file-manager-crumb-separator">/</span>
                ) : null}
                <Button
                  title={
                    crumb.collapsed
                      ? t("Show ancestors of {path}", { path: location })
                      : crumb.path || rootPath
                  }
                  aria-current={
                    index === visibleCrumbs.length - 1 ? "location" : undefined
                  }
                  onClick={() => void navigate(crumb.path)}
                >
                  <span>{crumb.label}</span>
                </Button>
              </span>
            ))}
            {filesystem ? (
              <Button
                className="file-manager-path-edit"
                aria-label={t("Edit path")}
                title={t("Type a path")}
                onClick={() => {
                  setPathDraft(location);
                  setEditingPath(true);
                }}
              />
            ) : null}
          </nav>
        )}
        <IconButton
          label={t("Refresh")}
          onClick={() => reloadVisible()}
          icon={
            <RefreshCw
              size={14}
              className={loading.size ? "is-spinning" : ""}
            />
          }
        />
      </div>
      {places.length ? (
        <div className="file-manager-places" aria-label={t("Locations")}>
          {places.map((place) => (
            <Token
              as="button"
              key={place.key}
              className="file-manager-place"
              tone={
                normalizeFilesystemPath(place.path) ===
                normalizeFilesystemPath(location)
                  ? "accent"
                  : "neutral"
              }
              title={place.title}
              onClick={() => void navigate(place.path)}
              icon={
                place.key === "workspace" || place.key.startsWith("cwd:") ? (
                  <Folder size={11} />
                ) : null
              }
            >
              {place.label}
            </Token>
          ))}
        </div>
      ) : null}
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
            title={t("{count} entries", {
              count: locationEntries?.length ?? 0,
            })}
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
          items={sortMenu}
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
        {readOnly ? null : (
          <>
            <IconButton
              label={t("New file")}
              onClick={() => setCreating("file")}
              icon={<FilePlus size={14} />}
            />
            <IconButton
              label={t("New folder")}
              onClick={() => setCreating("directory")}
              icon={<FolderPlus size={14} />}
            />
            <IconButton
              label={t("Upload files")}
              tooltip={t("Upload files here")}
              onClick={() => uploadRef.current?.click()}
              icon={<Upload size={14} />}
            />
          </>
        )}
        <input
          ref={uploadRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void uploadFiles(listKey(location), files);
          }}
        />
      </div>
      {error ? (
        <p className="file-manager-message is-error" role="alert">
          {error}
        </p>
      ) : null}
      {cache.rootInfo?.truncated &&
      listKey(cache.rootInfo.root) === listKey(location) ? (
        <p className="file-manager-message">
          {t("Showing the first {count} entries.", {
            count: locationEntries?.length ?? 0,
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
        className={`file-manager-body is-${view} ${dropTarget === listKey(location) ? "is-drop-target" : ""}`}
        role={view === "grid" ? "listbox" : "tree"}
        aria-label={t("Files in {path}", {
          path: crumbs[crumbs.length - 1]?.label ?? location,
        })}
        aria-busy={locationLoading}
        onClick={onBodyClick}
        onDoubleClick={onBodyDoubleClick}
        onKeyDown={onBodyKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          const path = pathFromEvent(event);
          openMenuAt(
            path && entries.has(path) ? path : null,
            event.clientX,
            event.clientY,
          );
        }}
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDropTarget(null);
        }}
        onDrop={onDrop}
        {...pressHandlers}
      >
        {locationLoading ? (
          <div className="file-manager-message" role="status">
            {t("Loading directory...")}
          </div>
        ) : rows.length ? (
          rows.map(renderRow)
        ) : locationEntries ? (
          <div className="file-manager-message">
            {filter ? t("No loaded entries match.") : t("Empty directory")}
          </div>
        ) : null}
      </div>
      <ContextMenu
        position={menu ? { x: menu.x, y: menu.y } : null}
        onClose={() => setMenu(null)}
        aria-label={menuEntry ? t("File actions") : t("Folder actions")}
        items={menuEntry ? entryMenu(menuEntry) : menu ? backgroundMenu() : []}
      />
      <TextInputDialog
        open={creating !== null}
        title={creating === "directory" ? t("New Folder") : t("New File")}
        label={t("Name inside {path}", {
          path: crumbs[crumbs.length - 1]?.label ?? location,
        })}
        placeholder={creating === "directory" ? "folder-name" : "file.txt"}
        submitLabel={t("Create")}
        onClose={() => setCreating(null)}
        onSubmit={(value) => {
          const kind = creating;
          setCreating(null);
          if (kind) void createEntry(kind, value);
        }}
      />
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title={
          pendingDelete?.type === "symlink"
            ? t("Delete Symlink")
            : pendingDelete && isDirectoryEntry(pendingDelete)
              ? t("Delete Directory")
              : t("Delete File")
        }
        message={
          !pendingDelete
            ? t("Delete this item?")
            : pendingDelete.type === "symlink"
              ? t('Delete symlink "{path}"? This cannot be undone.', {
                  path: pendingDelete.path,
                })
              : isDirectoryEntry(pendingDelete)
                ? t('Delete directory "{path}"? This cannot be undone.', {
                    path: pendingDelete.path,
                  })
                : t('Delete file "{path}"? This cannot be undone.', {
                    path: pendingDelete.path,
                  })
        }
        confirmLabel={t("Delete")}
        tone="danger"
        onConfirm={() => {
          if (pendingDelete) void deleteEntry(pendingDelete);
        }}
      />
    </div>
  );
}
