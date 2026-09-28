import { useEffect } from "react";
import { paneSwipeFingers } from "../../touchGestures";

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
 * A horizontal swipe with two, three or four fingers on the pane area (see
 * `paneSwipeFingers`) drags it aside to reveal the neighbouring pane. Split
 * views share one recognizer; it and the drag load with the first touch, and
 * a gesture that starts before they arrive is left to the terminal.
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
  let multiTouch = false;
  // A touch that starts before the drag has loaded: it joins once it has.
  let early: TouchEvent | null = null;
  const onTouch = (e: TouchEvent) => {
    const fingers = paneSwipeFingers();
    if (!fingers) return;
    if (!motion && e.type === "touchstart") {
      early = e;
      void loadMotion().then((module) => {
        if (early) module.paneSwipeTouch(surface, early, fingers);
        early = null;
      });
    } else if (!e.touches.length) early = null;
    // iOS maps three fingers to undo, redo and the edit menu while a text
    // field (xterm's or the composer's) is focused; the page claims them.
    const ending = e.type === "touchend" || e.type === "touchcancel";
    if (e.touches.length > 2) multiTouch = fingers > 2;
    else if (!e.touches.length || e.type === "touchcancel") multiTouch = false;
    if (multiTouch && !ending) e.preventDefault();
    motion?.paneSwipeTouch(surface, e, fingers);
  };
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"])
    surface.addEventListener(type, onTouch as EventListener, options);
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
