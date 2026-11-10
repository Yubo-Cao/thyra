import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeZenMode, serializeZenMode } from "../appearance";
import { thyraLocalStorage } from "../browserStorage";
import { LAYOUT_CHANGE_EVENT } from "../layoutPreferences";

export type MobileView = "workspaces" | "session" | "inspector";

const MIN_SIDEBAR = 180;
const MAX_SIDEBAR = 560;
const DEFAULT_SIDEBAR = 284;
const ZEN_MODE_KEY = "zenMode";

function normalizeSidebarWidth(value: number): number {
  return Number.isFinite(value) && value >= MIN_SIDEBAR && value <= MAX_SIDEBAR
    ? value
    : DEFAULT_SIDEBAR;
}

const SIDEBAR_RESIZE_END_EVENTS = [
  "pointerup",
  "pointercancel",
  "lostpointercapture",
] as const;

/** The sidebar width for a drag that began at `startX` with `startWidth`. */
function sidebarResizeWidth(
  startWidth: number,
  startX: number,
  clientX: number,
): number {
  return Math.min(
    MAX_SIDEBAR,
    Math.max(MIN_SIDEBAR, startWidth + (clientX - startX)),
  );
}

function loadSidebarWidth(): number {
  return normalizeSidebarWidth(
    Number(thyraLocalStorage.getItem("sidebarWidth")),
  );
}

function loadZenMode(): boolean {
  return normalizeZenMode(thyraLocalStorage.getItem(ZEN_MODE_KEY));
}

/** Which surface the mobile layout shows, the sidebar, and Zen mode. */
export function useShellLayout(mobile: boolean) {
  const [mobileView, setMobileView] = useState<MobileView>("session");
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [zenMode, setZenMode] = useState(loadZenMode);
  const [sidebarHidden, setSidebarHidden] = useState(loadZenMode);
  // What the sidebar was doing before Zen hid it, restored when Zen ends.
  const sidebarBeforeZenRef = useRef(false);

  const toggleSidebar = useCallback(() => {
    setMobileView("session");
    setSidebarHidden((value) => !value);
  }, []);
  // Entering Zen hides the sidebar; leaving Zen puts it back as it was. In
  // between, the sidebar toggles on its own without disturbing Zen.
  const applyZenMode = useCallback(
    (next: boolean) => {
      if (next === zenMode) return;
      if (next) sidebarBeforeZenRef.current = sidebarHidden;
      setSidebarHidden(next ? true : sidebarBeforeZenRef.current);
      setZenMode(next);
    },
    [sidebarHidden, zenMode],
  );
  const toggleZenMode = useCallback(
    () => applyZenMode(!zenMode),
    [applyZenMode, zenMode],
  );
  const openWorkspaces = useCallback(() => {
    setSidebarHidden(false);
    if (mobile) {
      setMobileView("workspaces");
      return;
    }
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".workspace-tree-panel")?.focus();
    });
  }, [mobile]);

  useEffect(() => {
    thyraLocalStorage.setItem(ZEN_MODE_KEY, serializeZenMode(zenMode));
  }, [zenMode]);
  useEffect(() => {
    // Hiding/showing the sidebar snaps `.body`'s grid columns instantly (no
    // CSS transition), which grows or shrinks every terminal in the tab by
    // exactly the sidebar's width in one frame. The ResizeObserver that
    // normally drives this still fires, but its resize RPC is debounced for
    // window-drag bursts, so the newly revealed columns sit blank (the
    // terminal's own background) until that debounce elapses and the server
    // streams a redrawn frame — a black bar the width of the sidebar. Route
    // this discrete toggle through the same immediate-resize signal used for
    // mobile/desktop layout switches instead.
    window.dispatchEvent(new Event(LAYOUT_CHANGE_EVENT));
  }, [sidebarHidden]);
  useEffect(() => {
    const normalizedWidth = normalizeSidebarWidth(sidebarWidth);
    if (normalizedWidth !== sidebarWidth) {
      setSidebarWidth(normalizedWidth);
      return;
    }
    thyraLocalStorage.setItem("sidebarWidth", String(normalizedWidth));
  }, [sidebarWidth]);

  const startSidebarResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const { pointerId } = e;
    const startX = e.clientX;
    const startW = sidebarWidth;
    // Capture keeps the drag's events on the handle wherever the pointer
    // goes: over an embedded editor's iframe the window would see none, and
    // a release there would leave the sidebar following the pointer.
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // The pointer is already gone; the listeners below still end the drag.
    }
    const onMove = (ev: Event) => {
      const move = ev as PointerEvent;
      if (move.pointerId !== pointerId) return;
      setSidebarWidth(sidebarResizeWidth(startW, startX, move.clientX));
    };
    const onEnd = (ev: Event) => {
      if ((ev as PointerEvent).pointerId !== pointerId) return;
      handle.removeEventListener("pointermove", onMove);
      for (const type of SIDEBAR_RESIZE_END_EVENTS)
        handle.removeEventListener(type, onEnd);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Capture already ended (cancel, lost capture or a removed handle).
      }
    };
    handle.addEventListener("pointermove", onMove);
    for (const type of SIDEBAR_RESIZE_END_EVENTS)
      handle.addEventListener(type, onEnd);
  };

  return {
    mobileView,
    setMobileView,
    sidebarWidth,
    startSidebarResize,
    sidebarHidden,
    setSidebarHidden,
    toggleSidebar,
    openWorkspaces,
    zenMode,
    applyZenMode,
    toggleZenMode,
  };
}
