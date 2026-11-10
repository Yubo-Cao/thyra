import type { Server } from "bun";
import type { AccessControl } from "../auth/access";
import {
  type Authenticator,
  type AuthResult,
  type Principal,
  unauthenticatedLoginRedirect,
} from "../auth/principal";
import type { AuthRoutes } from "../auth/routes";
import type { AuthzDeps } from "../authz/authorize";
import {
  authorizeHttp,
  connectionRouteId,
  type HttpRouteId,
  matchHttpRoute,
} from "../authz/http-policy";
import type { SocketData } from "../bridge/socket-data";
import type { ServerConfig } from "../config/server-config";
import {
  parseConnectionHttpRoute,
  rawRequestPathname,
} from "../connections/http-routing";
import { logDetail } from "../connections/log-detail";
import type { ConnectionManager } from "../connections/manager";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import { parseTrustedProxies, rateLimitKey } from "../identity/client-address";
import { AGENT_BOARD_PATH, handleAgentBoard } from "../message-board/http";
import type { createMessageBoard } from "../message-board/service";
import type { Logger } from "../utils/logger";
import { type AuthenticatedRoute, withSetCookie } from "./authenticated-routes";
import type { ListenerKind, PublicListenerConfig } from "./listener";
import type { LoginRateLimiter } from "./login-rate-limit";
import {
  isPublicStaticAsset,
  type PublicAuthenticator,
  withPublicSecurityHeaders,
} from "./public-auth";
import {
  createRequestAccessPolicy,
  forbiddenResponse,
  hostNotAllowedResponse,
  originCheckMode,
  type RequestAccessPolicy,
} from "./request-access";
import {
  type RequestRateLimiter,
  rateLimitedResponse,
} from "./request-rate-limit";
import { serveStatic } from "./static-files";

const FORWARDING_HEADER_NAMES = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

/** A copy for the identity service without any forwarding headers. */
function withoutForwardingHeaders(req: Request): Request {
  const headers = new Headers(req.headers);
  for (const name of FORWARDING_HEADER_NAMES) headers.delete(name);
  return new Request(req.url, { method: req.method, headers });
}

/** Deny by default: a request no HTTP_POLICY route matches. */
function unmatchedRoute(url: URL): Response {
  return url.pathname.startsWith("/api/")
    ? Response.json({ error: "not found" }, { status: 404 })
    : new Response("method not allowed", { status: 405 });
}

/** Add a new or rotated session cookie unless the response already sets it. */
function withSessionCookie(
  response: Response | undefined,
  setCookie: string | undefined,
): Response | undefined {
  if (!response || !setCookie || response.status === 101) return response;
  return response.headers
    .getSetCookie()
    .some((cookie) => cookie.includes("thyra_session="))
    ? response
    : withSetCookie(response, setCookie);
}

/**
 * The `fetch` handlers of both listeners: access and origin checks, the
 * HTTP policy and authentication, then the routes behind them.
 */
export function createListenerFetch(deps: {
  config: ServerConfig;
  logger: Logger;
  publicBaseUrls: { origins: string[] };
  primaryKind: ListenerKind;
  publicListener: PublicListenerConfig | null;
  publicAccessPolicy: RequestAccessPolicy | null;
  publicRequests: RequestRateLimiter;
  publicLoginLimiter: LoginRateLimiter;
  publicPagePolicy: () => Promise<string>;
  messageBoard: ReturnType<typeof createMessageBoard>;
  authenticator: Authenticator;
  authRoutes: AuthRoutes;
  publicRoutes: AuthRoutes;
  publicAuth: PublicAuthenticator;
  authzDeps: AuthzDeps;
  accessControl: AccessControl;
  connectionManager: ConnectionManager<LegacyConnectionRuntime>;
  routeAuthenticated: (
    req: Request,
    server: Server<SocketData>,
    route: AuthenticatedRoute,
  ) => Promise<Response | undefined>;
}) {
  const {
    config,
    logger,
    publicBaseUrls,
    primaryKind,
    publicListener,
    publicAccessPolicy,
    publicRequests,
    publicLoginLimiter,
    publicPagePolicy,
    messageBoard,
    authenticator,
    authRoutes,
    publicRoutes,
    publicAuth,
    authzDeps,
    accessControl,
    connectionManager,
    routeAuthenticated,
  } = deps;
  let requestAccessPolicy: RequestAccessPolicy | null = null;
  /**
   * The primary listener's policy, created on first use: the listening port
   * is known only after binding.
   */
  function requestAccess(port: number): RequestAccessPolicy {
    requestAccessPolicy ??= createRequestAccessPolicy({
      listenerKind: primaryKind,
      port,
      tls: Boolean(config.tls),
      bindHost: config.host,
      publicOrigins: publicBaseUrls.origins,
      trustedProxies: parseTrustedProxies(process.env.THYRA_TRUSTED_PROXIES),
    });
    return requestAccessPolicy;
  }

  /** The policy route of an HTTP request (null: none matches) and its connection. */
  function httpRoute(req: Request, url: URL, requestPathname: string) {
    const connectionRoute = parseConnectionHttpRoute(
      requestPathname,
      req.method,
    );
    const routeId: HttpRouteId | null = connectionRoute
      ? connectionRoute.kind === "connection"
        ? connectionRouteId(connectionRoute.endpoint)
        : "connection.invalid"
      : matchHttpRoute(req.method, url.pathname);
    const connectionId =
      connectionRoute?.kind === "connection"
        ? (connectionRoute.requestedConnectionId ??
          connectionManager.defaultId())
        : null;
    return { routeId, connectionId };
  }

  /** Apply HTTP_POLICY; the refusal to send, or null when allowed. */
  async function refuseUnauthorized(
    req: Request,
    url: URL,
    route: { routeId: HttpRouteId; connectionId: string | null },
    principal: Principal | null,
  ): Promise<Response | null> {
    const decision = await authorizeHttp({
      route: route.routeId,
      principal,
      connectionId: route.connectionId,
      query: url.searchParams,
      deps: authzDeps,
      editsConnection: accessControl.editsConnection,
    });
    if (decision.ok) return null;
    if (decision.status === 401) {
      const accept = req.headers.get("accept") ?? "";
      if (req.method === "GET" && accept.includes("text/html"))
        return unauthenticatedLoginRedirect();
      return new Response("unauthorized", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }
    // The admin page is only a shell: everyone else goes back to the app.
    if (route.routeId === "admin.page")
      return new Response(null, {
        status: 303,
        headers: { location: "/", "cache-control": "no-store" },
      });
    logger.warn("rejected unauthorized request", {
      route: route.routeId,
      reason: decision.message,
    });
    return Response.json(
      { error: decision.message },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }

  /**
   * A public static asset (`isPublicStaticAsset`), served the same on every
   * listener to everyone: no principal, no cookie, so Cloudflare may cache it.
   * Without Accept, a missing asset is a 404 rather than the SPA entry.
   */
  function servePublicAsset(req: Request): Promise<Response> {
    const headers = new Headers(req.headers);
    headers.delete("accept");
    return serveStatic(
      new Request(req.url, { method: req.method, headers }),
      config.publicDir,
    );
  }

  /** The primary listener (`HOST`/`PORT`): `tailnet` or `local`. */
  async function primaryFetch(
    req: Request,
    server: Server<SocketData>,
  ): Promise<Response | undefined> {
    const requestPathname = rawRequestPathname(req.url);
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return new Response("invalid request URL", { status: 400 });
    }

    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return new Response("Ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // Host allowlist (DNS rebinding) and Origin checks (cross-site
    // WebSocket and request forgery) precede authentication.
    const peer = server.requestIP(req)?.address;
    const accessPolicy = requestAccess(server.port ?? config.port);
    const access = accessPolicy.evaluate(req, peer);
    if (!access.hostAllowed) {
      logger.warn("rejected request for an unknown host", {
        host: logDetail(access.host ?? ""),
      });
      return hostNotAllowedResponse(access.host);
    }
    if (url.pathname === AGENT_BOARD_PATH)
      return handleAgentBoard(req, messageBoard);
    const route = httpRoute(req, url, requestPathname);
    const originMode = originCheckMode(
      url.pathname,
      req.method,
      req.headers.get("upgrade")?.toLowerCase() === "websocket",
    );
    // The silent tailnet sign-in is a CORS request from the public origin; its
    // handler allows exactly that origin.
    if (originMode !== "none" && route.routeId !== "sso.code") {
      const decision = accessPolicy.checkOrigin(
        req,
        access,
        originMode === "strict",
      );
      if (!decision.ok) {
        logger.warn("rejected cross-origin request", {
          reason: decision.reason,
          path: logDetail(url.pathname),
          origin: logDetail(req.headers.get("origin") ?? ""),
        });
        return forbiddenResponse(decision.reason);
      }
    }
    if (!route.routeId) return unmatchedRoute(url);
    const routeId = route.routeId;
    // Before any session work, so tailnet login never adds a cookie to them.
    if (routeId === "static.asset") return servePublicAsset(req);

    // Direct local use, the session cookie, or tailnet login. Icons, the login
    // script, logout, share links and tailnet sign-in (which runs `whois`
    // itself) never start a session.
    const auth: AuthResult =
      routeId === "login.icon" ||
      routeId === "login.script" ||
      routeId === "logout" ||
      routeId === "share.page" ||
      routeId === "share.redeem" ||
      routeId.startsWith("sso.")
        ? { principal: null }
        : await authenticator.authenticate(req, access);
    const principal = auth.principal;
    const refused = await refuseUnauthorized(
      req,
      url,
      { ...route, routeId },
      principal,
    );
    if (refused) return refused;
    if (routeId === "login.page" && principal) {
      // Already logged in (or local): go to the app.
      return withSessionCookie(
        new Response(null, {
          status: 303,
          headers: { location: "/", "cache-control": "no-store" },
        }),
        auth.setCookie,
      );
    }
    const accountResponse = await authRoutes.handle(
      routeId,
      req,
      url,
      access,
      principal,
    );
    if (accountResponse)
      return withSessionCookie(accountResponse, auth.setCookie);
    if (routeId === "login.icon") {
      return serveStatic(req, config.publicDir);
    }
    if (!principal) return new Response("unauthorized", { status: 401 });
    return withSessionCookie(
      await routeAuthenticated(req, server, {
        url,
        requestPathname,
        access,
        issuedCookie: auth.setCookie ?? null,
        principal,
        identityRequest: req,
        identityPeer: peer,
        publicListener: false,
      }),
      auth.setCookie,
    );
  }

  /**
   * The public listener (`THYRA_PUBLIC_LISTEN`) behind Cloudflare Tunnel.
   * Only the public authenticator can authenticate a request here; without a
   * principal it serves the login page and static assets, and answers every
   * API and WebSocket request with 401.
   */
  async function publicFetch(
    req: Request,
    server: Server<SocketData>,
  ): Promise<Response | undefined> {
    const response = await publicRoute(req, server);
    return (
      response && withPublicSecurityHeaders(response, await publicPagePolicy())
    );
  }

  async function publicRoute(
    req: Request,
    server: Server<SocketData>,
  ): Promise<Response | undefined> {
    if (!publicListener || !publicAccessPolicy) {
      return new Response("not found", { status: 404 });
    }
    const requestPathname = rawRequestPathname(req.url);
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return new Response("invalid request URL", { status: 400 });
    }
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return new Response("Ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const peer = server.requestIP(req)?.address;
    const access = publicAccessPolicy.evaluate(req, peer);
    // Hashed build assets are static, immutable and edge-cached; one app load
    // fetches dozens of them, so they must not spend the per-client budget.
    const staticAsset =
      (req.method === "GET" || req.method === "HEAD") &&
      url.pathname.startsWith("/assets/");
    const retryAfter = staticAsset
      ? 0
      : publicRequests.take(rateLimitKey(access.clientAddress));
    if (retryAfter) return rateLimitedResponse(retryAfter);
    if (!access.hostAllowed) {
      logger.warn("public listener rejected an unknown host", {
        host: logDetail(access.host ?? ""),
      });
      return new Response("misdirected request", {
        status: 421,
        headers: { "cache-control": "no-store" },
      });
    }
    if (url.pathname === AGENT_BOARD_PATH)
      return handleAgentBoard(req, messageBoard);
    const originMode = originCheckMode(
      url.pathname,
      req.method,
      req.headers.get("upgrade")?.toLowerCase() === "websocket",
    );
    if (originMode !== "none") {
      const decision = publicAccessPolicy.checkOrigin(
        req,
        access,
        originMode === "strict",
      );
      if (!decision.ok) return forbiddenResponse(decision.reason);
    }
    const context = {
      access,
      origin: publicListener.origin,
      loginLimiter: publicLoginLimiter,
    };
    const authResponse = await publicAuth.handle(req, url, context);
    if (authResponse) return authResponse;
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      isPublicStaticAsset(url.pathname)
    ) {
      return servePublicAsset(req);
    }
    const auth = await publicAuth.authenticate(req, context);
    const principal = auth.principal;
    if (!principal) {
      const accept = req.headers.get("accept") ?? "";
      if (
        req.method === "GET" &&
        url.pathname !== "/ws" &&
        accept.includes("text/html")
      ) {
        return unauthenticatedLoginRedirect();
      }
      return new Response("unauthorized", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }
    const route = httpRoute(req, url, requestPathname);
    if (!route.routeId) return unmatchedRoute(url);
    const routeId = route.routeId;
    const refused = await refuseUnauthorized(
      req,
      url,
      { ...route, routeId },
      principal,
    );
    if (refused) return refused;
    const accountResponse = await publicRoutes.handle(
      routeId,
      req,
      url,
      access,
      principal,
    );
    if (accountResponse)
      return withSessionCookie(accountResponse, auth.setCookie);
    return withSessionCookie(
      await routeAuthenticated(req, server, {
        url,
        requestPathname,
        access,
        issuedCookie: auth.setCookie ?? null,
        principal,
        identityRequest: withoutForwardingHeaders(req),
        identityPeer: access.clientAddress,
        publicListener: true,
      }),
      auth.setCookie,
    );
  }

  return { primaryFetch, publicFetch };
}
