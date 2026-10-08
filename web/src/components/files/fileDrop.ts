import { useEffect, useRef, useState } from "react";

/**
 * A dropped OS file with its folder inside the drop (`[]` at the top); a
 * null file is an empty dropped folder.
 */
export type DroppedFile = { folders: string[]; file: File | null };

const MAX_DROPPED_FILES = 2000;

type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (
    resolve: (file: File) => void,
    reject: (error: unknown) => void,
  ) => void;
  createReader?: () => {
    readEntries: (
      resolve: (entries: Entry[]) => void,
      reject: (error: unknown) => void,
    ) => void;
  };
};

/**
 * Files of an OS drop, walking dropped folders where the browser exposes
 * them (`webkitGetAsEntry`); other browsers get the flat file list.
 */
export async function droppedFiles(
  transfer: DataTransfer,
): Promise<DroppedFile[]> {
  const roots = Array.from(transfer.items ?? [])
    .map((item) => (item.webkitGetAsEntry?.() as Entry | null) ?? null)
    .filter((entry): entry is Entry => !!entry);
  if (!roots.some((entry) => entry.isDirectory)) {
    return Array.from(transfer.files).map((file) => ({ folders: [], file }));
  }
  const found: DroppedFile[] = [];
  const visit = async (entry: Entry, folders: string[]) => {
    if (found.length >= MAX_DROPPED_FILES) return;
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((resolve, reject) =>
        entry.file!(resolve, reject),
      );
      found.push({ folders, file });
      return;
    }
    if (!entry.isDirectory || !entry.createReader) return;
    const reader = entry.createReader();
    const inside = [...folders, entry.name];
    const before = found.length;
    // readEntries returns batches until an empty one.
    for (;;) {
      const batch = await new Promise<Entry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (!batch.length) break;
      for (const child of batch) await visit(child, inside);
    }
    if (found.length === before) found.push({ folders: inside, file: null });
  };
  for (const root of roots) await visit(root, []);
  return found;
}

const LONG_PRESS_MS = 500;
const MOVE_SLOP_PX = 10;

export type TouchDrag = { x: number; y: number; path: string };

/**
 * Touch and pen gestures on rows: a long-press selects (and reports where),
 * moving after the long-press drags, and lifting ends the drag. A
 * non-passive touchmove listener stops the page from scrolling while
 * dragging; before the long-press fires, moving cancels it (a scroll).
 */
export function useTouchPress({
  onLongPress,
  onDragMove,
  onDrop,
}: {
  onLongPress: (path: string | null, x: number, y: number) => void;
  onDragMove: (drag: TouchDrag) => void;
  onDrop: (drag: TouchDrag | null) => void;
}) {
  const state = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    start: { x: number; y: number } | null;
    path: string | null;
    pressed: boolean;
    dragging: boolean;
    consumeClick: boolean;
  }>({
    timer: null,
    start: null,
    path: null,
    pressed: false,
    dragging: false,
    consumeClick: false,
  });
  const [dragging, setDragging] = useState(false);
  const callbacks = useRef({ onLongPress, onDragMove, onDrop });
  callbacks.current = { onLongPress, onDragMove, onDrop };

  useEffect(() => {
    const current = state.current;
    const block = (event: TouchEvent) => {
      if (current.pressed && event.cancelable) event.preventDefault();
    };
    document.addEventListener("touchmove", block, { passive: false });
    return () => {
      document.removeEventListener("touchmove", block);
      if (current.timer) clearTimeout(current.timer);
    };
  }, []);

  const reset = () => {
    const current = state.current;
    if (current.timer) clearTimeout(current.timer);
    current.timer = null;
    current.start = null;
    current.pressed = false;
    if (current.dragging) setDragging(false);
    current.dragging = false;
  };

  return {
    dragging,
    /** Swallow the click that ends a long-press or a drag. */
    consumeClick() {
      if (!state.current.consumeClick) return false;
      state.current.consumeClick = false;
      return true;
    },
    onPointerDown(event: React.PointerEvent, path: string | null) {
      if (event.pointerType === "mouse") return;
      reset();
      const current = state.current;
      current.consumeClick = false;
      current.path = path;
      current.start = { x: event.clientX, y: event.clientY };
      const { clientX, clientY } = event;
      current.timer = setTimeout(() => {
        current.timer = null;
        current.pressed = true;
        current.consumeClick = true;
        callbacks.current.onLongPress(path, clientX, clientY);
      }, LONG_PRESS_MS);
    },
    onPointerMove(event: React.PointerEvent) {
      const current = state.current;
      if (!current.start) return;
      const moved =
        Math.abs(event.clientX - current.start.x) > MOVE_SLOP_PX ||
        Math.abs(event.clientY - current.start.y) > MOVE_SLOP_PX;
      if (!current.pressed) {
        if (moved) reset();
        return;
      }
      if (!current.path) return;
      if (!current.dragging && moved) {
        current.dragging = true;
        setDragging(true);
      }
      if (current.dragging) {
        callbacks.current.onDragMove({
          x: event.clientX,
          y: event.clientY,
          path: current.path,
        });
      }
    },
    onPointerUp(event: React.PointerEvent) {
      const current = state.current;
      const drag =
        current.dragging && current.path
          ? { x: event.clientX, y: event.clientY, path: current.path }
          : null;
      const wasPressed = current.pressed;
      reset();
      if (wasPressed) callbacks.current.onDrop(drag);
    },
    onPointerCancel() {
      const wasDragging = state.current.dragging;
      reset();
      if (wasDragging) callbacks.current.onDrop(null);
    },
  };
}
