// Thyra's single service worker (scope "/"): offline-capable app shell and
// asset caching for slow links, plus Web Push task notifications. Keep one
// worker at this URL; push subscriptions belong to this registration.

// Bump a version when the stored format or strategy changes; activation
// deletes every other "thyra-" cache.
const SHELL_CACHE = "thyra-shell-v1";
const ASSET_CACHE = "thyra-assets-v1";
const CACHE_PREFIX = "thyra-";
const SHELL_KEY = "/";
const MANIFEST_URL = "/thyra-assets.json";
const MANIFEST_KEY = "/__thyra/asset-manifest";
// A cached shell is used when the network has not answered in this time.
const SHELL_NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && !keep.has(name)) {
          await caches.delete(name);
        }
      }
      await self.clients.claim();
    })(),
  );
});

/** Fingerprinted build output: the server marks it immutable. */
function isAssetPath(pathname) {
  return (
    pathname.startsWith("/assets/") &&
    !pathname.includes("/../") &&
    !pathname.includes("//")
  );
}

function isShellNavigation(request, url) {
  return (
    request.mode === "navigate" &&
    (url.pathname === "/" || url.pathname === "/index.html")
  );
}

/** Only a successful same-origin HTML app document may become the shell. */
function isCacheableShell(response) {
  return (
    response.status === 200 &&
    response.type === "basic" &&
    !response.redirected &&
    (response.headers.get("content-type") ?? "").startsWith("text/html")
  );
}

/** Only immutable, successful, non-HTML asset responses are cached. */
function isCacheableAsset(response) {
  return (
    response.status === 200 &&
    response.type === "basic" &&
    !response.redirected &&
    !(response.headers.get("content-type") ?? "").startsWith("text/html") &&
    (response.headers.get("cache-control") ?? "").includes("immutable")
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Queries carry login tokens and other one-off state; leave them alone.
  if (url.origin !== self.location.origin || url.search) return;
  if (isShellNavigation(request, url)) {
    const network = fetch(request);
    event.waitUntil(
      network
        .then((response) =>
          isCacheableShell(response) ? storeShell(response.clone()) : null,
        )
        .catch(() => {}),
    );
    event.respondWith(shellResponse(network));
    return;
  }
  if (isAssetPath(url.pathname) && !request.headers.has("range")) {
    event.respondWith(assetResponse(event, request));
  }
});

/**
 * Network first, so logins, redirects and updates behave as without a worker.
 * The cached shell answers only when the network fails or is slower than the
 * timeout; the late network response still refreshes the cache.
 */
async function shellResponse(network) {
  const cached = await caches
    .open(SHELL_CACHE)
    .then((cache) => cache.match(SHELL_KEY))
    .catch(() => undefined);
  if (!cached) return network;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };
    const timer = setTimeout(() => settle(cached), SHELL_NETWORK_TIMEOUT_MS);
    network.then(settle, () => settle(cached));
  });
}

async function assetResponse(event, request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request.url, { ignoreVary: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheableAsset(response)) {
    event.waitUntil(cache.put(request.url, response.clone()).catch(() => {}));
  }
  return response;
}

async function storeShell(response) {
  const cache = await caches.open(SHELL_CACHE);
  const previous = await cache.match(SHELL_KEY);
  const [text, previousText] = await Promise.all([
    response.clone().text(),
    previous ? previous.text() : null,
  ]);
  await cache.put(SHELL_KEY, response);
  if (text !== previousText || !(await cache.match(MANIFEST_KEY))) {
    await refreshAssetManifest();
  }
}

function isAssetManifest(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.version === "string" &&
    Array.isArray(value.assets) &&
    value.assets.every((path) => typeof path === "string" && isAssetPath(path))
  );
}

/**
 * Drop cached assets that neither the current nor the previous build uses.
 * Keeping the previous build lets a page that started from a cached shell
 * finish loading while a newer shell is being stored.
 */
async function refreshAssetManifest() {
  const response = await fetch(MANIFEST_URL, {
    cache: "no-cache",
    credentials: "same-origin",
  });
  if (!response.ok || response.redirected) return;
  const manifest = await response.json().catch(() => null);
  if (!isAssetManifest(manifest)) return;
  const shell = await caches.open(SHELL_CACHE);
  const stored = await shell
    .match(MANIFEST_KEY)
    .then((entry) => entry?.json())
    .catch(() => null);
  const current = isAssetManifest(stored?.current) ? stored.current : null;
  if (current?.version === manifest.version) return;
  const keep = new Set(manifest.assets);
  for (const path of current?.assets ?? []) keep.add(path);
  const assets = await caches.open(ASSET_CACHE);
  for (const request of await assets.keys()) {
    if (!keep.has(new URL(request.url).pathname)) await assets.delete(request);
  }
  await shell.put(
    MANIFEST_KEY,
    new Response(
      JSON.stringify({
        current: { version: manifest.version, assets: manifest.assets },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
}

// Copy from the HTTP cache only: priming must never download anything again.
const FROM_HTTP_CACHE = {
  cache: "only-if-cached",
  mode: "same-origin",
  credentials: "same-origin",
};

/**
 * The page loaded its first assets before this worker controlled it; copy
 * those still in the HTTP cache so the next visit is served locally. Anything
 * missing is cached by the worker when the page next requests it.
 */
async function primeCache(urls) {
  const assets = await caches.open(ASSET_CACHE);
  for (const href of urls) {
    let url;
    try {
      url = new URL(href, self.location.origin);
    } catch {
      continue;
    }
    if (
      url.origin !== self.location.origin ||
      url.search ||
      !isAssetPath(url.pathname) ||
      (await assets.match(url.href, { ignoreVary: true }))
    ) {
      continue;
    }
    try {
      const response = await fetch(url.href, FROM_HTTP_CACHE);
      if (isCacheableAsset(response)) await assets.put(url.href, response);
    } catch {
      // Not in the HTTP cache: the next controlled load caches it instead.
    }
  }
  const shell = await caches.open(SHELL_CACHE);
  if (!(await shell.match(SHELL_KEY))) {
    try {
      const response = await fetch(SHELL_KEY, {
        ...FROM_HTTP_CACHE,
        redirect: "manual",
      });
      if (isCacheableShell(response)) await storeShell(response);
    } catch {
      // The next navigation stores the shell.
    }
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data?.type !== "thyra:prime-cache" || !Array.isArray(data.urls)) return;
  if (event.origin && event.origin !== self.location.origin) return;
  event.waitUntil(
    primeCache(
      data.urls.filter((url) => typeof url === "string").slice(0, 500),
    ).catch(() => {}),
  );
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let message;
      try {
        message = event.data?.json();
      } catch {
        /* Show a visible fallback for invalid payloads. */
      }
      const target = message?.target;
      const valid =
        target &&
        typeof target.connectionId === "string" &&
        target.connectionId &&
        Number.isSafeInteger(target.runtimeGeneration) &&
        target.runtimeGeneration >= 0 &&
        typeof target.workspaceId === "string" &&
        target.workspaceId &&
        typeof target.paneId === "string" &&
        target.paneId;
      await self.registration.showNotification(
        typeof message?.title === "string"
          ? message.title
          : "Thyra agent update",
        {
          body:
            typeof message?.body === "string"
              ? message.body
              : "Open Thyra to check your agents.",
          tag: typeof message?.tag === "string" ? message.tag : "thyra-task",
          data: valid
            ? { type: "thyra:task-notification-activate", target }
            : null,
        },
      );
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  if (data?.type !== "thyra:task-notification-activate") return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const appWindows = windows.filter((client) => {
        const url = new URL(client.url);
        return (
          url.origin === self.location.origin &&
          (url.pathname === "/" || url.pathname === "/index.html")
        );
      });
      appWindows.sort((a, b) => Number(b.focused) - Number(a.focused));
      for (const client of appWindows) {
        try {
          await client.focus().catch(() => {});
          client.postMessage(data);
          return;
        } catch {
          // A window can close between discovery and activation.
        }
      }
      const url = new URL("/", self.location.origin);
      url.hash =
        "thyra-task=" + encodeURIComponent(JSON.stringify(data.target));
      await self.clients.openWindow(url.href);
    })(),
  );
});
