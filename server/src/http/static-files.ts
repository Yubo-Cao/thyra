import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
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

  const serveEntry =
    pathname === "/index.html" ||
    shouldServeSpaEntry(req.method, req.headers.get("accept"));

  for (const directory of [publicDir, builtPublicDir]) {
    const filePath = resolvePublicFilePath(directory, pathname);
    if (!filePath) return new Response("not found", { status: 404 });
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

  return new Response("not found", { status: 404 });
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
  if (pathname.startsWith("/assets/")) {
    // Vite fingerprints everything under /assets, so a URL never changes
    // content; repeat visits then load the app without touching the network.
    headers["cache-control"] = "private, max-age=31536000, immutable";
  } else if (
    pathname === "/index.html" ||
    pathname === SERVICE_WORKER_PATH ||
    pathname === ASSET_MANIFEST_PATH ||
    pathname === "/manifest.json"
  ) {
    // The updater replaces hashed assets and these files together. Always
    // revalidate (a matching ETag costs one small 304) so a reload cannot
    // retain old asset URLs or an old worker.
    headers["cache-control"] = "no-cache, must-revalidate";
  }
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
