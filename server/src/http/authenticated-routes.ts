import type { Server } from "bun";
import { isHtmlPath } from "../../../shared/filePreview";
import { avatarUrl } from "../accounts/avatars";
import {
  guestDisplayName,
  isInstanceAdmin,
  type Principal,
  principalView,
} from "../auth/principal";
import { knownTailnetDevice } from "../auth/tailnet-sso";
import type { ClientIdentity } from "../bridge/client-registry";
import type { RtcTransport } from "../bridge/rtc-transport";
import type { SocketData } from "../bridge/socket-data";
import { type AgentBrowser, parseViewerScale } from "../browser/agent-browser";
import type { ServerConfig } from "../config/server-config";
import {
  type ParsedConnectionHttpRoute,
  parseConnectionHttpRoute,
} from "../connections/http-routing";
import type { ConnectionManager } from "../connections/manager";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import type { createWebPushService } from "../notifications/web-push";
import type { createVoiceHandlers } from "../voice/transcription";
import { isVscodePath, type VscodeProxy } from "../vscode/proxy";
import { DOWNLOAD_TIMEOUT_MS } from "../workspace/file-constants";
import type { createHerdrSetupHandlers } from "./herdr-setup";
import type { RequestAccess } from "./request-access";
import { serveStatic } from "./static-files";
import {
  type createUpdateHandlers,
  UPDATE_HTTP_IDLE_TIMEOUT_SECONDS,
} from "./update";

const CLIENT_SESSION_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function withSetCookie(response: Response, setCookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", setCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export type AuthenticatedRoute = {
  url: URL;
  requestPathname: string;
  access: RequestAccess;
  /** Session cookie issued by this response (new or rotated session). */
  issuedCookie: string | null;
  principal: Principal;
  /** The request and peer the identity service sees. */
  identityRequest: Request;
  identityPeer: string | null | undefined;
  /** Public listener: no identity device cookie (it is not `__Host-`). */
  publicListener: boolean;
};

/** The routes behind authentication: sockets, the API and the frontend. */
export function createAuthenticatedRouter(
  deps: {
    APP_VERSION: string;
    config: ServerConfig;
    voice: ReturnType<typeof createVoiceHandlers>;
    webPush: ReturnType<typeof createWebPushService>;
    tailnetSsoOrigin: string | null;
    clientIdentity: ClientIdentity;
    vscodeProxy: VscodeProxy;
    agentBrowser: AgentBrowser;
    agentBrowserConnection: () => string | null;
    localConnections: Set<string>;
    connectionManager: ConnectionManager<LegacyConnectionRuntime>;
    rtcTransport: RtcTransport<SocketData>;
    handleConnectionHttpRequest: (
      route: ParsedConnectionHttpRoute,
      url: URL,
      req: Request,
    ) => Promise<Response>;
  } & ReturnType<typeof createUpdateHandlers> &
    ReturnType<typeof createHerdrSetupHandlers>,
) {
  const {
    APP_VERSION,
    config,
    voice,
    webPush,
    tailnetSsoOrigin,
    clientIdentity,
    vscodeProxy,
    agentBrowser,
    agentBrowserConnection,
    localConnections,
    connectionManager,
    rtcTransport,
    handleConnectionHttpRequest,
    handleUpdateCheck,
    handleUpdateInstall,
    handleHerdrStatus,
    handleHerdrSetup,
  } = deps;
  return async function routeAuthenticated(
    req: Request,
    server: Server<SocketData>,
    route: AuthenticatedRoute,
  ): Promise<Response | undefined> {
    const { url, requestPathname, issuedCookie, principal } = route;
    if (url.pathname === "/ws") {
      const upgrade = clientIdentity.upgradeContext(
        route.identityRequest,
        route.identityPeer,
      );
      if (principal.kind === "user") {
        // The account is the person, whatever the device.
        upgrade.context.account = {
          key: principal.key,
          displayName: principal.user.displayName,
          avatarUrl: avatarUrl(principal.user.avatar),
        };
      } else if (principal.kind === "guest") {
        // Guests are "Guest" (plus the link's label) to everyone, whatever
        // name their device had before.
        upgrade.context.account = {
          key: principal.key,
          displayName: guestDisplayName(principal.link),
          fixedName: true,
        };
      }
      const clientSession = url.searchParams.get("client_session");
      const upgradeHeaders = new Headers();
      if (upgrade.headers["set-cookie"] && !route.publicListener)
        upgradeHeaders.append("set-cookie", upgrade.headers["set-cookie"]);
      if (issuedCookie) upgradeHeaders.append("set-cookie", issuedCookie);
      if (
        server.upgrade(req, {
          // Bun rejects an empty headers object.
          ...(upgradeHeaders.has("set-cookie")
            ? { headers: upgradeHeaders }
            : {}),
          data: {
            principal,
            client: upgrade.context,
            clientSession:
              clientSession && CLIENT_SESSION_PATTERN.test(clientSession)
                ? clientSession
                : null,
            directOrigin:
              // Only admins and known tailnet browsers probe it, so outside
              // collaborators never see Chrome's local network prompt.
              route.publicListener &&
              principal.kind === "user" &&
              (principal.user.role === "admin" || knownTailnetDevice(req))
                ? tailnetSsoOrigin
                : null,
            rtc:
              route.publicListener &&
              rtcTransport.enabled &&
              // Accounts only: the answer names the server's addresses, which
              // anonymous share-link guests have no reason to learn.
              principal.kind === "user",
          },
        })
      )
        return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    if (url.pathname === "/api/vscode") {
      // The editor sees this host's files, so only local connections use it.
      return Response.json(
        {
          connections: vscodeProxy.available()
            ? [...localConnections].filter((id) => connectionManager.has(id))
            : [],
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (isVscodePath(url.pathname)) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return vscodeProxy.fetchHttp(req, url);
      return server.upgrade(req, {
        data: {
          principal,
          clientSession: null,
          directOrigin: null,
          rtc: false,
          vscode: { req, url },
        },
      })
        ? undefined
        : new Response("websocket upgrade failed", { status: 400 });
    }
    if (url.pathname === "/ws/browser") {
      if (!agentBrowserConnection())
        return new Response("agent browser unavailable", { status: 404 });
      return server.upgrade(req, {
        data: {
          principal,
          clientSession: null,
          directOrigin: null,
          rtc: false,
          vnc: { scale: parseViewerScale(url.searchParams.get("scale")) },
        },
      })
        ? undefined
        : new Response("websocket upgrade failed", { status: 400 });
    }
    if (
      url.pathname === "/api/browser" ||
      url.pathname === "/api/browser/activate"
    ) {
      const connectionId = agentBrowserConnection();
      const pane = url.searchParams.get("pane");
      const headers = { "cache-control": "no-store" };
      if (url.pathname === "/api/browser") {
        return Response.json(
          {
            connection_id: connectionId,
            ...agentBrowser.status(),
            ...(connectionId && pane
              ? { tabs: await agentBrowser.tabs(pane) }
              : {}),
            // `all=1`: the windows, for the browser opened without a pane.
            ...(connectionId && !pane && url.searchParams.get("all") === "1"
              ? { windows: await agentBrowser.windows() }
              : {}),
          },
          { headers },
        );
      }
      if (!connectionId || (!pane && !url.searchParams.get("target")))
        return Response.json(
          { error: "agent browser unavailable" },
          { status: 404, headers },
        );
      const target = await agentBrowser.activate(
        pane,
        url.searchParams.get("target"),
      );
      return Response.json({ target_id: target }, { headers });
    }
    if (url.pathname === "/api/notifications/push") {
      return webPush.handle(req, principal.key);
    }
    if (url.pathname === "/api/voice/status" && req.method === "GET") {
      return voice.status();
    }
    if (url.pathname === "/api/voice/transcribe" && req.method === "POST") {
      // Local recognizers and remote providers can exceed Bun's default
      // ten-second idle timeout for a long segment.
      server.timeout(req, 75);
      return voice.transcribe(req);
    }
    if (url.pathname === "/api/voice/cleanup" && req.method === "POST") {
      server.timeout(req, 60);
      return voice.cleanup(req);
    }
    if (url.pathname === "/api/health") {
      const health = Response.json({
        ok: true,
        version: APP_VERSION,
        ...(isInstanceAdmin(principal) ? { socket: config.socketPath } : {}),
        // Whether this browser logged in (shows Log out).
        auth_required: principal.kind === "user",
        principal: principalView(principal),
      });
      return issuedCookie ? withSetCookie(health, issuedCookie) : health;
    }
    if (url.pathname === "/api/update/check" && req.method === "GET") {
      server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
      return handleUpdateCheck(req);
    }
    if (url.pathname === "/api/update/install" && req.method === "POST") {
      // Binary download and verification can exceed Bun's default ten-second
      // request timeout. Keep the larger budget scoped to update requests.
      server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
      return handleUpdateInstall(req);
    }
    if (url.pathname === "/api/herdr/status" && req.method === "GET") {
      return handleHerdrStatus();
    }
    if (url.pathname === "/api/herdr/setup" && req.method === "POST") {
      // Herdr download plus service start shares the update budget.
      server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
      return handleHerdrSetup(req);
    }
    const connectionRoute = parseConnectionHttpRoute(
      requestPathname,
      req.method,
    );
    if (connectionRoute) {
      if (
        connectionRoute.kind === "connection" &&
        connectionRoute.endpoint === "file-download" &&
        url.searchParams.get("inline") === "1" &&
        isHtmlPath(url.searchParams.get("path") ?? "")
      ) {
        // HTML preparation can require several bounded SSH resource reads.
        server.timeout(req, DOWNLOAD_TIMEOUT_MS / 1000);
      }
      return handleConnectionHttpRequest(connectionRoute, url, req);
    }
    // Everything else: serve the built frontend (embedded or on-disk).
    const staticPage = await serveStatic(req, config.publicDir);
    const page = route.publicListener
      ? staticPage
      : clientIdentity.withPageCookie(
          route.identityRequest,
          route.identityPeer,
          staticPage,
        );
    return issuedCookie ? withSetCookie(page, issuedCookie) : page;
  };
}
