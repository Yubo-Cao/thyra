import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { imageMimeForPath, isHtmlPath } from "../../../shared/filePreview";
import { sshCommandArgv } from "../bridge/ssh-command";
import { DOWNLOAD_TIMEOUT_MS } from "./file-constants";
import { assertInsideRoot } from "./file-paths";
import type { RunProcessWithCodeTimeout } from "./file-types";

const MIME_TYPES: Record<string, string> = {
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
};

const HTML_REPORT = `<script>
(() => {
  const report = () => parent.postMessage({
    type: 'thyra-file-preview',
    url: location.href,
    assets: performance.getEntriesByType('resource').slice(0, 64).map(entry => entry.name),
  }, '*');
  addEventListener('load', report);
  new PerformanceObserver(report).observe({type: 'resource', buffered: true});
})();
</script>`;

function fresh(request: Request, etag: string, mtime: number) {
  const candidate = request.headers.get("if-none-match");
  if (candidate !== null)
    return candidate.split(",").some((tag) => {
      const value = tag.trim().replace(/^W\//, "");
      return value === "*" || value === etag;
    });
  const date = Date.parse(request.headers.get("if-modified-since") ?? "");
  return Math.floor(mtime / 1000) * 1000 <= date;
}

function rangeFor(request: Request, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end = Math.min(
    size - 1,
    match[1] && match[2] ? Number(match[2]) : size - 1,
  );
  return { start, end };
}

export async function rawWorkspaceResponse({
  root,
  path,
  request,
  grant,
  host,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  root: string;
  path: string;
  request: Request;
  grant: boolean;
  host?: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}) {
  const html = isHtmlPath(path);
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const mime = html
    ? "text/html"
    : (imageMimeForPath(path) ??
      (Object.hasOwn(MIME_TYPES, ext) ? MIME_TYPES[ext] : "text/plain"));
  const head = request.method === "HEAD";
  let file: Blob | undefined;
  let mtime: number;
  let size: number;
  let etag: string;
  try {
    if (host) {
      // A metadata-only SSH response for unchanged assets and HEAD polling.
      const validators = (request.headers.get("if-none-match") ?? "")
        .split(",")
        .map((tag) => tag.trim().replace(/^W\//, ""))
        .join(",");
      const modifiedSince = Date.parse(
        request.headers.get("if-modified-since") ?? "",
      );
      const command = `
set -eu
root_real="$(cd ${shQuote(root)} && pwd -P)"
target="$(realpath "$root_real"/${shQuote(path)})"
case "$root_real" in /) ;; *) case "$target" in "$root_real"/*) ;; *) exit 13 ;; esac ;; esac
[ -f "$target" ] || exit 14
set -- $(stat -c '%s %Y' "$target" 2>/dev/null || stat -f '%z %m' "$target")
size="$1"; modified="$2"
version="$(stat -c '%i:%y:%z' "$target" 2>/dev/null || stat -f '%i:%m:%c' "$target")"
etag="\\"$(printf '%s' "$version:$size" | cksum | cut -d ' ' -f1)\\""
printf '%s %s %s\\n' "$size" "$modified" "$etag"
${head ? "exit 0" : ""}
case ${shQuote(`,${validators},`)} in *,"$etag",*) exit 0 ;; esac
${validators.split(",").includes("*") ? "exit 0" : ""}
${
  !request.headers.has("if-none-match") && Number.isFinite(modifiedSince)
    ? `[ "$modified" -gt ${Math.floor(modifiedSince / 1000)} ] || exit 0`
    : ""
}
base64 < "$target" | tr -d '\n'
`;
      const result = await runProcessWithCodeTimeout(
        sshCommandArgv(host, `sh -c ${shQuote(command)}`),
        DOWNLOAD_TIMEOUT_MS,
      );
      if (result.code !== 0) throw new Error("unreadable preview");
      const [metadata, data] = result.stdout.split("\n", 2);
      const [length, seconds, tag] = metadata.split(" ");
      size = Number(length);
      mtime = Number(seconds) * 1000;
      etag = tag;
      if (!Number.isFinite(size) || !Number.isFinite(mtime) || !etag)
        throw new Error("invalid preview metadata");
      if (!head && !fresh(request, etag, mtime))
        file = new Blob([Buffer.from(data ?? "", "base64")]);
    } else {
      const rootReal = await realpath(root);
      const target = await realpath(resolve(rootReal, path));
      assertInsideRoot(rootReal, target);
      const info = await stat(target);
      if (!info.isFile()) throw new Error("unreadable preview");
      size = info.size;
      mtime = info.mtimeMs;
      etag = `"${info.ino}-${size}-${mtime}-${info.ctimeMs}"`;
      file = Bun.file(target);
    }
  } catch {
    return new Response("File unavailable", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }

  const headers = new Headers({
    "content-type": mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime,
    "cache-control": "private, no-cache",
    "last-modified": new Date(mtime).toUTCString(),
    etag,
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "no-referrer",
  });
  if (grant) {
    headers.set("access-control-allow-origin", "*");
    headers.set("cross-origin-resource-policy", "cross-origin");
  }
  if (html || mime === "image/svg+xml") {
    headers.set(
      "content-security-policy",
      html
        ? "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock; frame-ancestors 'self'"
        : "sandbox; frame-ancestors 'self'; default-src 'none'; style-src 'unsafe-inline'",
    );
  }
  if (fresh(request, etag, mtime))
    return new Response(null, { status: 304, headers });
  if (html) {
    const response = new Response(head ? null : file, { headers });
    return grant && !head
      ? new HTMLRewriter()
          .onDocument({
            end(end) {
              end.append(HTML_REPORT, { html: true });
            },
          })
          .transform(response)
      : response;
  }

  headers.set("accept-ranges", "bytes");
  const ifRange = request.headers.get("if-range");
  const range =
    !ifRange || ifRange === etag || ifRange === headers.get("last-modified")
      ? rangeFor(request, size)
      : null;
  if (range) {
    const { start, end } = range;
    if (end < start || start >= size) {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(head ? null : file?.slice(start, end + 1), {
      status: 206,
      headers,
    });
  }
  headers.set("content-length", String(size));
  return new Response(head ? null : file, { headers });
}
