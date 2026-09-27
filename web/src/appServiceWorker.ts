import { afterStartup } from "./startupGate";
import { NOTIFICATION_WORKER } from "./taskNotifications";

export const PRIME_CACHE_MESSAGE = "thyra:prime-cache";

/** Same-origin fingerprinted assets this page has already loaded. */
export function loadedAssetUrls(
  entries: readonly { name: string }[],
  origin: string,
): string[] {
  const urls = new Set<string>();
  for (const { name } of entries) {
    try {
      const url = new URL(name, origin);
      if (
        url.origin === origin &&
        url.pathname.startsWith("/assets/") &&
        !url.search
      ) {
        urls.add(url.href);
      }
    } catch {
      // Resource timing names are URLs; skip anything else.
    }
  }
  return [...urls];
}

/**
 * Register the app's single worker (shell/asset cache and task notifications)
 * once the page has loaded and the terminal has shown output, so it never
 * competes with the first download. Assets fetched before the worker took
 * control are then copied into its cache, normally from the HTTP cache.
 */
export function registerAppServiceWorker(): void {
  if (
    typeof navigator === "undefined" ||
    !navigator.serviceWorker ||
    !window.isSecureContext
  ) {
    return;
  }
  const serviceWorker = navigator.serviceWorker;
  // A controlled page already runs the worker, and navigation itself checks
  // for worker updates; registering again would only repeat the priming.
  if (
    serviceWorker.controller?.scriptURL ===
    new URL(NOTIFICATION_WORKER, window.location.origin).href
  ) {
    return;
  }
  const start = () => {
    serviceWorker
      .register(NOTIFICATION_WORKER, { updateViaCache: "none" })
      .then(() => serviceWorker.ready)
      .then((registration) => {
        const prime = (entries: readonly { name: string }[]) =>
          registration.active?.postMessage({
            type: PRIME_CACHE_MESSAGE,
            urls: loadedAssetUrls(entries, window.location.origin),
          });
        prime(performance.getEntriesByType("resource"));
        // Downloads started before the worker took control (the terminal
        // font, the WebGL renderer) finish outside it; prime those too.
        new PerformanceObserver((list) => prime(list.getEntries())).observe({
          type: "resource",
        });
      })
      .catch(() => {
        // Caching is an optimization; the app works without a worker.
      });
  };
  const afterLoad = () => afterStartup(start);
  if (document.readyState === "complete") afterLoad();
  else window.addEventListener("load", afterLoad, { once: true });
}
