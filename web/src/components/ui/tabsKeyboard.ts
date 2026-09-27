export type TabsOrientation = "horizontal" | "vertical";

/**
 * Index of the tab that arrow/Home/End keys move to, skipping disabled tabs
 * and wrapping at the ends; null when the key is not a tab navigation key.
 */
export function nextTabIndex(
  key: string,
  current: number,
  disabled: readonly boolean[],
  orientation: TabsOrientation = "horizontal",
): number | null {
  const count = disabled.length;
  if (!count || disabled.every(Boolean)) return null;
  const forward = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  const backward = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  let start: number;
  let step: number;
  if (key === "Home") [start, step] = [0, 1];
  else if (key === "End") [start, step] = [count - 1, -1];
  else if (key === forward) [start, step] = [current + 1, 1];
  else if (key === backward) [start, step] = [current - 1, -1];
  else return null;
  for (let offset = 0; offset < count; offset += 1) {
    const index = (((start + offset * step) % count) + count) % count;
    if (!disabled[index]) return index;
  }
  return null;
}
