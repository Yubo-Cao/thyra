import { afterStartup } from "./startupGate";
import { NOTIFICATION_WORKER } from "./taskNotifications";

export const PRIME_CACHE_MESSAGE = "thyra:prime-cache";
export const PREPARE_UPDATE_MESSAGE = "thyra:prepare-update";

/** Whether the bridge serves a different build than the page's entry script. */
export function servesOtherBuild(
  served: string | undefined,
  doc: Pick<Document, "querySelector"> = document,
): boolean {
  const running = doc
    .querySelector('script[type="module"][src^="/assets/"]')
    ?.getAttribute("src");
  return Boolean(running && served && running !== served);
}

/**
 * Let the worker fetch the newer build's shell before the page offers a
 * reload, so the reload starts it from the cache on a slow link.
 */
export function prepareAppUpdate(): void {
  navigator.serviceWorker?.controller?.postMessage({
    type: PREPARE_UPDATE_MESSAGE,
  });
}

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
        const prime = (
          entries: readonly { name: string }[],
          precache = false,
        ) =>
          registration.active?.postMessage({
            type: PRIME_CACHE_MESSAGE,
            urls: loadedAssetUrls(entries, window.location.origin),
            precache,
          });
        // The first message also has the worker precache the app shell.
        prime(performance.getEntriesByType("resource"), true);
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
