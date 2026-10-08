import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { shQuote } from "../utils/process-utils";
import {
  type HostTool,
  type HostToolInfo,
  type RunHostScript,
  createHostToolProbe,
  runHostScript,
} from "./file-host";

/** Square bounding boxes a thumbnail may be requested at (CSS px x DPR). */
export const THUMBNAIL_SIZES = [64, 128, 256] as const;
export type ThumbnailKind = "raster" | "image" | "video" | "pdf";

// Bun.Image decodes these in the bridge itself, so a raster thumbnail needs no
// host tool; HEIC, AVIF and TIFF need vips, ImageMagick or ffmpeg on the host.
const RASTER = new Set(["png", "jpg", "jpeg", "jfif", "webp", "gif", "bmp"]);
const IMAGE = new Set(["heic", "heif", "avif", "tif", "tiff"]);
const VIDEO = new Set(["mp4", "m4v", "mov", "webm", "mkv", "avi", "ogv"]);

export function thumbnailKind(path: string): ThumbnailKind | null {
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (RASTER.has(extension)) return "raster";
  if (IMAGE.has(extension)) return "image";
  if (VIDEO.has(extension)) return "video";
  return extension === "pdf" ? "pdf" : null;
}

export function snapThumbnailSize(value: unknown) {
  const requested = Number(value) || 128;
  return THUMBNAIL_SIZES.find((size) => size >= requested) ?? 256;
}

// Decompression bombs: refuse sources whose header claims more pixels.
const MAX_SOURCE_PIXELS = 12000 * 12000;
// Raster files up to this size cross the SSH link as-is and are resized here;
// larger ones need a host tool so only a small PNG travels.
const REMOTE_RAW_MAX_BYTES = 4 * 1024 * 1024;
const LOCAL_SOURCE_MAX_BYTES = 128 * 1024 * 1024;
const BATCH_SIZE = 12;
const BATCH_DELAY_MS = 25;
const BATCH_TIMEOUT_MS = 30000;
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

export function defaultThumbnailCacheDir(env = process.env) {
  if (env.THYRA_THUMBNAIL_CACHE_DIR !== undefined) {
    return env.THYRA_THUMBNAIL_CACHE_DIR.trim() || null;
  }
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, "thyra", "thumbnails");
  }
  return join(
    env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "thyra",
    "thumbnails",
  );
}

/** Which host tool turns a file of `kind` into a PNG frame, if any. */
export function thumbnailTool(
  kind: ThumbnailKind,
  tools: ReadonlySet<HostTool>,
): HostTool | null {
  const order: HostTool[] =
    kind === "video"
      ? ["ffmpegthumbnailer", "ffmpeg"]
      : kind === "pdf"
        ? ["pdftoppm", "vipsthumbnail", "magick"]
        : ["vipsthumbnail", "magick", "convert", "ffmpeg"];
  return order.find((tool) => tools.has(tool)) ?? null;
}

type SourceRequest = {
  path: string;
  kind: ThumbnailKind;
  size: number;
  /** Ship the original bytes (a small raster file) instead of running a tool. */
  raw: boolean;
  tool: HostTool | null;
};

/**
 * One host script that emits a PNG frame (or the raw bytes of a small raster
 * file) for each request: `T\t<index>\t<base64>` or `E\t<index>`.
 */
export function thumbnailSourceScript(requests: SourceRequest[], px = 256) {
  const lines = requests.map((request, index) => {
    const file = shQuote(request.path);
    const command = request.raw
      ? `head -c ${REMOTE_RAW_MAX_BYTES + 1} -- ${file}`
      : request.tool === "ffmpegthumbnailer"
        ? `ffmpegthumbnailer -i ${file} -o - -s ${px} -c png -q 6`
        : request.tool === "ffmpeg"
          ? request.kind === "video"
            ? `{ ffmpeg -v error -ss 1 -i ${file} -frames:v 1 -vf "scale=${px}:${px}:force_original_aspect_ratio=decrease" -f image2pipe -c:v png - || ffmpeg -v error -i ${file} -frames:v 1 -vf "scale=${px}:${px}:force_original_aspect_ratio=decrease" -f image2pipe -c:v png -; }`
            : `ffmpeg -v error -i ${file} -frames:v 1 -vf "scale=${px}:${px}:force_original_aspect_ratio=decrease" -f image2pipe -c:v png -`
          : request.tool === "pdftoppm"
            ? `pdftoppm -png -singlefile -scale-to ${px} -f 1 -l 1 -- ${file}`
            : request.tool === "vipsthumbnail"
              ? `vipsthumbnail ${shQuote(`${request.path}[0]`)} -s ${px} -o "$tmp/out.png" >/dev/null && cat "$tmp/out.png"`
              : request.tool === "magick" || request.tool === "convert"
                ? `${request.tool} ${shQuote(`${request.path}[0]`)} -thumbnail ${px}x${px} png:-`
                : "false";
    return `emit ${index} ${shQuote(command)}`;
  });
  return `set -u
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
emit() {
  if (eval "$2") > "$tmp/frame" 2>/dev/null && [ -s "$tmp/frame" ]; then
    printf 'T\\t%s\\t' "$1"; base64 < "$tmp/frame" | tr -d '\\n'; printf '\\n'
  else
    printf 'E\\t%s\\n' "$1"
  fi
}
${lines.join("\n")}
`;
}

export function parseThumbnailSources(stdout: string, count: number) {
  const results: Array<Buffer | null> = Array.from(
    { length: count },
    () => null,
  );
  for (const line of stdout.split("\n")) {
    const [kind, index, data] = line.split("\t");
    const at = Number(index);
    if (kind === "T" && Number.isInteger(at) && at >= 0 && at < count) {
      results[at] = Buffer.from(data ?? "", "base64");
    }
  }
  return results;
}

async function encodeThumbnail(
  source: string | Uint8Array,
  size: number,
): Promise<Uint8Array> {
  return new Bun.Image(source, { maxPixels: MAX_SOURCE_PIXELS })
    .resize(size, size, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 72 })
    .bytes();
}

export type ThumbnailRequest = {
  host: string | undefined;
  path: string;
  /** Listing metadata the browser already has; part of the cache key. */
  mtimeMs: number;
  bytes: number;
  size: number;
};

/**
 * Small WebP thumbnails for image, video and PDF rows, cached on disk by host,
 * path, modification time, size and box. Raster images decode in the bridge;
 * other kinds (and large remote rasters) use a host tool when one exists.
 * Requests to one SSH host are batched into a single session.
 */
export function createThumbnailService({
  cacheDir = defaultThumbnailCacheDir(),
  run = runHostScript,
  probe = createHostToolProbe(run),
}: {
  cacheDir?: string | null;
  run?: RunHostScript;
  probe?: (host: string | undefined) => Promise<HostToolInfo>;
} = {}) {
  const negative = new Map<string, number>();
  const inflight = new Map<string, Promise<Uint8Array | null>>();
  const batches = new Map<
    string,
    {
      requests: SourceRequest[];
      waiters: Array<(value: Buffer | null) => void>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let writes = 0;

  const cacheKey = (request: ThumbnailRequest) =>
    createHash("sha256")
      .update(
        [
          request.host ?? "",
          request.path,
          Math.round(request.mtimeMs),
          request.bytes,
          request.size,
        ].join("\0"),
      )
      .digest("hex");
  const cachePath = (key: string) =>
    cacheDir ? join(cacheDir, key.slice(0, 2), `${key}.webp`) : null;

  async function prune() {
    if (!cacheDir) return;
    const files: Array<{ path: string; at: number; size: number }> = [];
    for (const shard of await readdir(cacheDir).catch(() => [])) {
      const directory = join(cacheDir, shard);
      for (const name of await readdir(directory).catch(() => [])) {
        const path = join(directory, name);
        const info = await stat(path).catch(() => null);
        if (info?.isFile())
          files.push({ path, at: info.mtimeMs, size: info.size });
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    files.sort((a, b) => a.at - b.at);
    for (const file of files) {
      if (total <= CACHE_MAX_BYTES * 0.75) break;
      await rm(file.path, { force: true });
      total -= file.size;
    }
  }

  async function store(key: string, bytes: Uint8Array) {
    const path = cachePath(key);
    if (!path) return;
    try {
      await mkdir(join(path, ".."), { recursive: true });
      const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, path);
      writes += 1;
      if (writes % 64 === 0) void prune().catch(() => {});
    } catch {
      // The cache is an optimization; a read-only cache dir still serves.
    }
  }

  function flush(host: string) {
    const batch = batches.get(host);
    if (!batch) return;
    batches.delete(host);
    clearTimeout(batch.timer);
    run(host, thumbnailSourceScript(batch.requests), {
      timeoutMs: BATCH_TIMEOUT_MS,
    })
      .then((result) =>
        parseThumbnailSources(result.stdout, batch.requests.length),
      )
      .catch(() => batch.requests.map(() => null))
      .then((sources) => {
        batch.waiters.forEach((resolve, index) =>
          resolve(sources[index] ?? null),
        );
      });
  }

  function hostSource(host: string | undefined, request: SourceRequest) {
    if (!host) {
      return run(undefined, thumbnailSourceScript([request]), {
        timeoutMs: BATCH_TIMEOUT_MS,
      })
        .then((result) => parseThumbnailSources(result.stdout, 1)[0] ?? null)
        .catch(() => null);
    }
    return new Promise<Buffer | null>((resolve) => {
      let batch = batches.get(host);
      if (!batch) {
        batch = {
          requests: [],
          waiters: [],
          timer: setTimeout(() => flush(host), BATCH_DELAY_MS),
        };
        batches.set(host, batch);
      }
      batch.requests.push(request);
      batch.waiters.push(resolve);
      if (batch.requests.length >= BATCH_SIZE) flush(host);
    });
  }

  async function generate(request: ThumbnailRequest) {
    const kind = thumbnailKind(request.path);
    if (!kind) return null;
    if (kind === "raster" && !request.host) {
      const info = await stat(request.path).catch(() => null);
      if (!info?.isFile() || info.size > LOCAL_SOURCE_MAX_BYTES) return null;
      return encodeThumbnail(request.path, request.size);
    }
    const raw = kind === "raster" && request.bytes <= REMOTE_RAW_MAX_BYTES;
    const tool = raw
      ? null
      : thumbnailTool(kind, (await probe(request.host)).tools);
    if (!raw && !tool) return null;
    const source = await hostSource(request.host, {
      path: request.path,
      kind,
      size: request.size,
      raw,
      tool,
    });
    if (!source || (raw && source.length > REMOTE_RAW_MAX_BYTES)) return null;
    return encodeThumbnail(source, request.size);
  }

  /** The thumbnail bytes, or null when the file has none (no tool, error). */
  async function thumbnail(request: ThumbnailRequest) {
    const key = cacheKey(request);
    const path = cachePath(key);
    if (path) {
      const cached = Bun.file(path);
      if (await cached.exists())
        return new Uint8Array(await cached.arrayBuffer());
    }
    const failedAt = negative.get(key);
    if (failedAt && Date.now() - failedAt < NEGATIVE_TTL_MS) return null;
    let pending = inflight.get(key);
    if (!pending) {
      pending = generate(request)
        .catch(() => null)
        .then(async (bytes) => {
          if (bytes) await store(key, bytes);
          else {
            if (negative.size > 4096) negative.clear();
            negative.set(key, Date.now());
          }
          return bytes;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  }

  return { thumbnail, prune };
}

export type ThumbnailService = ReturnType<typeof createThumbnailService>;

let sharedService: ThumbnailService | null = null;

/** One bridge-wide service: every connection shares the disk cache. */
export function sharedThumbnailService() {
  sharedService ??= createThumbnailService();
  return sharedService;
}
