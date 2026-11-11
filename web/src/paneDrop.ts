// Dragging a pane header onto another pane of the same tab: where the pointer
// is over the target decides between swapping the two panes (the centre) and
// moving the dragged pane beside the target (the nearest edge).
import type { PaneLayout, Rect } from "./types";

export type PaneDropZone = "center" | "left" | "right" | "top" | "bottom";

export type PaneDropTarget = { paneId: string; zone: PaneDropZone };

export type PaneDropRequest =
  | {
      method: "pane.swap";
      params: { source_pane_id: string; target_pane_id: string };
    }
  | {
      method: "pane.move";
      params: {
        pane_id: string;
        focus: false;
        destination: {
          type: "tab";
          tab_id: string;
          target_pane_id: string;
          split: "right" | "down";
          position: "before" | "after";
        };
      };
    };

type Point = { x: number; y: number };

/** Half-width of the centre box, as a fraction of the pane (middle 40%). */
const CENTER_HALF = 0.2;

/**
 * The zone of `rect` under `point`, or null outside it. The centre box swaps;
 * elsewhere the nearest edge (relative to the pane's size) wins.
 */
export function paneDropZone(point: Point, rect: Rect): PaneDropZone | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const fx = (point.x - rect.x) / rect.width;
  const fy = (point.y - rect.y) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  if (Math.abs(fx - 0.5) <= CENTER_HALF && Math.abs(fy - 0.5) <= CENTER_HALF)
    return "center";
  const edges: [PaneDropZone, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  let best = edges[0];
  for (const edge of edges) if (edge[1] < best[1]) best = edge;
  return best[0];
}

/**
 * The pane and zone under `point` (in layout coordinates), skipping the
 * dragged pane itself: dropping on the source does nothing.
 */
export function paneDropTarget(
  point: Point,
  panes: readonly { pane_id: string; rect: Rect }[],
  sourcePaneId: string,
): PaneDropTarget | null {
  for (const pane of panes) {
    const zone = paneDropZone(point, pane.rect);
    if (!zone) continue;
    if (pane.pane_id === sourcePaneId) return null;
    return { paneId: pane.pane_id, zone };
  }
  return null;
}

/** The part of the target the dragged pane would occupy after the drop. */
export function paneDropPreviewRect(zone: PaneDropZone, rect: Rect): Rect {
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  switch (zone) {
    case "center":
      return rect;
    case "left":
      return { ...rect, width: halfWidth };
    case "right":
      return { ...rect, x: rect.x + halfWidth, width: halfWidth };
    case "top":
      return { ...rect, height: halfHeight };
    case "bottom":
      return { ...rect, y: rect.y + halfHeight, height: halfHeight };
  }
}

const EDGE_PLACEMENT = {
  left: { split: "right", position: "before" },
  right: { split: "right", position: "after" },
  top: { split: "down", position: "before" },
  bottom: { split: "down", position: "after" },
} as const;

/** The Herdr call for dropping `sourcePaneId` on a target in tab `tabId`. */
export function paneDropRequest(
  sourcePaneId: string,
  target: PaneDropTarget,
  tabId: string,
): PaneDropRequest | null {
  if (!sourcePaneId || !target.paneId || sourcePaneId === target.paneId)
    return null;
  if (target.zone === "center")
    return {
      method: "pane.swap",
      params: { source_pane_id: sourcePaneId, target_pane_id: target.paneId },
    };
  return {
    method: "pane.move",
    params: {
      pane_id: sourcePaneId,
      focus: false,
      destination: {
        type: "tab",
        tab_id: tabId,
        target_pane_id: target.paneId,
        ...EDGE_PLACEMENT[target.zone],
      },
    },
  };
}

/** The new layout in a `pane.swap` or `pane.move` result, if any. */
export function paneDropResultLayout(result: unknown): PaneLayout | null {
  if (!result || typeof result !== "object") return null;
  const value = result as {
    swap?: { layout?: unknown };
    move_result?: { target_layout?: unknown };
  };
  const layout = value.swap?.layout ?? value.move_result?.target_layout;
  if (!layout || typeof layout !== "object") return null;
  const candidate = layout as Partial<PaneLayout>;
  return typeof candidate.tab_id === "string" && Array.isArray(candidate.panes)
    ? (candidate as PaneLayout)
    : null;
}
