// Thyra's single service worker (scope "/"): offline-capable app shell and
// versioned asset caching for slow links, plus Web Push task notifications.
// Keep one worker at this URL; push subscriptions belong to this registration.
// Nothing here is specific to one build, so a deploy does not replace the
// worker; builds are tracked through /thyra-assets.json instead.

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
// Cached assets of this many earlier builds survive a new one, so pages still
// running them (open tabs, a stale shell) can lazy-load their chunks.
const PREVIOUS_BUILDS = 2;
// A manifest fetched this recently answers again without a request.
const MANIFEST_REUSE_MS = 30_000;

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

/**
 * Asset downloads in flight by URL (a promise that settles once the file is
 * cached or refused), so a page request and precaching never fetch the same
 * file twice.
 */
const downloads = new Map();

function track(url, stored) {
  const settled = stored
    .catch(() => {})
    .finally(() => {
      if (downloads.get(url) === settled) downloads.delete(url);
    });
  downloads.set(url, settled);
  return settled;
}

/** Cache first: a fingerprinted URL never changes content. */
async function assetResponse(event, request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request.url, { ignoreVary: true });
  if (cached) return cached;
  const pending = downloads.get(request.url);
  if (pending) {
    await pending;
    const joined = await cache.match(request.url, { ignoreVary: true });
    if (joined) return joined;
  }
  const network = fetch(request);
  // One copy streams to the page, the other into the cache.
  event.waitUntil(
    track(
      request.url,
      network.then((response) =>
        isCacheableAsset(response)
          ? cache.put(request.url, response.clone())
          : undefined,
      ),
    ),
  );
  return network;
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
    await syncBuild(true);
  }
}

function isBuild(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.version === "string" &&
    Array.isArray(value.assets) &&
    value.assets.every((path) => typeof path === "string" && isAssetPath(path))
  );
}

function isAssetManifest(value) {
  return (
    isBuild(value) &&
    (value.precache === undefined ||
      (Array.isArray(value.precache) &&
        value.precache.every(
          (path) => typeof path === "string" && isAssetPath(path),
        )))
  );
}

let recentManifest = null;

/**
 * Fetch the server's build manifest and, when the build changed, drop cached
 * assets that neither it nor the previous few builds use. Keeping earlier
 * builds lets pages started from them (a stale shell, a tab left open across
 * a deploy) finish loading; the server also keeps their files.
 */
async function syncBuild(fresh = false) {
  if (
    !fresh &&
    recentManifest &&
    Date.now() - recentManifest.at < MANIFEST_REUSE_MS
  ) {
    return recentManifest.manifest;
  }
  const response = await fetch(MANIFEST_URL, {
    cache: "no-cache",
    credentials: "same-origin",
  });
  if (!response.ok || response.redirected) return null;
  const manifest = await response.json().catch(() => null);
  if (!isAssetManifest(manifest)) return null;
  recentManifest = { at: Date.now(), manifest };
  const shell = await caches.open(SHELL_CACHE);
  const stored = await shell
    .match(MANIFEST_KEY)
    .then((entry) => entry?.json())
    .catch(() => null);
  const current = isBuild(stored?.current) ? stored.current : null;
  if (current?.version === manifest.version) return manifest;
  const previous = [
    current,
    ...(Array.isArray(stored?.previous) ? stored.previous : []),
  ]
    .filter((build) => isBuild(build) && build.version !== manifest.version)
    .slice(0, PREVIOUS_BUILDS)
    .map(({ version, assets }) => ({ version, assets }));
  const keep = new Set(manifest.assets);
  for (const build of previous) {
    for (const path of build.assets) keep.add(path);
  }
  const assets = await caches.open(ASSET_CACHE);
  for (const request of await assets.keys()) {
    if (!keep.has(new URL(request.url).pathname)) await assets.delete(request);
  }
  await shell.put(
    MANIFEST_KEY,
    new Response(
      JSON.stringify({
        current: { version: manifest.version, assets: manifest.assets },
        previous,
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  return manifest;
}

/**
 * Download the build's app shell (entry and terminal chunks, core font
 * slices) that is not cached yet, one file at a time. Anything the page
 * already loaded comes from the HTTP cache, not the network.
 */
async function precacheBuild(manifest) {
  const assets = await caches.open(ASSET_CACHE);
  for (const path of manifest.precache ?? []) {
    const url = new URL(path, self.location.origin).href;
    if (await assets.match(url, { ignoreVary: true })) continue;
    const pending = downloads.get(url);
    if (pending) {
      await pending;
      continue;
    }
    let stored = false;
    await track(
      url,
      fetch(url, { cache: "force-cache", credentials: "same-origin" }).then(
        (response) => {
          if (!isCacheableAsset(response)) return undefined;
          stored = true;
          return assets.put(url, response);
        },
      ),
    );
    // Offline or refused: stop; the next load caches what it uses.
    if (!stored) return;
  }
}

async function syncAndPrecache() {
  const manifest = await syncBuild();
  if (manifest) await precacheBuild(manifest);
}

/**
 * A newer build is deployed while an older page runs: store its shell, so
 * the reload the page offers starts it even when the network is slower than
 * the shell timeout, then prepare its app shell in the background.
 */
async function prepareUpdate() {
  try {
    const response = await fetch(SHELL_KEY, {
      cache: "no-cache",
      credentials: "same-origin",
      redirect: "manual",
      headers: { accept: "text/html" },
    });
    if (isCacheableShell(response)) await storeShell(response);
  } catch {
    // The reload fetches the shell itself.
  }
  await syncAndPrecache();
}

// Copy from the HTTP cache without touching the network.
const FROM_HTTP_CACHE = {
  cache: "only-if-cached",
  mode: "same-origin",
  credentials: "same-origin",
};
// The HTTP cache first, the network only when it has no copy.
const PREFER_HTTP_CACHE = { cache: "force-cache", credentials: "same-origin" };

/**
 * The page loaded these assets before this worker controlled it; copy them
 * from the HTTP cache so the next visit is served locally. WebKit can miss a
 * file it has just loaded (or refuse `only-if-cached`); since the page uses
 * the file, it is then fetched through the HTTP cache instead.
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
    if (downloads.has(url.href)) continue;
    await track(
      url.href,
      fetch(url.href, FROM_HTTP_CACHE)
        .catch(() => null)
        .then((copy) =>
          copy && isCacheableAsset(copy)
            ? copy
            : fetch(url.href, PREFER_HTTP_CACHE),
        )
        .then((response) =>
          isCacheableAsset(response)
            ? assets.put(url.href, response)
            : undefined,
        ),
    );
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
  if (event.origin && event.origin !== self.location.origin) return;
  if (data?.type === "thyra:prime-cache" && Array.isArray(data.urls)) {
    event.waitUntil(
      primeCache(
        data.urls.filter((url) => typeof url === "string").slice(0, 500),
      )
        .then(() => (data.precache === true ? syncAndPrecache() : null))
        .catch(() => {}),
    );
  } else if (data?.type === "thyra:prepare-update") {
    event.waitUntil(prepareUpdate().catch(() => {}));
  }
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
