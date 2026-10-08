import { useSyncExternalStore } from "react";

/**
 * Material Icon Theme lookup (the theme's own name -> icon rules) over the
 * lazily loaded table from `virtual:file-icons` (see web/vite.fileIcons.ts).
 */

export type FileIconTable = {
  extensions: Record<string, string>;
  names: Record<string, string>;
  folders: Record<string, string>;
  light: string;
};

export type FileIconLookup = {
  base: string;
  extensions: Map<string, string>;
  names: Map<string, string>;
  folders: Map<string, string>;
  light: Set<string>;
};

/** Expand `stem.{a,b}` back into `stem.a stem.b`. */
function expand(key: string) {
  const match = key.match(/^(.*)\.\{(.*)\}$/);
  return match
    ? match[2]!.split(",").map((extension) => `${match[1]}.${extension}`)
    : [key];
}

function invert(groups: Record<string, string>, prefix = "") {
  const map = new Map<string, string>();
  for (const [icon, keys] of Object.entries(groups)) {
    for (const key of keys.split(" ")) {
      for (const name of expand(key)) map.set(name, `${prefix}${icon}`);
    }
  }
  return map;
}

export function buildIconLookup(
  base: string,
  table: FileIconTable,
): FileIconLookup {
  return {
    base,
    extensions: invert(table.extensions),
    names: invert(table.names),
    folders: invert(table.folders, "folder-"),
    light: new Set(table.light.split(" ")),
  };
}

export type IconTarget = {
  name: string;
  directory: boolean;
  /** Folder is expanded (the open variant). */
  open?: boolean;
  /** The explorer's root folder. */
  root?: boolean;
  /** Parent folder name, for theme rules such as `.github/workflows`. */
  parent?: string;
};

/** The icon id the theme assigns to a file or folder. */
export function iconName(lookup: FileIconLookup, target: IconTarget) {
  const name = target.name.toLowerCase();
  if (target.directory) {
    if (target.root) return target.open ? "folder-root-open" : "folder-root";
    const base = name.replace(/^__(.+)__$/, "$1").replace(/^[._-](?=.)/, "");
    const icon = lookup.folders.get(base) ?? "folder";
    return target.open ? `${icon}-open` : icon;
  }
  const scoped = target.parent
    ? lookup.names.get(`${target.parent.toLowerCase()}/${name}`)
    : undefined;
  const exact = scoped ?? lookup.names.get(name);
  if (exact) return exact;
  // Longest extension first: `a.test.ts` tries `test.ts`, then `ts`.
  for (
    let dot = name.indexOf(".");
    dot >= 0;
    dot = name.indexOf(".", dot + 1)
  ) {
    const icon = lookup.extensions.get(name.slice(dot + 1));
    if (icon) return icon;
  }
  return "file";
}

export function iconUrl(lookup: FileIconLookup, icon: string, light: boolean) {
  const variant = light && lookup.light.has(icon) ? `${icon}_light` : icon;
  return `${lookup.base}${variant}.svg`;
}

let lookup: FileIconLookup | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function loadFileIcons() {
  loading ??= import("virtual:file-icons")
    .then((module) => {
      lookup = buildIconLookup(module.base, module.table);
      for (const listener of listeners) listener();
    })
    .catch(() => {
      // Offline or a missing chunk: rows keep their generic icons.
      loading = null;
    });
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void loadFileIcons();
  return () => {
    listeners.delete(listener);
  };
}

/** The icon table once loaded (null until then; loading starts on use). */
export function useFileIconLookup() {
  return useSyncExternalStore(
    subscribe,
    () => lookup,
    () => null,
  );
}
