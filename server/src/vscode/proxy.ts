import { TERMINAL_FONT_CORE_STYLESHEET } from "../../../shared/terminalFontStylesheet";
import { thyraEnv } from "../config/environment";
import {
  createVscodeStaticCache,
  isVscodeStaticPath,
  VSCODE_STATIC_CACHE_CONTROL,
} from "./static-cache";
import { asciiFontChunks, withThyraFonts } from "./workbench-html";
import {
  isHookedWorkbenchScript,
  withHookedWorkbenchScript,
  withWorkbenchHook,
} from "./workbench-script";

/**
 * The Inspector's editor: a VS Code Web server (`code serve-web
 * --server-base-path /vscode`) on loopback, reached through this origin at
 * `/vscode/` so it shares Thyra's session and listeners. It is a shell as the
 * host user, so only instance admins reach it (`vscode` in HTTP_POLICY).
 */
export const VSCODE_BASE_PATH = "/vscode";

export function vscodeConfig(env = process.env) {
  const upstream = thyraEnv("VSCODE_URL", env)?.replace(/\/+$/, "");
  return { upstream: upstream || null };
}

export function isVscodePath(pathname: string) {
  return (
    pathname === VSCODE_BASE_PATH || pathname.startsWith(`${VSCODE_BASE_PATH}/`)
  );
}

/** The few WebSocket methods the bridge uses. */
export type VscodePeer = {
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
};

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
];

/** Request cookies minus Thyra's own, which the editor has no use for. */
function upstreamCookies(cookie: string | null) {
  if (!cookie) return null;
  const kept = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/^(__Host-)?thyra[_-]/i.test(part));
  return kept.length ? kept.join("; ") : null;
}

function upstreamHeaders(req: Request) {
  const headers = new Headers(req.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  // The workbench names its remote by the Host it was served under.
  const host = new URL(req.url).host;
  headers.set("host", req.headers.get("host") || host);
  for (const name of [...headers.keys()])
    if (name.startsWith("sec-websocket-")) headers.delete(name);
  const cookie = upstreamCookies(req.headers.get("cookie"));
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");
  return headers;
}

/** Asks VS Code for the whole, uncompressed file. */
function identityHeaders(req: Request) {
  const headers = upstreamHeaders(req);
  headers.set("accept-encoding", "identity");
  for (const name of ["if-none-match", "if-modified-since", "range"])
    headers.delete(name);
  return headers;
}

export function createVscodeProxy(options: {
  upstream: string | null;
  /** Text of one of Thyra's own static files, for the font preloads. */
  readText?: (pathname: string) => Promise<string | null>;
}) {
  const { upstream } = options;
  const target = (url: URL) => `${upstream}${url.pathname}${url.search}`;
  /** A static file as VS Code has it; the workbench script gets its hook. */
  const loadStatic = async (req: Request, url: URL) => {
    const response = await fetch(target(url), {
      headers: identityHeaders(req),
      redirect: "manual",
      decompress: false,
    } as RequestInit);
    if (
      response.status !== 200 ||
      response.headers.has("content-encoding") ||
      !isHookedWorkbenchScript(url)
    )
      return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(withWorkbenchHook(await response.text()), { headers });
  };
  const staticCache = createVscodeStaticCache({ load: loadStatic });

  let fontPreloads: Promise<string[]> | null = null;
  const loadFontPreloads = () => {
    fontPreloads ??= (
      options.readText?.(TERMINAL_FONT_CORE_STYLESHEET) ?? Promise.resolve(null)
    )
      .then((css) => (css ? asciiFontChunks(css) : []))
      .catch(() => []);
    return fontPreloads;
  };

  // Thyra embeds the editor in its own page; nothing else may.
  const framed = (
    response: Response,
    headers = new Headers(response.headers),
  ) => {
    for (const name of HOP_BY_HOP) headers.delete(name);
    if (!headers.has("content-security-policy"))
      headers.set("content-security-policy", "frame-ancestors 'self'");
    headers.set("x-frame-options", "SAMEORIGIN");
    return headers;
  };

  async function fetchHttp(req: Request, url: URL): Promise<Response> {
    if (!upstream)
      return new Response("VS Code is not configured", { status: 404 });
    const workbench =
      req.method === "GET" && /^\/vscode\/?$/.test(url.pathname);
    let response: Response;
    try {
      const cached = await staticCache.respond(req, url);
      if (cached)
        return new Response(cached.body, {
          status: cached.status,
          headers: framed(cached),
        });
      // The hooked script never goes out without its hook, cached or not.
      response =
        req.method === "GET" && isHookedWorkbenchScript(url)
          ? await loadStatic(req, url)
          : await fetch(target(url), {
              method: req.method,
              headers: workbench ? identityHeaders(req) : upstreamHeaders(req),
              body:
                req.method === "GET" || req.method === "HEAD"
                  ? undefined
                  : req.body,
              redirect: "manual",
              decompress: false,
            } as RequestInit);
    } catch {
      return new Response("VS Code is unavailable", { status: 502 });
    }
    const headers = framed(response);
    if (response.status === 200 && isVscodeStaticPath(url.pathname))
      headers.set("cache-control", VSCODE_STATIC_CACHE_CONTROL);
    if (
      workbench &&
      response.status === 200 &&
      !headers.has("content-encoding") &&
      /^text\/html\b/i.test(headers.get("content-type") ?? "")
    ) {
      let html: string;
      try {
        html = await response.text();
      } catch {
        return new Response("VS Code is unavailable", { status: 502 });
      }
      headers.delete("content-length");
      return new Response(
        withHookedWorkbenchScript(
          withThyraFonts(html, await loadFontPreloads()),
        ),
        { status: 200, headers },
      );
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  /** One upstream socket per peer; either end closing closes both. */
  function openSocket(peer: VscodePeer, req: Request, url: URL) {
    if (!upstream) {
      peer.close(4404, "VS Code is not configured");
      return { message() {}, close() {} };
    }
    const queued: (string | Uint8Array<ArrayBuffer>)[] = [];
    let closed = false;
    const socket = new WebSocket(target(url).replace(/^http/, "ws"), {
      headers: upstreamHeaders(req),
    } as unknown as string[]);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      for (const data of queued.splice(0)) socket.send(data);
    };
    socket.onmessage = (event) => {
      if (closed) return;
      peer.send(
        typeof event.data === "string"
          ? event.data
          : new Uint8Array(event.data as ArrayBuffer),
      );
    };
    const finish = (code = 1000, reason = "") => {
      if (closed) return;
      closed = true;
      // 1005/1006 are reserved and cannot be sent.
      peer.close(code === 1005 || code === 1006 ? 1011 : code, reason);
    };
    socket.onclose = (event) => finish(event.code, event.reason);
    socket.onerror = () => finish(1011, "VS Code is unavailable");
    return {
      message(data: string | Uint8Array<ArrayBuffer>) {
        if (closed) return;
        if (socket.readyState === WebSocket.OPEN) socket.send(data);
        else if (queued.push(data) > 4096) {
          finish(1011, "VS Code backlog");
          socket.close();
        }
      },
      close() {
        closed = true;
        if (socket.readyState <= WebSocket.OPEN) socket.close();
      },
    };
  }

  return { available: () => !!upstream, fetchHttp, openSocket };
}

export type VscodeProxy = ReturnType<typeof createVscodeProxy>;
