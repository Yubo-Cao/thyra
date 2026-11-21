import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionClient } from "../api";
import type { FileExplorerList, FilePreview } from "../types";
import type { InspectorFileRequest } from "../workspaceResource";
import {
  entryIsFolder,
  previewKind,
  previewParent,
} from "./inspectorPreviewModel";
import { listWorkspacePreview, readWorkspaceFile } from "./workspaceFiles";

export type PreviewTarget = InspectorFileRequest & {
  directory?: boolean;
  fragment?: string;
};

const POLL_MS = 750;

function cacheListings(
  cache: Map<string, FileExplorerList>,
  entries: Map<string, FileExplorerList>,
) {
  const next = new Map(cache);
  for (const [path, listing] of entries) {
    next.delete(path);
    next.set(path, listing);
  }
  while (next.size > 32) next.delete(next.keys().next().value!);
  return next;
}

export function useInspectorPreview(
  client: ConnectionClient,
  workspaceId: string,
  target: PreviewTarget,
  active: boolean,
  htmlPaths: string[],
  markdownImages: string[],
) {
  const [loaded, setLoaded] = useState<{
    target: PreviewTarget;
    file?: FilePreview;
    error?: string;
  }>();
  const [directories, setDirectories] = useState(
    new Map<string, FileExplorerList>(),
  );
  const [listingError, setListingError] = useState<{
    path: string;
    message: string;
  }>();
  const [htmlVersion, setHtmlVersion] = useState(0);
  const current = loaded?.target === target ? loaded : undefined;
  const file = current?.file;
  const kind = previewKind(target.path);
  const parent = previewParent(target.path);
  const match = directories
    .get(parent)
    ?.entries.find((entry) => entry.path === target.path);
  const folder =
    target.directory ||
    file?.type === "directory" ||
    (!!match && entryIsFolder(match));
  const directory = folder ? target.path : parent;
  const read = !target.directory && (kind === "text" || kind === "markdown");
  const listing = directories.get(directory);
  const versions = useMemo(
    () =>
      new Map(
        [...directories.values()].flatMap(({ entries }) =>
          entries.map(({ path, mtime_ms }) => [path, mtime_ms] as const),
        ),
      ),
    [directories],
  );
  const watch = useRef<{
    target: PreviewTarget;
    signatures: Map<string, string>;
  }>(undefined);
  const loadedRef = useRef(current);
  loadedRef.current = current;

  useEffect(() => {
    if (!active || !read) return;
    let alive = true;
    void readWorkspaceFile(client, workspaceId, target.path, true).then(
      (result) => {
        if (!alive) return;
        setLoaded({ target, file: result });
        if (result.listing)
          setDirectories((cache) =>
            cacheListings(cache, new Map([[target.path, result.listing!]])),
          );
      },
      (error: Error) => {
        if (alive) setLoaded({ target, error: error.message });
      },
    );
    return () => {
      alive = false;
    };
  }, [active, client, workspaceId, target, read]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const watched = new Set([
      directory,
      ...[...htmlPaths, ...markdownImages].map(previewParent),
    ]);
    if (watch.current?.target !== target)
      watch.current = { target, signatures: new Map() };
    const previous = watch.current.signatures;
    const refresh = async () => {
      const results = await Promise.allSettled(
        [...watched].map((path) =>
          listWorkspacePreview(client, workspaceId, path),
        ),
      );
      if (!alive) return;
      const next = new Map<string, FileExplorerList>();
      let htmlChanged = false;
      let markdownChanged = false;
      const htmlDirectory =
        htmlPaths[0] === undefined ? null : previewParent(htmlPaths[0]);
      [...watched].forEach((path, index) => {
        const result = results[index];
        if (result.status === "rejected") {
          if (path === directory)
            setListingError({ path, message: String(result.reason) });
          return;
        }
        const listing = result.value;
        if (path === directory) setListingError(undefined);
        next.set(path, listing);
        const signature = JSON.stringify(
          listing.entries.map(({ name, size, mtime_ms, type }) => [
            type,
            name,
            size,
            mtime_ms,
          ]),
        );
        const old = previous.get(path);
        if (htmlDirectory !== null && old !== undefined && old !== signature)
          htmlChanged = true;
        previous.set(path, signature);
        if (old === signature) next.delete(path);
        if (kind === "markdown" && path === directory) {
          const entry = listing.entries.find(
            ({ path }) => path === target.path,
          );
          markdownChanged =
            loadedRef.current?.file?.mtime_ms !== entry?.mtime_ms;
        }
      });
      if (next.size) setDirectories((cache) => cacheListings(cache, next));
      if (htmlChanged) setHtmlVersion((value) => value + 1);
      if (markdownChanged && loadedRef.current) {
        try {
          const result = await readWorkspaceFile(
            client,
            workspaceId,
            target.path,
            true,
          );
          if (alive) setLoaded({ target, file: result });
        } catch (error) {
          if (alive) setLoaded({ target, error: String(error) });
        }
      }
      if (alive) timer = setTimeout(refresh, POLL_MS);
    };
    // The directory read already included the first listing for an unknown folder.
    if (file?.type === "directory" && !target.directory)
      timer = setTimeout(refresh, POLL_MS);
    else void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [
    active,
    client,
    workspaceId,
    directory,
    htmlPaths,
    markdownImages,
    target,
    kind,
    file?.type,
  ]);

  return {
    file,
    kind,
    folder,
    directory,
    listing,
    listingError:
      listingError?.path === directory ? listingError.message : undefined,
    error: current?.error,
    versions,
    htmlVersion,
  };
}
