import { useState } from "react";
import { lazyPanel } from "../../lazyWithReload";

// Every overlay implementation (React Aria components and HeroUI overlay
// CSS) lives in one lazily loaded chunk. The wrappers in components/ui
// import only this file, so importing Dialog, Menu, Select, Popover, Tooltip,
// or ToastRegion from an eagerly loaded module costs a few hundred bytes.

const overlays = () => import("./overlays");

const dialog = lazyPanel("ui-overlays", () =>
  overlays().then((module) => module.DialogImpl),
);
const menu = lazyPanel("ui-overlays", () =>
  overlays().then((module) => module.MenuPopover),
);
const select = lazyPanel("ui-overlays", () =>
  overlays().then((module) => module.SelectPopover),
);
const popover = lazyPanel("ui-overlays", () =>
  overlays().then((module) => module.PopoverImpl),
);
const tooltip = lazyPanel("ui-overlays", () =>
  overlays().then((module) => module.TooltipPopup),
);
const toastRegion = lazyPanel("ui-overlays", () =>
  overlays().then((module) => module.ToastRegionImpl),
);

export const LazyDialog = dialog.Component;
export const LazyMenuPopover = menu.Component;
export const LazySelectPopover = select.Component;
export const LazyPopover = popover.Component;
export const LazyTooltipPopup = tooltip.Component;
export const LazyToastRegion = toastRegion.Component;

/**
 * Fetch the overlay chunk ahead of use (trigger hover/focus, idle time). A
 * failed prefetch stays silent; only an overlay that renders retries with a
 * reload.
 */
export function preloadOverlays(): void {
  for (const panel of [dialog, menu, select, popover, tooltip, toastRegion])
    void panel.preload();
}

/**
 * True from the first render where `open` is true; overlays stay mounted
 * afterwards so their exit animation can play.
 */
export function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}
