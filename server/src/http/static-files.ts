import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import {
  archiveBuild,
  archivedAssetPath,
  parseBuildManifest,
} from "./asset-archive";
import { HTML_SECURITY_HEADERS } from "./security-headers";
import {
  decodeStaticPathname,
  isStaticRequestMethod,
  resolvePublicFilePath,
  shouldServeSpaEntry,
} from "./static-paths";

// --asset ./public preserves this directory under import.meta.dir in binaries.
const builtPublicDir = Bun.isStandaloneExecutable
  ? join(import.meta.dir, "public")
  : join(import.meta.dir, "../../public");

/** Build-time list of fingerprinted assets; the service worker prunes by it. */
export const ASSET_MANIFEST_PATH = "/thyra-assets.json";
export const SERVICE_WORKER_PATH = "/task-notifications-sw.js";

/** Fingerprinted files: cacheable by browsers and CDNs for a year. */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** Everything else revalidates; a matching ETag costs one small 304. */
export const REVALIDATE_CACHE_CONTROL = "no-cache, must-revalidate";
/** The application shell, served only after login. */
const SHELL_PATHS = new Set([
  "/index.html",
  SERVICE_WORKER_PATH,
  ASSET_MANIFEST_PATH,
]);

let assetArchiveDir: string | null = null;

/** Answer `/assets/` misses from this archive of recent builds (null: off). */
export function setAssetArchiveDir(directory: string | null): void {
  assetArchiveDir = directory;
}

function notFound(): Response {
  // A CDN or browser must not remember a miss: the file may be a chunk of a
  // build that has not been archived yet.
  return new Response("not found", {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}

export async function serveStatic(
  req: Request,
  publicDir: string,
): Promise<Response> {
  if (!isStaticRequestMethod(req.method)) {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  let pathname: string | null;
  try {
    pathname = decodeStaticPathname(new URL(req.url).pathname);
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!pathname) return new Response("bad request", { status: 400 });

  // A missing fingerprinted file is a 404, never the SPA entry.
  const serveEntry =
    pathname === "/index.html" ||
    (!pathname.startsWith("/assets/") &&
      shouldServeSpaEntry(req.method, req.headers.get("accept")));

  for (const directory of [publicDir, builtPublicDir]) {
    const filePath = resolvePublicFilePath(directory, pathname);
    if (!filePath) return notFound();
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return fileResponse(req, file, filePath, pathname);
    }
    if (serveEntry) {
      const indexPath = join(directory, "index.html");
      const index = Bun.file(indexPath);
      if (await index.exists()) {
        return fileResponse(req, index, indexPath, "/index.html");
      }
    }
  }
  // A page started from an earlier build can still lazy-load its chunks.
  const archived = assetArchiveDir
    ? archivedAssetPath(assetArchiveDir, pathname)
    : null;
  if (archived) {
    const file = Bun.file(archived);
    if (await file.exists()) return fileResponse(req, file, archived, pathname);
  }

  return notFound();
}

/**
 * Copy the running build's fingerprinted files into the asset archive and
 * drop builds beyond the newest few (see `asset-archive.ts`).
 */
export async function archiveRunningBuild(
  publicDir: string,
  archiveDir: string,
): Promise<{ copied: number; removed: number } | null> {
  for (const directory of [publicDir, builtPublicDir]) {
    const manifestFile = Bun.file(join(directory, ASSET_MANIFEST_PATH));
    if (!(await manifestFile.exists())) continue;
    const manifest = parseBuildManifest(
      await manifestFile.json().catch(() => null),
    );
    if (!manifest) return null;
    return archiveBuild({
      archiveDir,
      manifest,
      source: (pathname) => {
        const filePath = resolvePublicFilePath(directory, pathname);
        return filePath ? Bun.file(filePath) : null;
      },
    });
  }
  return null;
}

/** The module script an entry document starts, e.g. `/assets/index-abc.js`. */
export function entryScriptPath(html: string): string | null {
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\btype="module"/i.test(tag)) continue;
    const src = tag.match(/\bsrc="(\/assets\/[^"?#]+)"/i)?.[1];
    if (src) return src;
  }
  return null;
}

/** Text of a built frontend file (on-disk directory first), or null. */
export async function readStaticText(
  publicDir: string,
  pathname: string,
): Promise<string | null> {
  for (const directory of [publicDir, builtPublicDir]) {
    const filePath = resolvePublicFilePath(directory, pathname);
    if (!filePath) return null;
    const file = Bun.file(filePath);
    if (await file.exists()) return file.text();
  }
  return null;
}

// Text assets are sent compressed; on a slow phone link every byte of the
// entry chunk counts. Brotli at maximum quality costs about a second of CPU per
// large chunk, so it runs off the event loop, once per file version, and the
// boot-critical files are compressed ahead of the first request.
const COMPRESSIBLE = /\.(?:js|mjs|css|html|json|map|svg|wasm|txt|ttf)$/;
const MIN_COMPRESS_BYTES = 1024;
const BROTLI_WINDOW_BITS = 24;
type Encoding = "br" | "gzip";
const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

interface FileVersion {
  version: string;
  etag: Promise<string>;
  encoded: Partial<Record<Encoding, Promise<Uint8Array>>>;
}
const fileVersions = new Map<string, FileVersion>();

/**
 * Pick a content coding from Accept-Encoding, honouring `q=0` refusals.
 * Brotli wins over gzip whenever both are acceptable: it is 10-15% smaller
 * for this bundle and every supported browser decodes it.
 */
export function negotiateEncoding(header: string | null): Encoding | null {
  if (!header) return null;
  const quality = new Map<string, number>();
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key?.trim().toLowerCase() === "q") q = Number(value);
    }
    quality.set(name, Number.isFinite(q) ? q : 0);
  }
  const accepted = (name: Encoding) => {
    const q = quality.get(name) ?? quality.get("*");
    return q !== undefined && q > 0;
  };
  if (accepted("br")) return "br";
  if (accepted("gzip")) return "gzip";
  return null;
}

/** Whether If-None-Match lists this entity tag (weak comparison, RFC 9110). */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return header
    .split(",")
    .some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
}

function versionFor(
  file: ReturnType<typeof Bun.file>,
  filePath: string,
): FileVersion {
  const version = `${file.size}:${file.lastModified}`;
  let entry = fileVersions.get(filePath);
  if (entry?.version !== version) {
    const bytes = file.bytes();
    entry = {
      version,
      etag: bytes.then(
        (raw) => `"${Bun.hash(raw).toString(36)}-${raw.length.toString(36)}"`,
      ),
      encoded: {},
    };
    // A failed read must not poison the cache for the next request.
    entry.etag.catch(() => fileVersions.delete(filePath));
    fileVersions.set(filePath, entry);
  }
  return entry;
}

function encodedBody(
  entry: FileVersion,
  file: ReturnType<typeof Bun.file>,
  filePath: string,
  encoding: Encoding,
): Promise<Uint8Array> {
  let body = entry.encoded[encoding];
  if (!body) {
    body = file.bytes().then(async (raw) =>
      encoding === "br"
        ? new Uint8Array(
            await brotliAsync(raw, {
              params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]:
                  zlibConstants.BROTLI_MAX_QUALITY,
                [zlibConstants.BROTLI_PARAM_LGWIN]: BROTLI_WINDOW_BITS,
                [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
              },
            }),
          )
        : new Uint8Array(await gzipAsync(raw, { level: 9 })),
    );
    body.catch(() => {
      if (fileVersions.get(filePath) === entry) delete entry.encoded[encoding];
    });
    entry.encoded[encoding] = body;
  }
  return body;
}

function isCompressible(pathname: string, size: number): boolean {
  return COMPRESSIBLE.test(pathname) && size >= MIN_COMPRESS_BYTES;
}

async function fileResponse(
  req: Request,
  file: ReturnType<typeof Bun.file>,
  filePath: string,
  pathname: string,
): Promise<Response> {
  const headers = responseHeaders(pathname);
  const compressible = isCompressible(pathname, file.size);
  if (compressible) headers.vary = "Accept-Encoding";
  const encoding = compressible
    ? negotiateEncoding(req.headers.get("accept-encoding"))
    : null;
  const entry = versionFor(file, filePath);
  const baseTag = await entry.etag;
  // Each representation needs its own strong validator.
  const etag = encoding ? `${baseTag.slice(0, -1)}-${encoding}"` : baseTag;
  headers.etag = etag;
  if (etagMatches(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  if (!encoding) return new Response(file, { headers });
  const body = await encodedBody(entry, file, filePath, encoding);
  return new Response(req.method === "HEAD" ? null : (body as BodyInit), {
    headers: {
      ...headers,
      "content-encoding": encoding,
      "content-length": String(body.length),
    },
  });
}

/**
 * Compress the files a first visit needs (the entry document's assets plus the
 * build's boot list) in the background, so the first phone to connect after a
 * start or update does not wait for maximum-quality Brotli.
 */
export async function prewarmStaticCompression(
  publicDir: string,
): Promise<number> {
  const seen = new Set<string>();
  const pathnames: string[] = ["/index.html"];
  for (const directory of [publicDir, builtPublicDir]) {
    const index = Bun.file(join(directory, "index.html"));
    if (!(await index.exists())) continue;
    const html = await index.text();
    for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)) {
      pathnames.push(match[1]!);
    }
    const manifest = Bun.file(join(directory, ASSET_MANIFEST_PATH));
    if (await manifest.exists()) {
      const boot: unknown = (await manifest.json().catch(() => null))?.boot;
      if (Array.isArray(boot)) {
        pathnames.push(
          ...boot.filter((path): path is string => typeof path === "string"),
        );
      }
    }
    break;
  }
  let compressed = 0;
  for (const pathname of pathnames) {
    if (seen.has(pathname)) continue;
    seen.add(pathname);
    for (const directory of [publicDir, builtPublicDir]) {
      const filePath = resolvePublicFilePath(directory, pathname);
      if (!filePath) break;
      const file = Bun.file(filePath);
      if (!(await file.exists())) continue;
      if (isCompressible(pathname, file.size)) {
        const entry = versionFor(file, filePath);
        await encodedBody(entry, file, filePath, "br");
        compressed += 1;
      }
      break;
    }
  }
  return compressed;
}

function responseHeaders(pathname: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": contentType(pathname),
  };
  if (pathname.endsWith(".html")) Object.assign(headers, HTML_SECURITY_HEADERS);
  // Vite and the font slicer fingerprint everything under /assets, so a URL
  // never changes content: browsers and Cloudflare keep it for a year, and it
  // is the same for everyone (served without login or cookies). An update
  // replaces everything else in place (the entry document, the service
  // worker, the manifests and icons), so those always revalidate and a reload
  // cannot keep old asset URLs or an old worker. The shell files need a login,
  // so a CDN must not store them at all.
  headers["cache-control"] = pathname.startsWith("/assets/")
    ? IMMUTABLE_CACHE_CONTROL
    : SHELL_PATHS.has(pathname)
      ? `private, ${REVALIDATE_CACHE_CONTROL}`
      : REVALIDATE_CACHE_CONTROL;
  return headers;
}

function contentType(pathname: string): string {
  if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".json") || pathname.endsWith(".map")) {
    return "application/json; charset=utf-8";
  }
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".ico")) return "image/x-icon";
  if (pathname.endsWith(".woff2")) return "font/woff2";
  if (pathname.endsWith(".woff")) return "font/woff";
  if (pathname.endsWith(".ttf")) return "font/ttf";
  if (pathname.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}
