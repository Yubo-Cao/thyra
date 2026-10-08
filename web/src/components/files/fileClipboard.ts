import { useSyncExternalStore } from "react";
import { hostPathOf, isAbsolutePath, relativePathOf } from "./fileManagerModel";

/**
 * The file manager's cut/copy clipboard, shared by every explorer on the page
 * (paste into another folder, or another explorer of the same connection).
 * The OS clipboard cannot carry host files, so this never leaves the page.
 */
export type FileClipboard = {
  mode: "copy" | "cut";
  connectionId: string;
  workspaceId: string;
  filesystem: boolean;
  /** Absolute checkout root of the workspace the paths came from. */
  root: string;
  paths: string[];
};

let current: FileClipboard | null = null;
const listeners = new Set<() => void>();

export function setFileClipboard(next: FileClipboard | null) {
  current = next;
  for (const listener of listeners) listener();
}

export function useFileClipboard() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}

/**
 * Clipboard paths in the target explorer's form, or null when the server
 * could not resolve them there: workspace paths only paste into the same
 * checkout; filesystem explorers take absolute paths from anywhere.
 */
export function clipboardPathsFor(
  clipboard: FileClipboard,
  target: {
    connectionId: string;
    workspaceId: string;
    filesystem: boolean;
    root: string;
  },
) {
  if (clipboard.connectionId !== target.connectionId) return null;
  const absolute = clipboard.paths.map((path) =>
    clipboard.filesystem ? path : hostPathOf(clipboard.root, path),
  );
  if (target.filesystem) return absolute;
  const relative = absolute.map((path) => relativePathOf(target.root, path));
  return relative.some(isAbsolutePath) ? null : relative;
}
