import { useEffect, useRef, useState } from "react";
import type { ConnectionClient } from "../../api";
import {
  fileExplorerRefreshKey,
  useFileExplorerRefresh,
} from "../../fileExplorerRefresh";
import { normalizeFilesystemPath } from "../../filesystemPaths";
import { t } from "../../i18n";
import type { FileExplorerList } from "../../types";
import {
  type FileExplorerCache,
  readExplorerCache,
  readExplorerViewMemory,
  writeExplorerCache,
  writeExplorerViewMemory,
} from "../fileExplorerResources";
import { type FileScope, isWithin, parentPath } from "./fileManagerModel";

/**
 * Directory listings, the current folder and its back/forward history for
 * one file manager. Listings live in the explorer cache (kept across
 * Inspector reopenings); filesystem listings are keyed by their real path,
 * workspace listings by their checkout-relative path. A new connection,
 * workspace, scope or hidden-file setting starts over.
 */
export function useFileListing({
  client,
  workspaceId,
  scope,
  resourceKey,
  rootPath,
  memoryContext,
  initialLocation,
  showHidden,
  onRootResolved,
  onReset,
}: {
  client: ConnectionClient;
  workspaceId: string;
  scope: FileScope;
  resourceKey: string;
  rootPath: string;
  memoryContext: string;
  initialLocation?: string;
  showHidden: boolean;
  onRootResolved?: (root: string) => void;
  /** The context changed or the folder changed: drop transient UI. */
  onReset: () => void;
}) {
  const filesystem = scope === "filesystem";
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
  const contextRef = useRef(0);
  const listKey = (path: string) =>
    filesystem ? normalizeFilesystemPath(path) : path;
  const here = listKey(location);

  const update = (
    patch: (current: FileExplorerCache) => Partial<FileExplorerCache>,
  ) =>
    setCache((current) => {
      const next = { ...current, ...patch(current) };
      writeExplorerCache(client, workspaceId, showHidden, next, cacheKey);
      return next;
    });

  /** A token for async work; `isCurrent` fails once the context changed. */
  const token = () => contextRef.current;
  const isCurrent = (value: number) =>
    client.isCurrent() && contextRef.current === value;

  /** List one folder; resolves to its listing key, or null on failure. */
  const load = async (path: string, force = false): Promise<string | null> => {
    const key = listKey(path);
    if (!force && cache.children[key]) return key;
    const started = contextRef.current;
    setLoading((current) => new Set(current).add(key));
    try {
      const list = (await client.call("file.list", {
        workspace_id: workspaceId,
        path,
        show_hidden: showHidden,
        ...(filesystem ? { scope: "filesystem" } : {}),
      })) as FileExplorerList & { scope?: string };
      if (!isCurrent(started)) return null;
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
      if (isCurrent(started)) {
        update(() => ({ error: (reason as Error).message }));
      }
      return null;
    } finally {
      if (isCurrent(started)) {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  };

  /** Re-list the current folder, its expanded subfolders and `extra`. */
  const reloadVisible = (extra: string[] = []) => {
    const paths = new Set([here, ...extra.map(listKey)]);
    for (const path of cache.expanded) {
      if (isWithin(path, here)) paths.add(path);
    }
    for (const path of paths) void load(path, true);
  };

  /** Re-list the folders an operation touched that are on screen. */
  const reloadFolders = (folders: string[]) => {
    for (const folder of new Set(folders.map(listKey))) {
      if (isWithin(folder, here)) void load(folder, true);
    }
  };

  const toggleFolder = (path: string, open?: boolean) => {
    const next = new Set(cache.expanded);
    if (open ?? !next.has(path)) {
      next.add(path);
      void load(path);
    } else next.delete(path);
    update(() => ({ expanded: next }));
  };

  /** Expand a folder unless it is the current one or already open. */
  const expand = (path: string) => {
    if (path !== here && !cache.expanded.has(path)) toggleFolder(path, true);
  };

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
    onReset();
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

  const context = `${client.connectionId}\n${client.generation}\n${workspaceId}\n${cacheKey}\n${showHidden}`;
  useEffect(() => {
    contextRef.current += 1;
    const fresh = readCache();
    setCache(fresh);
    setLoading(new Set());
    onReset();
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

  const parent = parentPath(location, scope);
  const atRoot = filesystem
    ? normalizeFilesystemPath(parent) === here
    : location === "";

  return {
    cache,
    update,
    location,
    here,
    listKey,
    loading,
    token,
    isCurrent,
    load,
    reloadVisible,
    reloadFolders,
    toggleFolder,
    expand,
    navigate,
    atRoot,
    canBack: history.back.length > 0,
    canForward: history.forward.length > 0,
    goBack() {
      const previous = history.back[history.back.length - 1];
      if (previous === undefined) return;
      setHistory((current) => ({
        back: current.back.slice(0, -1),
        forward: [location, ...current.forward],
      }));
      void navigate(previous, "back");
    },
    goForward() {
      const next = history.forward[0];
      if (next === undefined) return;
      setHistory((current) => ({
        back: [...current.back, location],
        forward: current.forward.slice(1),
      }));
      void navigate(next, "forward");
    },
    goUp() {
      if (!atRoot) void navigate(parent);
    },
  };
}
