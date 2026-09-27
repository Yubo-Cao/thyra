import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  etagMatches,
  negotiateEncoding,
  prewarmStaticCompression,
  serveStatic,
} from "./static-files";

const web = resolve(import.meta.dir, "../../../web");

test("the app links a credentialed standalone manifest with existing install icons", async () => {
  const html = await Bun.file(resolve(web, "index.html")).text();
  const link = html.match(/<link\b[^>]*\brel="manifest"[^>]*>/)?.[0];
  expect(link).toContain('href="/manifest.json"');
  expect(link).toContain('crossorigin="use-credentials"');
  const response = await serveStatic(
    new Request("https://thyra.example/manifest.json"),
    resolve(web, "public"),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    id: "/",
    name: "Thyra",
    short_name: "Thyra",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  expect(
    manifest.icons.map(
      (icon: { sizes: string; purpose?: string }) =>
        `${icon.sizes}:${icon.purpose ?? "any"}`,
    ),
  ).toEqual(["any:any", "192x192:any", "512x512:any", "512x512:maskable"]);
  for (const icon of manifest.icons) {
    const bytes = Buffer.from(
      await Bun.file(resolve(web, "public", icon.src.slice(1))).arrayBuffer(),
    );
    if (icon.type === "image/svg+xml") {
      expect(bytes.toString("utf8")).toStartWith("<svg");
      continue;
    }
    expect(icon.type).toBe("image/png");
    expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(
      icon.sizes,
    );
  }
});

test("source runs fall back to the built public directory", async () => {
  const response = await serveStatic(
    new Request("https://thyra.example/manifest.json"),
    "/nonexistent-thyra-static-test",
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual(
    await Bun.file(resolve(web, "public/manifest.json")).json(),
  );
});

test("text assets are compressed and fingerprinted assets are immutable", async () => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/thyra-static-${process.pid}`;
  const script = `console.log(${JSON.stringify("x".repeat(4096))});\n`;
  await Bun.write(`${dir}/assets/app-abc123.js`, script);
  const response = await serveStatic(
    new Request("https://thyra.example/assets/app-abc123.js", {
      headers: { "accept-encoding": "gzip, deflate, br" },
    }),
    dir,
  );
  expect(response.headers.get("content-encoding")).toBe("br");
  expect(response.headers.get("vary")).toBe("Accept-Encoding");
  expect(response.headers.get("cache-control")).toContain("immutable");
  const body = new Uint8Array(await response.arrayBuffer());
  expect(body.length).toBeLessThan(script.length / 4);
  const { brotliDecompressSync } = await import("node:zlib");
  expect(brotliDecompressSync(body).toString("utf8")).toBe(script);

  const plain = await serveStatic(
    new Request("https://thyra.example/assets/app-abc123.js"),
    dir,
  );
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(await plain.text()).toBe(script);
});

test("content coding negotiation prefers Brotli and honours refusals", () => {
  expect(negotiateEncoding("gzip, deflate, br, zstd")).toBe("br");
  expect(negotiateEncoding("gzip, br;q=0")).toBe("gzip");
  expect(negotiateEncoding("BR;q=0.5, gzip;q=1")).toBe("br");
  expect(negotiateEncoding("identity")).toBeNull();
  expect(negotiateEncoding("*;q=0")).toBeNull();
  expect(negotiateEncoding("*")).toBe("br");
  expect(negotiateEncoding("brotli, xgzip")).toBeNull();
  expect(negotiateEncoding(null)).toBeNull();
});

test("If-None-Match uses weak comparison and accepts lists and wildcards", () => {
  expect(etagMatches('"a-br"', '"a-br"')).toBe(true);
  expect(etagMatches('W/"a-br"', '"a-br"')).toBe(true);
  expect(etagMatches('"x", "a-br"', '"a-br"')).toBe(true);
  expect(etagMatches("*", '"a-br"')).toBe(true);
  expect(etagMatches('"a"', '"a-br"')).toBe(false);
  expect(etagMatches(null, '"a"')).toBe(false);
});

test("the entry document revalidates with a per-coding ETag and a 304", async () => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/thyra-static-etag-${process.pid}`;
  const page = `<!doctype html><title>${"x".repeat(2048)}</title>`;
  await Bun.write(`${dir}/index.html`, page);
  await Bun.write(`${dir}/task-notifications-sw.js`, "self;".repeat(400));
  const get = (path: string, headers: Record<string, string> = {}) =>
    serveStatic(new Request(`https://thyra.example${path}`, { headers }), dir);

  const br = await get("/", { "accept-encoding": "br" });
  const gz = await get("/", { "accept-encoding": "gzip" });
  const plain = await get("/");
  expect(br.headers.get("cache-control")).toBe("no-cache, must-revalidate");
  expect(br.headers.get("vary")).toBe("Accept-Encoding");
  expect(plain.headers.get("vary")).toBe("Accept-Encoding");
  const tags = [br, gz, plain].map((response) => response.headers.get("etag"));
  expect(new Set(tags).size).toBe(3);
  expect(await plain.text()).toBe(page);

  const revalidated = await get("/", {
    "accept-encoding": "br",
    "if-none-match": tags[0]!,
  });
  expect(revalidated.status).toBe(304);
  expect(revalidated.headers.get("etag")).toBe(tags[0]);
  expect(await revalidated.text()).toBe("");
  // A validator for another coding must not produce a 304.
  const mismatched = await get("/", {
    "accept-encoding": "br",
    "if-none-match": tags[1]!,
  });
  expect(mismatched.status).toBe(200);

  await Bun.write(`${dir}/index.html`, `${page}<!-- updated -->`);
  const updated = await get("/", {
    "accept-encoding": "br",
    "if-none-match": tags[0]!,
  });
  expect(updated.status).toBe(200);
  expect(updated.headers.get("etag")).not.toBe(tags[0]);

  const worker = await get("/task-notifications-sw.js");
  expect(worker.headers.get("cache-control")).toBe("no-cache, must-revalidate");
});

test("prewarming compresses the entry document's assets and the boot list", async () => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/thyra-static-warm-${process.pid}`;
  const chunk = `console.log(${JSON.stringify("y".repeat(4096))});`;
  await Bun.write(
    `${dir}/index.html`,
    `<!doctype html>${"<!-- pad -->".repeat(100)}<script type="module" src="/assets/entry-a.js"></script><link rel="stylesheet" href="/assets/entry-a.css">`,
  );
  await Bun.write(`${dir}/assets/entry-a.js`, chunk);
  await Bun.write(`${dir}/assets/entry-a.css`, "a{color:red}");
  await Bun.write(`${dir}/assets/terminal-b.js`, chunk);
  await Bun.write(`${dir}/assets/lazy-c.js`, chunk);
  await Bun.write(
    `${dir}/thyra-assets.json`,
    JSON.stringify({
      version: "v",
      boot: ["/assets/terminal-b.js", "/assets/missing.js", "/../escape.js"],
      assets: [],
    }),
  );
  // index.html, entry-a.js and terminal-b.js; the CSS is below the threshold.
  expect(await prewarmStaticCompression(dir)).toBe(3);
});
