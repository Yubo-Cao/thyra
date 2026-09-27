import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { loadedAssetUrls } from "./appServiceWorker";

const origin = "https://thyra.example";
const workerSource = readFileSync(
  new URL("../public/task-notifications-sw.js", import.meta.url),
  "utf8",
);

type Listener = (event: any) => void;

/** Minimal Cache Storage keyed by URL, like the browser's. */
class FakeCache {
  entries = new Map<string, Response>();
  key(request: Request | string) {
    return new URL(typeof request === "string" ? request : request.url, origin)
      .href;
  }
  async match(request: Request | string) {
    return this.entries.get(this.key(request))?.clone();
  }
  async put(request: Request | string, response: Response) {
    await response.clone().arrayBuffer();
    this.entries.set(this.key(request), response);
  }
  async delete(request: Request | string) {
    return this.entries.delete(this.key(request));
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  async open(name: string) {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache;
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
}

function serverResponse(
  body: string,
  {
    status = 200,
    type = "basic",
    redirected = false,
    headers = {},
  }: {
    status?: number;
    type?: string;
    redirected?: boolean;
    headers?: Record<string, string>;
  } = {},
): Response {
  // Opaque redirects report status 0, which cannot be constructed.
  const response = new Response(body, {
    status: status < 200 ? 200 : status,
    headers,
  });
  // Constructed responses report "default"; network ones are "basic".
  const network = (target: Response) => {
    Object.defineProperty(target, "status", { value: status });
    Object.defineProperty(target, "type", { value: type });
    Object.defineProperty(target, "redirected", { value: redirected });
    const clone = target.clone.bind(target);
    target.clone = () => network(clone());
    return target;
  };
  return network(response);
}

const immutable = {
  "content-type": "text/javascript; charset=utf-8",
  "cache-control": "private, max-age=31536000, immutable",
};
const html = { "content-type": "text/html; charset=utf-8" };

function loadWorker(
  fetchImpl: (request: Request | string, init?: RequestInit) => unknown,
  { timers }: { timers?: { setTimeout: any; clearTimeout: any } } = {},
) {
  const listeners: Record<string, Listener> = {};
  const storage = new FakeCacheStorage();
  const fetch = mock(async (request: Request | string, init?: RequestInit) =>
    fetchImpl(request, init),
  );
  const claim = mock(async () => {});
  runInNewContext(workerSource, {
    URL,
    Response,
    JSON,
    Promise,
    Set,
    setTimeout: timers?.setTimeout ?? setTimeout,
    clearTimeout: timers?.clearTimeout ?? clearTimeout,
    caches: storage,
    fetch,
    self: {
      location: { origin },
      addEventListener: (name: string, handler: Listener) => {
        listeners[name] = handler;
      },
      skipWaiting: async () => {},
      clients: { claim },
    },
  });
  return { listeners, storage, fetch, claim };
}

/** Dispatch a fetch event; resolves to the worker's response, if any. */
async function dispatchFetch(
  listeners: Record<string, Listener>,
  url: string,
  init: RequestInit & { mode?: string } = {},
) {
  const request = new Request(new URL(url, origin), init);
  if (init.mode) Object.defineProperty(request, "mode", { value: init.mode });
  let responded: Promise<Response> | undefined;
  const lifetime: Promise<unknown>[] = [];
  listeners.fetch!({
    request,
    respondWith: (response: Promise<Response>) => {
      responded = Promise.resolve(response);
    },
    waitUntil: (promise: Promise<unknown>) => lifetime.push(promise),
  });
  const response = await responded;
  await Promise.all(lifetime);
  return response;
}

async function dispatchLifetime(listener: Listener, event: object = {}) {
  let pending: Promise<unknown> | undefined;
  listener({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
  await pending;
}

describe("app service worker caching", () => {
  test("serves fingerprinted assets cache-first after one network fetch", async () => {
    const { listeners, fetch } = loadWorker(() =>
      serverResponse("console.log(1)", { headers: immutable }),
    );
    const first = await dispatchFetch(listeners, "/assets/index-abc.js");
    expect(await first?.text()).toBe("console.log(1)");
    const second = await dispatchFetch(listeners, "/assets/index-abc.js");
    expect(await second?.text()).toBe("console.log(1)");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("never caches errors, HTML, redirects or revalidated assets", async () => {
    const responses = [
      serverResponse("missing", { status: 404, headers: immutable }),
      serverResponse("<!doctype html>", {
        headers: { ...html, "cache-control": "immutable" },
      }),
      serverResponse("x", { redirected: true, headers: immutable }),
      serverResponse("x", {
        headers: { "content-type": "text/javascript" },
      }),
    ];
    for (const response of responses) {
      const { listeners, storage } = loadWorker(() => response);
      await dispatchFetch(listeners, "/assets/app-abc.js");
      expect((await storage.open("thyra-assets-v1")).entries.size).toBe(0);
    }
  });

  test("leaves API, WebSocket, login, query and non-GET requests to the network", async () => {
    const { listeners, fetch } = loadWorker(() => serverResponse("x"));
    for (const [url, init] of [
      ["/api/health", {}],
      ["/ws", {}],
      ["/login", { mode: "navigate" }],
      ["/?token=secret", { mode: "navigate" }],
      ["/assets/app.js?v=1", {}],
      ["https://cdn.example/assets/app.js", {}],
      ["/assets/app.js", { headers: { range: "bytes=0-1" } }],
      ["/api/login", { method: "POST", body: "{}" }],
    ] as const) {
      expect(await dispatchFetch(listeners, url, init)).toBeUndefined();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test("navigations are network-first and store only the app document", async () => {
    let next: Response | Error = serverResponse("<p>v1</p>", {
      headers: html,
    });
    const manifest = { version: "one", assets: ["/assets/a.js"] };
    const { listeners, storage } = loadWorker((request) => {
      const url = typeof request === "string" ? request : request.url;
      if (url.endsWith("/thyra-assets.json"))
        return serverResponse(JSON.stringify(manifest), {
          headers: { "content-type": "application/json" },
        });
      if (next instanceof Error) throw next;
      return next;
    });
    const shell = await storage.open("thyra-shell-v1");
    const first = await dispatchFetch(listeners, "/", { mode: "navigate" });
    expect(await first?.text()).toBe("<p>v1</p>");
    expect(await (await shell.match("/"))?.text()).toBe("<p>v1</p>");

    // A login redirect passes through untouched and is not cached.
    next = serverResponse("", { status: 0, type: "opaqueredirect" });
    const redirect = await dispatchFetch(listeners, "/", { mode: "navigate" });
    expect(redirect?.type).toBe("opaqueredirect");
    expect(await (await shell.match("/"))?.text()).toBe("<p>v1</p>");

    // Offline: the cached shell answers.
    next = new TypeError("Failed to fetch");
    const offline = await dispatchFetch(listeners, "/", { mode: "navigate" });
    expect(await offline?.text()).toBe("<p>v1</p>");
  });

  test("a slow network falls back to the cached shell and still refreshes it", async () => {
    let fire: (() => void) | undefined;
    const timers = {
      setTimeout: (callback: () => void) => {
        fire = callback;
        return 1;
      },
      clearTimeout: () => {},
    };
    let release: ((response: Response) => void) | undefined;
    let slow = false;
    const { listeners, storage } = loadWorker(
      (request) => {
        const url = typeof request === "string" ? request : request.url;
        if (url.endsWith("/thyra-assets.json"))
          return serverResponse(JSON.stringify({ version: "v", assets: [] }));
        if (!slow) return serverResponse("<p>old</p>", { headers: html });
        return new Promise<Response>((resolve) => (release = resolve));
      },
      { timers },
    );
    await dispatchFetch(listeners, "/", { mode: "navigate" });
    slow = true;
    const request = new Request(`${origin}/`);
    Object.defineProperty(request, "mode", { value: "navigate" });
    let responded: Promise<Response> | undefined;
    const lifetime: Promise<unknown>[] = [];
    listeners.fetch!({
      request,
      respondWith: (response: Promise<Response>) => (responded = response),
      waitUntil: (promise: Promise<unknown>) => lifetime.push(promise),
    });
    await Bun.sleep(0);
    fire?.();
    expect(await (await responded)?.text()).toBe("<p>old</p>");
    release?.(serverResponse("<p>new</p>", { headers: html }));
    await Promise.all(lifetime);
    const shell = await storage.open("thyra-shell-v1");
    expect(await (await shell.match("/"))?.text()).toBe("<p>new</p>");
  });

  test("a new build prunes assets used by neither it nor the previous build", async () => {
    let version = 1;
    const builds: Record<number, string[]> = {
      1: ["/assets/vendor.js", "/assets/app-1.js"],
      2: ["/assets/vendor.js", "/assets/app-2.js"],
      3: ["/assets/vendor.js", "/assets/app-3.js"],
    };
    const { listeners, storage } = loadWorker((request) => {
      const url = typeof request === "string" ? request : request.url;
      if (url.endsWith("/thyra-assets.json"))
        return serverResponse(
          JSON.stringify({ version: `v${version}`, assets: builds[version] }),
        );
      if (url.includes("/assets/"))
        return serverResponse(url, { headers: immutable });
      return serverResponse(`<p>${version}</p>`, { headers: html });
    });
    const assets = await storage.open("thyra-assets-v1");
    const cached = async () =>
      (await assets.keys()).map((r) => new URL(r.url).pathname).sort();
    for (version = 1; version <= 3; version++) {
      await dispatchFetch(listeners, "/", { mode: "navigate" });
      for (const path of builds[version]!) {
        await dispatchFetch(listeners, path);
      }
    }
    // Build 3 keeps its own files and build 2's; build 1's app chunk is gone.
    expect(await cached()).toEqual([
      "/assets/app-2.js",
      "/assets/app-3.js",
      "/assets/vendor.js",
    ]);
  });

  test("activation removes other Thyra cache versions and claims pages", async () => {
    const { listeners, storage, claim } = loadWorker(() => serverResponse(""));
    await storage.open("thyra-assets-v0");
    await storage.open("thyra-shell-v1");
    await storage.open("unrelated");
    await dispatchLifetime(listeners.activate!);
    expect((await storage.keys()).sort()).toEqual([
      "thyra-shell-v1",
      "unrelated",
    ]);
    expect(claim).toHaveBeenCalled();
  });

  test("priming copies same-origin assets the page loaded before control", async () => {
    const { listeners, storage, fetch } = loadWorker((request) => {
      const url = typeof request === "string" ? request : request.url;
      if (url.endsWith("/thyra-assets.json"))
        return serverResponse(
          JSON.stringify({ version: "v", assets: ["/assets/a.js"] }),
        );
      if (url.includes("/assets/"))
        return serverResponse("a", { headers: immutable });
      return serverResponse("<p>app</p>", { headers: html });
    });
    await dispatchLifetime(listeners.message!, {
      origin,
      data: {
        type: "thyra:prime-cache",
        urls: [
          `${origin}/assets/a.js`,
          "https://evil.example/assets/b.js",
          `${origin}/api/health`,
          `${origin}/assets/a.js?x=1`,
          42,
        ],
      },
    });
    const assetUrls = fetch.mock.calls
      .map(([request]) => String(request))
      .filter((url) => url.includes("/assets/"));
    expect(assetUrls).toEqual([`${origin}/assets/a.js`]);
    // Priming only copies from the HTTP cache; it never downloads again.
    for (const [request, init] of fetch.mock.calls) {
      if (String(request).endsWith("/thyra-assets.json")) continue;
      expect(init).toMatchObject({ cache: "only-if-cached" });
    }
    expect((await storage.open("thyra-assets-v1")).entries.size).toBe(1);
    const shell = await storage.open("thyra-shell-v1");
    expect(await (await shell.match("/"))?.text()).toBe("<p>app</p>");
  });
});

test("only same-origin fingerprinted assets are offered for priming", () => {
  expect(
    loadedAssetUrls(
      [
        { name: `${origin}/assets/index-abc.js` },
        { name: `${origin}/assets/index-abc.js` },
        { name: `${origin}/assets/fonts/x/400/a.woff2` },
        { name: `${origin}/api/health` },
        { name: `${origin}/assets/app.js?import` },
        { name: "https://other.example/assets/app.js" },
      ],
      origin,
    ),
  ).toEqual([
    `${origin}/assets/index-abc.js`,
    `${origin}/assets/fonts/x/400/a.woff2`,
  ]);
});
