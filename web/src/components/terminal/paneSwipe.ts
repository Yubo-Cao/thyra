import { useEffect } from "react";
import { paneSwipeFingers, SwipeTracker } from "../../touchGestures";

type Motion = typeof import("./PaneSwipeOverlay");
let motion: Motion | undefined;
let loading: Promise<Motion> | undefined;
const loadMotion = () =>
  (loading ??= import("./PaneSwipeOverlay").then((module) => {
    motion = module;
    return module;
  }));

const installed = new WeakMap<HTMLElement, { users: number; stop(): void }>();

/**
 * A three- or four-finger horizontal swipe on the pane area (see
 * `paneSwipeFingers`) drags it aside for the next pane, left to right, or the
 * previous one, wrapping at either end. Split views share one recognizer; the
 * drag and its animation load with the first multi-finger touch.
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
    // The lifts after a switch may target an unmounted pane and never arrive
    // here, so a gesture whose touches are all new starts over.
    if (e.type === "touchstart" && e.touches.length === e.changedTouches.length)
      swipe.cancel();
    const fingers = paneSwipeFingers();
    multiTouch = fingers > 0 && e.touches.length >= 3;
    if (multiTouch) {
      e.preventDefault();
      void loadMotion();
    }
    swipe.touch(e.touches, fingers);
    motion?.paneSwipeTouch(surface, e.touches.length, swipe.delta(), e);
  };
  const onEnd = (e: TouchEvent) => {
    const cancel = e.type === "touchcancel";
    const delta = cancel ? null : swipe.delta();
    const step = cancel ? 0 : swipe.lift(e.touches.length);
    if (cancel) swipe.cancel();
    if (cancel || e.touches.length === 0) multiTouch = false;
    if (motion) motion.paneSwipeTouch(surface, e.touches.length, delta, e);
    else if (step) void loadMotion().then((module) => module.switchPane(step));
  };
  surface.addEventListener("touchstart", claim, options);
  surface.addEventListener("touchmove", claim, options);
  surface.addEventListener("touchend", onEnd, options);
  surface.addEventListener("touchcancel", onEnd, options);
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
