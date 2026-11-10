import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import {
  etagMatches,
  isCompressible,
  negotiateEncoding,
} from "../http/static-files";

/**
 * VS Code's server sends its static files (`/vscode/<quality>-<commit>/static/`)
 * uncompressed and without validators: the workbench script alone is over
 * 20 MB on the wire. Their URLs carry the build's commit, so the proxy keeps a
 * compressed copy of each text file in memory and answers repeat requests
 * itself. A reload that bypasses the browser cache (`Cache-Control: no-cache`)
 * also refreshes the copy, for files rebuilt in place such as translations.
 */
const STATIC_PATH = /^\/vscode\/[\w.-]+-[0-9a-f]{40}\/static\//;
export const VSCODE_STATIC_CACHE_CONTROL =
  "public, max-age=31536000, immutable";
/** Larger files are proxied as they are. */
const MAX_RAW_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CACHE_BYTES = 96 * 1024 * 1024;
// Quality 9 takes under two seconds for the workbench script and lands within
// 15% of maximum quality, which would take twenty.
const BROTLI_QUALITY = 9;

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

type Encoding = "br" | "gzip";
type Entry = {
  body: Uint8Array;
  /** Null when the file was too small to be worth compressing. */
  encoding: Encoding | null;
  etag: string;
  contentType: string;
};
/** A cached file, or the upstream answer that could not be cached. */
type Loaded = Entry | Response;

export function isVscodeStaticPath(pathname: string) {
  return STATIC_PATH.test(pathname);
}

async function compress(raw: Uint8Array, encoding: Encoding) {
  return new Uint8Array(
    encoding === "br"
      ? await brotliAsync(raw, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
            [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        })
      : await gzipAsync(raw, { level: 6 }),
  );
}

export function createVscodeStaticCache(options: {
  /** Fetches the uncompressed file from VS Code. */
  load: (req: Request, url: URL) => Promise<Response>;
  maxBytes?: number;
}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CACHE_BYTES;
  // Insertion order is recency: a hit moves its key to the end.
  const entries = new Map<string, Promise<Loaded>>();
  const sizes = new Map<string, number>();
  let bytes = 0;
  const claimed = new WeakSet<Response>();

  const forget = (key: string) => {
    entries.delete(key);
    bytes -= sizes.get(key) ?? 0;
    sizes.delete(key);
  };

  async function load(
    req: Request,
    url: URL,
    encoding: Encoding,
  ): Promise<Loaded> {
    const response = await options.load(req, url);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (
      response.status !== 200 ||
      response.headers.has("content-encoding") ||
      length > MAX_RAW_BYTES
    )
      return response;
    const raw = await response.bytes();
    const compressible = isCompressible(url.pathname, raw.length);
    return {
      body: compressible ? await compress(raw, encoding) : raw,
      encoding: compressible ? encoding : null,
      etag: `"${Bun.hash(raw).toString(36)}-${raw.length.toString(36)}-${
        compressible ? encoding : "id"
      }"`,
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /** Null when this request is not one the cache answers. */
  async function respond(req: Request, url: URL): Promise<Response | null> {
    if (req.method !== "GET" || !isVscodeStaticPath(url.pathname)) return null;
    if (req.headers.has("range") || !isCompressible(url.pathname, Infinity))
      return null;
    const encoding = negotiateEncoding(req.headers.get("accept-encoding"));
    if (!encoding) return null;

    const key = `${encoding} ${url.pathname}${url.search}`;
    if (/\bno-cache\b/i.test(req.headers.get("cache-control") ?? ""))
      forget(key);
    let pending = entries.get(key);
    if (pending) {
      entries.delete(key);
      entries.set(key, pending);
    } else {
      pending = load(req, url, encoding);
      entries.set(key, pending);
      const stored = pending;
      stored.then(
        (loaded) => {
          if (entries.get(key) !== stored) return;
          if (loaded instanceof Response) return forget(key);
          sizes.set(key, loaded.body.length);
          bytes += loaded.body.length;
          for (const oldest of entries.keys()) {
            if (bytes <= maxBytes || oldest === key) break;
            forget(oldest);
          }
          if (bytes > maxBytes) forget(key);
        },
        () => {
          if (entries.get(key) === stored) forget(key);
        },
      );
    }

    const loaded = await pending;
    // Uncacheable answers have one body: only the request that loaded it
    // may use it, and later ones go to VS Code themselves.
    if (loaded instanceof Response) {
      if (claimed.has(loaded)) return null;
      claimed.add(loaded);
      return loaded;
    }
    const headers: Record<string, string> = {
      "content-type": loaded.contentType,
      "cache-control": VSCODE_STATIC_CACHE_CONTROL,
      vary: "Accept-Encoding",
      etag: loaded.etag,
    };
    if (etagMatches(req.headers.get("if-none-match"), loaded.etag))
      return new Response(null, { status: 304, headers });
    if (loaded.encoding) headers["content-encoding"] = loaded.encoding;
    headers["content-length"] = String(loaded.body.length);
    return new Response(loaded.body as BodyInit, { headers });
  }

  return { respond, size: () => bytes };
}
