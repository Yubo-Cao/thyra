import { Suspense, useEffect } from "react";
import { isIosDevice } from "../downloadFile";
import { lazyWithReload } from "../lazyWithReload";

export const viewportDebugEnabled =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("debugViewport");

// Mobile browsers can over-report keyboard occlusion by including an input
// accessory or browser-control strip. Keep enough visual viewport lift to
// expose the composer, but trim the platform-specific overshoot.
const usesIosKeyboardViewportLift =
  typeof navigator !== "undefined" && isIosDevice(navigator);
// ?kbdTrim=<px> overrides the default for device-specific experiments.
const defaultKeyboardInsetTrim = usesIosKeyboardViewportLift ? 30 : 0;
const keyboardInsetTrim =
  typeof window !== "undefined"
    ? Math.max(
        0,
        Number.parseInt(
          new URLSearchParams(window.location.search).get("kbdTrim") ??
            String(defaultKeyboardInsetTrim),
          10,
        ) || 0,
      )
    : 0;

// Diagnostics for ?debugViewport load on demand, outside the first screen.
const LazyViewportDebugOverlay = lazyWithReload("viewport-debug", () =>
  import("./ViewportDebugOverlay").then((module) => ({
    default: module.ViewportDebugOverlay,
  })),
);

export function ViewportDebugOverlay() {
  return (
    <Suspense fallback={null}>
      <LazyViewportDebugOverlay />
    </Suspense>
  );
}

export function useVisualViewportCssVars(uiScale: number) {
  useEffect(() => {
    const root = document.documentElement;
    // CSS zoom scales every computed px length, so emit viewport geometry in
    // pre-zoom units to keep the rendered shell matching the real viewport.
    const geometryScale = uiScale / 100;
    let pollTimer: number | undefined;
    let settleTimers: number[] = [];

    const measure = () => {
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      const keyboardInset = Math.max(
        0,
        window.innerHeight - height - offsetTop,
      );
      const keyboardOpen = keyboardInset > 24;
      root.classList.toggle("keyboard-open", keyboardOpen);
      root.style.setProperty(
        "--app-viewport-height",
        `${Math.round(height / geometryScale)}px`,
      );
      // Keep the app surface at the full layout height, even while the
      // keyboard is open. iOS can over-report the keyboard occlusion (the
      // floating keyboard accessory bar counts as covered area), so sizing
      // the app to the visual viewport leaves an unpainted strip above the
      // keyboard. Instead the app stays full-height and content is lifted
      // with padding-bottom in the mobile styles.
      root.style.setProperty(
        "--app-height",
        `calc(${Math.round(window.innerHeight / geometryScale)}px + env(safe-area-inset-bottom, 0px))`,
      );
      root.style.setProperty(
        "--app-viewport-offset-top",
        `${Math.round(offsetTop / geometryScale)}px`,
      );
      root.style.setProperty(
        "--keyboard-inset-bottom",
        `${Math.round(keyboardInset / geometryScale)}px`,
      );
      // Both platforms need the visual viewport lift here; without it some
      // Android browsers place the composer behind the software keyboard.
      const contentInset = Math.max(0, keyboardInset - keyboardInsetTrim);
      root.style.setProperty(
        "--keyboard-inset-content",
        `${Math.round(contentInset / geometryScale)}px`,
      );
      root.style.setProperty(
        "--keyboard-inset-composer-gap",
        `${Math.round(
          (usesIosKeyboardViewportLift
            ? Math.max(0, keyboardInset - contentInset)
            : 0) / geometryScale,
        )}px`,
      );
      return keyboardOpen;
    };

    const stopPolling = () => {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    // Third-party iOS keyboards can change height (toolbars, candidate rows)
    // without firing visualViewport events, leaving the app sized for a
    // stale keyboard inset and exposing a blank strip above the keyboard.
    // Poll the geometry while the keyboard is open so those changes apply.
    const syncPolling = (keyboardOpen: boolean) => {
      if (keyboardOpen && pollTimer === undefined) {
        pollTimer = window.setInterval(() => {
          if (!measure()) stopPolling();
        }, 500);
      } else if (!keyboardOpen) {
        stopPolling();
      }
    };

    const update = () => {
      syncPolling(measure());
    };

    // iOS reports keyboard geometry in stages during the show/hide animation,
    // so re-measure after it settles to catch the final values.
    const updateWhenSettled = () => {
      update();
      for (const timer of settleTimers) window.clearTimeout(timer);
      settleTimers = [250, 600].map((delay) =>
        window.setTimeout(update, delay),
      );
    };

    update();
    window.visualViewport?.addEventListener("resize", updateWhenSettled);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", updateWhenSettled);
    window.addEventListener("focusin", updateWhenSettled);
    window.addEventListener("focusout", updateWhenSettled);
    return () => {
      stopPolling();
      for (const timer of settleTimers) window.clearTimeout(timer);
      window.visualViewport?.removeEventListener("resize", updateWhenSettled);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", updateWhenSettled);
      window.removeEventListener("focusin", updateWhenSettled);
      window.removeEventListener("focusout", updateWhenSettled);
      root.classList.remove("keyboard-open");
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--app-viewport-offset-top");
      root.style.removeProperty("--keyboard-inset-bottom");
      root.style.removeProperty("--keyboard-inset-content");
      root.style.removeProperty("--keyboard-inset-composer-gap");
    };
  }, [uiScale]);
}
