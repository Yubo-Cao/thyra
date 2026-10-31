// Geometry of a FloatingWindow: dragging the title bar moves it, an edge or
// corner resizes it, and it always stays inside the viewport.

export type Rect = { x: number; y: number; w: number; h: number };
export type Size = { w: number; h: number };
/** `move` for the title bar, otherwise the compass edges being dragged. */
export type Grip = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const GRIPS: Exclude<Grip, "move">[] = [
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
];

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

/** Shrink to fit the viewport (never below `min`), then slide inside it. */
export function clampRect(rect: Rect, viewport: Size, min: Size): Rect {
  const w = clamp(rect.w, Math.min(min.w, viewport.w), viewport.w);
  const h = clamp(rect.h, Math.min(min.h, viewport.h), viewport.h);
  return {
    w,
    h,
    x: clamp(rect.x, 0, viewport.w - w),
    y: clamp(rect.y, 0, viewport.h - h),
  };
}

/**
 * The rect after dragging `grip` by (dx, dy) from `start`. Resizing keeps
 * the opposite edge where it was, and stops at `min` and the viewport.
 */
export function dragRect(
  start: Rect,
  grip: Grip,
  dx: number,
  dy: number,
  viewport: Size,
  min: Size,
): Rect {
  if (grip === "move")
    return clampRect(
      { ...start, x: start.x + dx, y: start.y + dy },
      viewport,
      min,
    );
  let { x, y, w, h } = start;
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  if (grip.includes("e")) w = clamp(start.w + dx, min.w, viewport.w - x);
  if (grip.includes("s")) h = clamp(start.h + dy, min.h, viewport.h - y);
  if (grip.includes("w")) {
    x = clamp(start.x + dx, 0, right - min.w);
    w = right - x;
  }
  if (grip.includes("n")) {
    y = clamp(start.y + dy, 0, bottom - min.h);
    h = bottom - y;
  }
  return clampRect({ x, y, w, h }, viewport, min);
}

/** A stored rect, or null when it is missing or malformed. */
export function parseRect(raw: string | null): Rect | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Rect>;
    const fields = [value.x, value.y, value.w, value.h];
    return fields.every((field) => Number.isFinite(field))
      ? (value as Rect)
      : null;
  } catch {
    return null;
  }
}
