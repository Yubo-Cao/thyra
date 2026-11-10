import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import { createVscodeProxy } from "./proxy";
import { createVscodeStaticCache } from "./static-cache";
import {
  asciiFontChunks,
  EDITOR_FONT_FAMILY,
  withThyraFonts,
} from "./workbench-html";

const COMMIT = "2c33b50b16c472efe58357d1d2a8a5414bc23fbf";
const STATIC = `/vscode/stable-${COMMIT}/static`;
const SCRIPT = `globalThis.workbench = ${JSON.stringify("x".repeat(4096))};`;
const settings = (value: unknown) =>
  JSON.stringify(value).replace(/"/g, "&quot;");
const page = (value: unknown) =>
  `<html><head><meta id="vscode-workbench-web-configuration" data-settings="${settings(value)}"></head><body></body></html>`;

let upstream: ReturnType<typeof Bun.serve>;
let hits: string[] = [];
let script = SCRIPT;

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      hits.push(pathname);
      if (pathname === "/vscode/")
        return new Response(page({ remoteAuthority: "thyra.test" }), {
          headers: { "content-type": "text/html" },
        });
      if (pathname === `${STATIC}/out/workbench.js`)
        return new Response(script, {
          headers: {
            "content-type": "text/javascript",
            "cache-control": "public, max-age=31536000",
          },
        });
      if (pathname === `${STATIC}/icon.png`)
        return new Response(new Uint8Array(2048), {
          headers: { "content-type": "image/png" },
        });
      return new Response("Not found", { status: 404 });
    },
  });
});
afterAll(() => upstream.stop(true));

function proxy() {
  hits = [];
  script = SCRIPT;
  return createVscodeProxy({
    upstream: `http://127.0.0.1:${upstream.port}`,
    readText: async () =>
      '@font-face{font-family:"Thyra Mono";src:url("/assets/fonts/a.woff2")format("woff2");font-style:normal;font-weight:400;unicode-range:U+20-58;}',
  });
}

function get(
  target: ReturnType<typeof proxy>,
  pathname: string,
  headers: Record<string, string> = {},
) {
  const url = new URL(pathname, "https://thyra.test");
  return target.fetchHttp(
    new Request(url, {
      headers: { "accept-encoding": "gzip, br", ...headers },
    }),
    url,
  );
}

describe("VS Code static files", () => {
  test("are compressed once and then answered from the proxy", async () => {
    const target = proxy();
    const first = await get(target, `${STATIC}/out/workbench.js`);
    expect(first.headers.get("content-encoding")).toBe("br");
    expect(first.headers.get("cache-control")).toContain("immutable");
    expect(first.headers.get("vary")).toBe("Accept-Encoding");
    expect(first.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const body = new Uint8Array(await first.arrayBuffer());
    expect(body.length).toBeLessThan(SCRIPT.length / 4);
    expect(brotliDecompressSync(body).toString()).toBe(SCRIPT);

    const etag = first.headers.get("etag")!;
    const again = await get(target, `${STATIC}/out/workbench.js`, {
      "if-none-match": etag,
    });
    expect(again.status).toBe(304);
    expect(hits).toHaveLength(1);
  });

  test("share one upstream request between concurrent readers", async () => {
    const target = proxy();
    const responses = await Promise.all(
      [1, 2, 3].map(() => get(target, `${STATIC}/out/workbench.js`)),
    );
    for (const response of responses)
      expect(brotliDecompressSync(await response.bytes()).toString()).toBe(
        SCRIPT,
      );
    expect(hits).toHaveLength(1);
  });

  test("are fetched again by a reload that bypasses the cache", async () => {
    const target = proxy();
    await (await get(target, `${STATIC}/out/workbench.js`)).bytes();
    script = `${SCRIPT}// rebuilt`;
    const reloaded = await get(target, `${STATIC}/out/workbench.js`, {
      "cache-control": "no-cache",
    });
    expect(brotliDecompressSync(await reloaded.bytes()).toString()).toBe(
      script,
    );
    expect(hits).toHaveLength(2);
  });

  test("pass through when they are binary, ranged or missing", async () => {
    const target = proxy();
    const icon = await get(target, `${STATIC}/icon.png`);
    expect(icon.headers.get("content-encoding")).toBeNull();
    expect(icon.headers.get("cache-control")).toContain("immutable");
    expect((await icon.bytes()).length).toBe(2048);

    const ranged = await get(target, `${STATIC}/out/workbench.js`, {
      range: "bytes=0-9",
    });
    expect(ranged.headers.get("content-encoding")).toBeNull();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const missing = await get(target, `${STATIC}/out/missing.js`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("cache-control")).toBeNull();
      expect(await missing.text()).toBe("Not found");
    }
  });

  test("leave the cache when it outgrows its budget", async () => {
    const cache = createVscodeStaticCache({
      maxBytes: 3000,
      load: async () =>
        new Response(crypto.getRandomValues(new Uint8Array(2000))),
    });
    for (const name of ["a", "b"]) {
      const url = new URL(`https://thyra.test${STATIC}/${name}.js`);
      const request = new Request(url, {
        headers: { "accept-encoding": "br" },
      });
      await (await cache.respond(request, url))?.bytes();
    }
    expect(cache.size()).toBeGreaterThan(0);
    expect(cache.size()).toBeLessThanOrEqual(3000);
  });
});

describe("the workbench page", () => {
  test("loads Thyra's font and takes it as the default editor font", async () => {
    const response = await get(proxy(), "/vscode/?folder=/srv/app");
    const html = await response.text();
    expect(html).toContain(
      '<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/fonts/a.woff2" />',
    );
    expect(html).toMatch(
      /<link rel="stylesheet" href="\/assets\/fonts\/[^"]+fonts-core-[^"]+\.css" \/>/,
    );
    const raw = html.match(/data-settings="([^"]*)"/)![1]!;
    const configuration = JSON.parse(
      raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
    );
    expect(configuration).toEqual({
      remoteAuthority: "thyra.test",
      configurationDefaults: { "editor.fontFamily": EDITOR_FONT_FAMILY },
    });
  });

  test("keeps configuration it cannot read, and other pages, as they are", () => {
    const broken = page({}).replace("{}", "{");
    expect(withThyraFonts(broken)).toBe(broken);
    expect(withThyraFonts("<html><head></head></html>")).toBe(
      "<html><head></head></html>",
    );
  });

  test("round-trips markup characters in settings", () => {
    const html = withThyraFonts(
      page({ a: "<b>&\"'" }).replace("&quot;&lt;", "&quot;<"),
    );
    const raw = html.match(/data-settings="([^"]*)"/)![1]!;
    expect(raw).not.toMatch(/[<>]/);
    expect(
      JSON.parse(
        raw
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&"),
      ).a,
    ).toBe("<b>&\"'");
  });

  test("preloads only the regular chunks that cover ASCII", () => {
    const face = (weight: number, style: string, range: string, name: string) =>
      `@font-face{font-family:"Thyra Mono";src:url("/f/${name}.woff2")format("woff2");font-style:${style};font-display:swap;font-weight:${weight};unicode-range:${range};}`;
    expect(
      asciiFontChunks(
        face(400, "normal", "U+0,U+D,U+20-58,U+5B", "a") +
          face(400, "normal", "U+59-5A,U+5C", "b") +
          face(400, "normal", "U+A0-AC", "latin1") +
          face(700, "normal", "U+20-58", "bold") +
          face(400, "italic", "U+20-58", "italic"),
      ),
    ).toEqual(["/f/a.woff2", "/f/b.woff2"]);
  });
});
