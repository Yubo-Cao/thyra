import { useEffect } from "react";
import { activePaneIdForSnapshot } from "../../paneJump";
import { store } from "../../store";
import {
  adjacentPane,
  paneNavigationOrder,
  paneSwipeFingers,
  SwipeTracker,
} from "../../touchGestures";

const installed = new WeakMap<HTMLElement, { users: number; stop(): void }>();

/**
 * A three- or four-finger horizontal swipe on the pane area (see
 * `paneSwipeFingers`) moves to the next pane, left to right, or the previous
 * one, wrapping at either end. Split views share one recognizer.
 */
export function usePaneSwipe(container: HTMLElement | null) {
  useEffect(() => {
    const surface =
      container?.closest<HTMLElement>(".workspace-terminal-surface") ??
      container;
    if (!surface) return;
    let entry = installed.get(surface);
    if (!entry) {
      entry = { users: 0, stop: installPaneSwipe(surface) };
      installed.set(surface, entry);
    }
    entry.users++;
    const current = entry;
    return () => {
      if (--current.users > 0) return;
      current.stop();
      installed.delete(surface);
    };
  }, [container]);
}

function installPaneSwipe(surface: HTMLElement): () => void {
  const abort = new AbortController();
  const options = { capture: true, passive: false, signal: abort.signal };
  const swipe = new SwipeTracker();
  let multiTouch = false;
  // iOS maps three fingers to undo, redo and the edit menu while a text field
  // (xterm's or the composer's) is focused; the page claims them instead.
  const claim = (e: TouchEvent) => {
    // The lifts after a switch target the unmounted pane and never arrive
    // here, so a gesture whose touches are all new starts over.
    if (e.type === "touchstart" && e.touches.length === e.changedTouches.length)
      swipe.cancel();
    const fingers = paneSwipeFingers();
    multiTouch = fingers > 0 && e.touches.length >= 3;
    if (multiTouch) e.preventDefault();
    swipe.touch(e.touches, fingers);
  };
  const onEnd = (e: TouchEvent) => {
    const step = swipe.lift(e.touches.length);
    if (e.touches.length === 0) multiTouch = false;
    if (step) navigate(step);
  };
  surface.addEventListener("touchstart", claim, options);
  surface.addEventListener("touchmove", claim, options);
  surface.addEventListener("touchend", onEnd, options);
  surface.addEventListener(
    "touchcancel",
    () => {
      swipe.cancel();
      multiTouch = false;
    },
    options,
  );
  document.addEventListener(
    "beforeinput",
    (e) => {
      if (multiTouch && e.inputType.startsWith("history")) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    options,
  );
  return () => abort.abort();
}

function navigate(step: -1 | 1) {
  const state = store.get();
  const target = adjacentPane(
    paneNavigationOrder(state.workspaces, state.tabs, state.panes),
    activePaneIdForSnapshot(state),
    step,
  );
  if (!target) return;
  // The pane switcher's path: a pane another device displays is neither
  // resized by this page nor focused by the bridge on its behalf.
  void store.focusPane(target.pane_id);
  void import("./PaneSwipeOverlay").then(({ showPaneSwipeOverlay }) =>
    showPaneSwipeOverlay(target),
  );
}
