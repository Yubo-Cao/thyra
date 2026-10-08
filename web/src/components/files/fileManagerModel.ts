import { createFileSearchMatcher } from "../../fileSearch";
import { parentFilesystemPath } from "../../filesystemPaths";
import type { FileExplorerEntry } from "../../types";

/**
 * Pure state helpers for the file manager: path arithmetic for both scopes,
 * sorting, the flattened tree the list view renders, selection ranges and
 * keyboard movement. Workspace scope uses checkout-relative paths (`""` is
 * the root); filesystem scope uses absolute host paths.
 */

export type FileScope = "workspace" | "filesystem";
export type FileView = "list" | "grid";
export type SortKey = "name" | "type" | "size" | "modified";
export type SortState = { key: SortKey; descending: boolean };
export type FileRow = { entry: FileExplorerEntry; depth: number };

export function isDirectoryEntry(entry: FileExplorerEntry) {
  return (
    entry.type === "directory" ||
    (entry.type === "symlink" &&
      entry.symlink_status !== "broken" &&
      entry.symlink_target_type === "directory")
  );
}

export function joinPath(directory: string, name: string) {
  if (!directory) return name;
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

export function parentPath(path: string, scope: FileScope) {
  if (scope === "filesystem") return parentFilesystemPath(path);
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function baseName(path: string) {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** Whether `path` is `ancestor` or inside it. */
export function isWithin(path: string, ancestor: string) {
  if (path === ancestor) return true;
  if (ancestor === "") return !isAbsolutePath(path);
  return path.startsWith(ancestor.endsWith("/") ? ancestor : `${ancestor}/`);
}

/** Directories from `root` (exclusive) down to the parent of `path`. */
export function ancestorsBetween(root: string, path: string, scope: FileScope) {
  const result: string[] = [];
  let current = parentPath(path, scope);
  while (current !== root && isWithin(current, root)) {
    result.unshift(current);
    const next = parentPath(current, scope);
    if (next === current) break;
    current = next;
  }
  return result;
}

const ABSOLUTE = /^(?:\/|[a-z]:\/)/i;

export function isAbsolutePath(path: string) {
  return ABSOLUTE.test(path);
}

/** Absolute host path of an entry; workspace paths join the checkout root. */
export function hostPathOf(root: string, path: string) {
  if (isAbsolutePath(path)) return path;
  const base = root.replace(/\/+$/, "");
  return path ? `${base}/${path}` : root;
}

/** Path relative to the checkout root, or the path itself outside it. */
export function relativePathOf(root: string, path: string) {
  if (!isAbsolutePath(path)) return path;
  const base = root.replace(/\/+$/, "");
  return path === base
    ? ""
    : path.startsWith(`${base}/`)
      ? path.slice(base.length + 1)
      : path;
}

export function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Folders first, then the chosen key; names break ties. */
export function sortEntries(
  entries: readonly FileExplorerEntry[],
  sort: SortState,
) {
  const direction = sort.descending ? -1 : 1;
  return [...entries].sort((a, b) => {
    const folderOrder =
      Number(isDirectoryEntry(b)) - Number(isDirectoryEntry(a));
    if (folderOrder) return folderOrder;
    let order = 0;
    if (sort.key === "size") order = a.size - b.size;
    else if (sort.key === "modified") order = a.mtime_ms - b.mtime_ms;
    else if (sort.key === "type") {
      order = collator.compare(extensionOf(a.name), extensionOf(b.name));
    }
    return (order || collator.compare(a.name, b.name)) * direction;
  });
}

/**
 * Rows of the list view: the tree under `root`, expanded folders inline.
 * With a filter, loaded entries under `root` that match, flat.
 */
export function visibleRows({
  root,
  children,
  expanded,
  sort,
  filter,
  view,
}: {
  root: string;
  children: Readonly<Record<string, FileExplorerEntry[] | undefined>>;
  expanded: ReadonlySet<string>;
  sort: SortState;
  filter: string;
  view: FileView;
}): FileRow[] {
  const query = filter.trim();
  if (query) {
    const matches = createFileSearchMatcher(query);
    const seen = new Set<string>();
    const found: FileExplorerEntry[] = [];
    for (const [directory, entries] of Object.entries(children)) {
      if (!entries || !isWithin(directory, root)) continue;
      if (view === "grid" && directory !== root) continue;
      for (const entry of entries) {
        if (seen.has(entry.path) || !matches(entry)) continue;
        seen.add(entry.path);
        found.push(entry);
      }
    }
    return sortEntries(found, sort).map((entry) => ({ entry, depth: 0 }));
  }
  const rows: FileRow[] = [];
  const visit = (directory: string, depth: number) => {
    for (const entry of sortEntries(children[directory] ?? [], sort)) {
      rows.push({ entry, depth });
      if (
        view === "list" &&
        isDirectoryEntry(entry) &&
        expanded.has(entry.path)
      ) {
        visit(entry.path, depth + 1);
      }
    }
  };
  visit(root, 0);
  return rows;
}

/** Paths from the anchor to the target, inclusive, in row order. */
export function rangeBetween(
  rows: readonly FileRow[],
  anchor: string | null,
  target: string,
) {
  const end = rows.findIndex((row) => row.entry.path === target);
  const start = anchor
    ? rows.findIndex((row) => row.entry.path === anchor)
    : -1;
  if (end < 0) return [];
  if (start < 0) return [target];
  const [low, high] = start < end ? [start, end] : [end, start];
  return rows.slice(low, high + 1).map((row) => row.entry.path);
}

export type MoveKey =
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";

/**
 * Row index after a movement key. Grids move by `columns` vertically and by
 * one horizontally; lists ignore left and right (those expand and collapse).
 */
export function moveIndex(
  index: number,
  key: MoveKey,
  count: number,
  { columns = 1, page = 10 }: { columns?: number; page?: number } = {},
) {
  if (!count) return -1;
  const clamp = (value: number) => Math.max(0, Math.min(count - 1, value));
  if (index < 0) return key === "End" ? count - 1 : 0;
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "ArrowUp":
      return clamp(index - columns);
    case "ArrowDown":
      return clamp(index + columns);
    case "ArrowLeft":
      return columns > 1 ? clamp(index - 1) : index;
    case "ArrowRight":
      return columns > 1 ? clamp(index + 1) : index;
    case "PageUp":
      return clamp(index - page * columns);
    case "PageDown":
      return clamp(index + page * columns);
  }
}

/** Next row whose name starts with the typed prefix, after `from`. */
export function typeaheadMatch(
  rows: readonly FileRow[],
  prefix: string,
  from: number,
) {
  const query = prefix.toLowerCase();
  if (!query) return -1;
  for (let offset = 1; offset <= rows.length; offset += 1) {
    const index = (from + offset) % rows.length;
    if (rows[index]?.entry.name.toLowerCase().startsWith(query)) return index;
  }
  return -1;
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
