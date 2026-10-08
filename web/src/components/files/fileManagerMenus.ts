import { t } from "../../i18n";
import type { FileExplorerEntry } from "../../types";
import type { MenuEntry, MenuItem } from "../ui/Menu";
import {
  type SortKey,
  type SortState,
  isDirectoryEntry,
} from "./fileManagerModel";

const SORT_KEYS: SortKey[] = ["name", "type", "size", "modified"];

export const modifierKey =
  typeof navigator !== "undefined" &&
  /Mac|iP(?:hone|ad|od)/.test(navigator.platform)
    ? "Cmd"
    : "Ctrl";

/** What a menu can do; omitted actions are not offered. */
export type FileMenuActions = {
  open: (entry: FileExplorerEntry, intoFolder: boolean) => void;
  download: (entry: FileExplorerEntry) => void;
  copyPaths: (paths: string[], relative: boolean) => void;
  refresh: () => void;
  // Mutations (absent for viewers).
  rename?: (entry: FileExplorerEntry) => void;
  duplicate?: (entries: FileExplorerEntry[]) => void;
  cut?: (entries: FileExplorerEntry[]) => void;
  copy?: (entries: FileExplorerEntry[]) => void;
  /** Paste into a folder; absent when the clipboard cannot paste here. */
  paste?: (folder: string) => void;
  create?: (kind: "file" | "directory", folder: string) => void;
  upload?: (folder: string) => void;
  remove?: (entries: FileExplorerEntry[]) => void;
};

/** Menu for the selected entries (right-click, long-press, Menu key). */
export function selectionMenu(
  entries: FileExplorerEntry[],
  folder: string,
  actions: FileMenuActions,
): MenuEntry[] {
  const single = entries.length === 1 ? entries[0]! : null;
  const directory = single ? isDirectoryEntry(single) : false;
  const paths = entries.map((entry) => entry.path);
  const item = (value: MenuItem | false | undefined | null) =>
    value ? [value] : [];
  return [
    {
      items: single
        ? [
            {
              id: "open",
              label: directory ? t("Open folder") : t("Open"),
              onAction: () => actions.open(single, true),
            },
            {
              id: "download",
              label: directory ? t("Download directory") : t("Download file"),
              onAction: () => actions.download(single),
            },
          ]
        : [],
    },
    {
      items: [
        ...item(
          actions.cut && {
            id: "cut",
            label: t("Cut"),
            shortcut: `${modifierKey}+X`,
            onAction: () => actions.cut?.(entries),
          },
        ),
        ...item(
          actions.copy && {
            id: "copy",
            label: t("Copy"),
            shortcut: `${modifierKey}+C`,
            onAction: () => actions.copy?.(entries),
          },
        ),
        ...item(
          actions.paste && {
            id: "paste",
            label: t("Paste"),
            shortcut: `${modifierKey}+V`,
            onAction: () => actions.paste?.(folder),
          },
        ),
        ...item(
          actions.duplicate && {
            id: "duplicate",
            label: t("Duplicate"),
            onAction: () => actions.duplicate?.(entries),
          },
        ),
      ],
    },
    {
      items: [
        {
          id: "copy-path",
          label: entries.length > 1 ? t("Copy paths") : t("Copy path"),
          shortcut: "Shift+Alt+C",
          onAction: () => actions.copyPaths(paths, false),
        },
        {
          id: "copy-relative-path",
          label:
            entries.length > 1
              ? t("Copy relative paths")
              : t("Copy relative path"),
          onAction: () => actions.copyPaths(paths, true),
        },
      ],
    },
    {
      items: [
        ...item(
          single &&
            actions.rename && {
              id: "rename",
              label: t("Rename"),
              shortcut: "F2",
              onAction: () => actions.rename?.(single),
            },
        ),
        ...item(
          actions.remove && {
            id: "delete",
            label:
              entries.length > 1
                ? t("Delete {count} items", { count: entries.length })
                : single?.type === "symlink"
                  ? t("Delete symlink")
                  : directory
                    ? t("Delete directory")
                    : t("Delete file"),
            danger: true,
            shortcut: "Delete",
            onAction: () => actions.remove?.(entries),
          },
        ),
      ],
    },
  ];
}

/** Menu for a folder's empty space (or the toolbar's More menu). */
export function folderMenu(
  folder: string,
  actions: FileMenuActions,
  extra: MenuEntry[] = [],
): MenuEntry[] {
  const item = (value: MenuItem | false | undefined) => (value ? [value] : []);
  return [
    {
      items: [
        ...item(
          actions.create && {
            id: "new-file",
            label: t("New file"),
            onAction: () => actions.create?.("file", folder),
          },
        ),
        ...item(
          actions.create && {
            id: "new-folder",
            label: t("New folder"),
            onAction: () => actions.create?.("directory", folder),
          },
        ),
        ...item(
          actions.upload && {
            id: "upload",
            label: t("Upload files"),
            onAction: () => actions.upload?.(folder),
          },
        ),
        ...item(
          actions.paste && {
            id: "paste",
            label: t("Paste"),
            shortcut: `${modifierKey}+V`,
            onAction: () => actions.paste?.(folder),
          },
        ),
      ],
    },
    {
      items: [
        {
          id: "copy-folder-path",
          label: t("Copy path"),
          onAction: () => actions.copyPaths([folder], false),
        },
        {
          id: "refresh",
          label: t("Refresh"),
          onAction: actions.refresh,
        },
      ],
    },
    ...extra,
  ];
}

export function sortMenu(
  sort: SortState,
  onChange: (sort: SortState) => void,
): MenuEntry[] {
  const label = (key: SortKey) =>
    key === "name"
      ? t("Name")
      : key === "type"
        ? t("Type")
        : key === "size"
          ? t("Size")
          : t("Modified");
  return [
    {
      title: t("Sort by"),
      selectionMode: "single",
      items: SORT_KEYS.map((key) => ({
        id: `sort-${key}`,
        label: label(key),
        checked: sort.key === key,
        onAction: () => onChange({ key, descending: sort.descending }),
      })),
    },
    {
      selectionMode: "single",
      items: [
        {
          id: "sort-ascending",
          label: t("Ascending"),
          checked: !sort.descending,
          onAction: () => onChange({ ...sort, descending: false }),
        },
        {
          id: "sort-descending",
          label: t("Descending"),
          checked: sort.descending,
          onAction: () => onChange({ ...sort, descending: true }),
        },
      ],
    },
  ];
}

export function readSort(value: string | null): SortState {
  const [key, order] = (value ?? "").split(":");
  return {
    key: SORT_KEYS.includes(key as SortKey) ? (key as SortKey) : "name",
    descending: order === "desc",
  };
}

export function writeSort(sort: SortState) {
  return `${sort.key}:${sort.descending ? "desc" : "asc"}`;
}
