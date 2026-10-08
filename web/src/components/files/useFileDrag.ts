import { useRef, useState } from "react";
import { t } from "../../i18n";
import type { FileExplorerEntry } from "../../types";
import type { FileClipboard } from "./fileClipboard";
import { useTouchPress } from "./fileDrop";
import { modifierKey } from "./fileManagerMenus";
import { baseName, isDirectoryEntry, isWithin } from "./fileManagerModel";

/** The rows being dragged, readable during dragover (dataTransfer is not). */
let activeDrag: FileClipboard | null = null;
const DRAG_TYPE = "application/x-thyra-files";
const HOVER_OPEN_MS = 700;
const EDGE_PX = 32;

/** Ctrl copies on Linux and Windows, Option on macOS. */
const copyModifier = (event: { ctrlKey: boolean; altKey: boolean }) =>
  modifierKey === "Cmd" ? event.altKey : event.ctrlKey;

/** Whether paths may drop into a folder (never into themselves). */
export const canDropInto = (folder: string, paths: string[]) =>
  !paths.some((path) => isWithin(folder, path));

const pathOf = (target: EventTarget | null) =>
  (target as Element | null)?.closest<HTMLElement>("[data-file-path]")?.dataset
    .filePath ?? null;

/**
 * Dragging in the file manager: rows (HTML5 drag with a mouse, long-press
 * then move on touch), desktop files dropped in, hover-to-open folders, and
 * the drop-target highlight.
 */
export function useFileDrag(options: {
  readOnly: boolean;
  body: React.RefObject<HTMLDivElement | null>;
  here: string;
  entry: (path: string) => FileExplorerEntry | undefined;
  /** Folders that are already open need no hover-open. */
  isOpen: (path: string) => boolean;
  openFolder: (path: string) => void;
  /** The folder a drop on this element lands in. */
  dropFolder: (target: EventTarget | null) => string;
  /** Rows a drag from `path` carries (the selection when it includes it). */
  dragPaths: (path: string) => string[];
  source: (paths: string[]) => FileClipboard;
  downloadUrl: (entry: FileExplorerEntry) => string;
  /** Absolute host path, for the plain-text drag data. */
  hostPath: (path: string) => string;
  onDropRows: (source: FileClipboard, folder: string, copy: boolean) => void;
  onDropFiles: (folder: string, transfer: DataTransfer) => void;
  onLongPress: (path: string | null, x: number, y: number) => void;
  isEditing: boolean;
}) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{
    x: number;
    y: number;
    label: string;
  } | null>(null);
  const pointerType = useRef("mouse");
  const depth = useRef(0);
  const hover = useRef<{
    path: string;
    since: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const live = useRef(options);
  live.current = options;

  // Hovering a folder opens it after a moment. Elapsed time is also checked
  // on every dragover: timers scheduled from drag events can be lost.
  const openHovered = () => {
    const current = hover.current;
    if (!current) return;
    clearTimeout(current.timer);
    hover.current = { ...current, since: Number.POSITIVE_INFINITY };
    live.current.openFolder(current.path);
  };
  const hoverTarget = (path: string | null) => {
    const current = hover.current;
    if (current && current.path === path) {
      if (performance.now() - current.since >= HOVER_OPEN_MS) openHovered();
      return;
    }
    if (current) clearTimeout(current.timer);
    hover.current = null;
    const entry = path ? live.current.entry(path) : undefined;
    if (
      !path ||
      !entry ||
      !isDirectoryEntry(entry) ||
      live.current.isOpen(path)
    )
      return;
    hover.current = {
      path,
      since: performance.now(),
      timer: setTimeout(openHovered, HOVER_OPEN_MS),
    };
  };
  const clear = () => {
    depth.current = 0;
    activeDrag = null;
    setDropTarget(null);
    hoverTarget(null);
  };

  const touch = useTouchPress({
    onLongPress: (path, x, y) => live.current.onLongPress(path, x, y),
    onDragMove({ x, y, path }) {
      const { readOnly, body, dragPaths, dropFolder, here } = live.current;
      if (readOnly) return;
      const paths = dragPaths(path);
      setGhost({
        x,
        y,
        label:
          paths.length === 1
            ? baseName(paths[0]!)
            : t("{count} items", { count: paths.length }),
      });
      // Scroll when the finger nears the list's top or bottom edge.
      const box = body.current?.getBoundingClientRect();
      if (box && (y < box.top + EDGE_PX || y > box.bottom - EDGE_PX)) {
        body.current?.scrollBy({ top: y < box.top + EDGE_PX ? -24 : 24 });
      }
      const under = document.elementFromPoint(x, y);
      const folder = body.current?.contains(under)
        ? pathOf(under) !== null
          ? dropFolder(under)
          : here
        : null;
      setDropTarget(
        folder !== null && canDropInto(folder, paths) ? folder : null,
      );
      hoverTarget(pathOf(under));
    },
    onDrop(drag) {
      setGhost(null);
      const folder = dropTarget;
      clear();
      const { readOnly, dragPaths, source, onDropRows } = live.current;
      if (!drag || folder === null || readOnly) return;
      onDropRows(source(dragPaths(drag.path)), folder, false);
    },
  });

  const isRowDrag = (event: React.DragEvent) =>
    !live.current.readOnly &&
    Array.from(event.dataTransfer.types).includes(DRAG_TYPE);
  const isFileDrag = (event: React.DragEvent) =>
    !live.current.readOnly &&
    Array.from(event.dataTransfer.types).includes("Files");

  const handlers = {
    onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
      pointerType.current = event.pointerType;
      touch.onPointerDown(event, pathOf(event.target));
    },
    onPointerMove: touch.onPointerMove,
    onPointerUp: touch.onPointerUp,
    onPointerCancel: touch.onPointerCancel,
    onDragStart(event: React.DragEvent<HTMLDivElement>) {
      const {
        entry: entryOf,
        dragPaths,
        source,
        downloadUrl,
        isEditing,
      } = live.current;
      const path = pathOf(event.target);
      const entry = path ? entryOf(path) : undefined;
      // Touch drags use the long-press gesture instead of native drag.
      if (!entry || pointerType.current !== "mouse" || isEditing) {
        event.preventDefault();
        return;
      }
      const paths = dragPaths(entry.path);
      activeDrag = source(paths);
      const transfer = event.dataTransfer;
      transfer.effectAllowed = live.current.readOnly ? "copy" : "copyMove";
      transfer.setData(DRAG_TYPE, JSON.stringify(activeDrag));
      transfer.setData(
        "text/plain",
        paths.map(live.current.hostPath).join("\n"),
      );
      if (paths.length === 1) {
        // Chromium saves a file dragged to the desktop from DownloadURL.
        const name = isDirectoryEntry(entry)
          ? `${entry.name}.tar.gz`
          : entry.name;
        transfer.setData(
          "DownloadURL",
          `application/octet-stream:${name}:${downloadUrl(entry)}`,
        );
      } else {
        const badge = document.createElement("div");
        badge.className = "file-manager-drag-badge";
        badge.textContent = t("{count} items", { count: paths.length });
        document.body.append(badge);
        transfer.setDragImage(badge, -8, -8);
        setTimeout(() => badge.remove(), 0);
      }
    },
    onDragEnter() {
      depth.current += 1;
    },
    onDragLeave() {
      // Enter and leave nest per row (relatedTarget is often null); zero
      // means the drag left the body.
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) {
        setDropTarget(null);
        hoverTarget(null);
      }
    },
    onDragOver(event: React.DragEvent<HTMLDivElement>) {
      const rows = isRowDrag(event);
      if (!rows && !isFileDrag(event)) return;
      const folder = live.current.dropFolder(event.target);
      hoverTarget(pathOf(event.target));
      if (rows && activeDrag && !canDropInto(folder, activeDrag.paths)) {
        event.dataTransfer.dropEffect = "none";
        setDropTarget(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect =
        rows && !copyModifier(event) ? "move" : "copy";
      setDropTarget(folder);
    },
    onDrop(event: React.DragEvent<HTMLDivElement>) {
      const folder = live.current.dropFolder(event.target);
      if (isRowDrag(event)) {
        event.preventDefault();
        let source = activeDrag;
        try {
          source = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
        } catch {}
        clear();
        if (source)
          live.current.onDropRows(source, folder, copyModifier(event));
        return;
      }
      clear();
      if (!isFileDrag(event)) return;
      event.preventDefault();
      live.current.onDropFiles(folder, event.dataTransfer);
    },
    onDragEnd: clear,
  };

  return {
    dropTarget,
    ghost,
    handlers,
    pointerType,
    consumeClick: touch.consumeClick,
  };
}
