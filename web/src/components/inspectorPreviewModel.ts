import { imageMimeForPath, isHtmlPath } from "../../../shared/filePreview";
import type { FileExplorerEntry } from "../types";

export function previewKind(path: string) {
  if (imageMimeForPath(path)) return "image";
  if (isHtmlPath(path)) return "html";
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.(md|markdown|mdown|mkd)$/i.test(path)) return "markdown";
  if (/\.(mp4|webm)$/i.test(path)) return "video";
  if (/\.(mp3|wav|ogg)$/i.test(path)) return "audio";
  return "text";
}

export function previewParent(path: string): string {
  if (path === "/" || /^[a-z]:\/$/i.test(path)) return path;
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash === 0 || /^[a-z]:$/i.test(trimmed.slice(0, slash)))
    return trimmed.slice(0, slash + 1);
  return slash >= 0 ? trimmed.slice(0, slash) : "";
}

export function previewName(path: string) {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

export function entryIsFolder(entry: FileExplorerEntry) {
  return (
    entry.type === "directory" || entry.symlink_target_type === "directory"
  );
}

export function previewNeighbor(
  entries: FileExplorerEntry[],
  path: string,
  direction: number,
  imagesOnly: boolean,
) {
  const candidates = entries.filter(
    (entry) =>
      !imagesOnly ||
      (!entryIsFolder(entry) && previewKind(entry.path) === "image"),
  );
  const index = candidates.findIndex((entry) => entry.path === path);
  return candidates[
    index < 0 ? (direction > 0 ? 0 : candidates.length - 1) : index + direction
  ];
}
