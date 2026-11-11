import type { Server, WebSocketHandler } from "bun";
import { join } from "node:path";
import { signupSettings } from "../auth/sign-in";
import type { SocketData } from "../bridge/socket-data";
import type { AgentBrowser } from "../browser/agent-browser";
import { dataRoot } from "../config/data-paths";
import { thyraEnv } from "../config/environment";
import {
  browserUrlFor,
  getLanIPs,
  isAnyHost,
  openBrowser,
} from "../config/server-config";
import { sanitizeConnectionError } from "../connections/manager";
import { bindListenerBeforeConnectionStart } from "../connections/startup";
import {
  archiveRunningBuild,
  prewarmStaticCompression,
  setAssetArchiveDir,
} from "../http/static-files";
import { FILE_UPLOAD_MAX_BYTES } from "../workspace/files";
import type { AccountServices } from "./accounts";
import type { AgentSessionService } from "./agent-sessions";
import type { ServerBootstrap } from "./bootstrap";
import type { ConnectionWiring } from "./connections";

// Server-wide ceiling for any request body. Each route enforces its own,
// smaller limit; this leaves headroom above the largest one (file upload) so
// that route reports its own error.
const MAX_REQUEST_BODY_BYTES = FILE_UPLOAD_MAX_BYTES + 16 * 1024 * 1024;

type Fetch = (
  req: Request,
  server: Server<SocketData>,
) => Promise<Response | undefined>;

/**
 * Bind the listeners, start the configured connections and report what is
 * served. The listeners bind before any connection starts.
 */
export function startServer(deps: {
  bootstrap: ServerBootstrap;
  accounts: AccountServices;
  connections: ConnectionWiring;
  agentBrowser: AgentBrowser;
  agentSessions: AgentSessionService;
  primaryFetch: Fetch;
  publicFetch: Fetch;
  websocketHandlers: WebSocketHandler<SocketData>;
}) {
  const { config, logger, publicListener, publicBaseUrls } = deps.bootstrap;
  const { accountStore, tailnetAuth, primaryKind, authProviders } =
    deps.accounts;
  const { connectionManager, connectionProfiles } = deps.connections;
  const { agentBrowser, primaryFetch, publicFetch, websocketHandlers } = deps;
  // Assigned by the bind callback below, which narrowing does not follow.
  let publicServer = null as Server<SocketData> | null;
  const server = bindListenerBeforeConnectionStart({
    bindListener: () => {
      const primary = Bun.serve<SocketData>({
        port: config.port,
        hostname: config.host,
        tls: config.tls,
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
        fetch: primaryFetch,
        websocket: websocketHandlers,
      });
      if (publicListener) {
        try {
          // Plain HTTP on loopback; cloudflared terminates TLS at the edge.
          publicServer = Bun.serve<SocketData>({
            port: publicListener.port,
            hostname: publicListener.hostname,
            maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
            fetch: publicFetch,
            websocket: websocketHandlers,
          });
        } catch (error) {
          void primary.stop(true);
          throw error;
        }
      }
      return primary;
    },
    startConnection: async () => {
      agentBrowser.start();
      deps.agentSessions.start();
      await connectionProfiles.startConfigured();
      // Hosts that outlived the last bridge are found without waiting for
      // the next periodic scan.
      deps.agentSessions.rescan();
      const runtime = connectionManager.defaultReadyRuntime();
      void runtime?.herdr
        .ping()
        .then((ping) =>
          logger.info("Herdr reachable", {
            connection: runtime.identity.id,
            version: ping.version,
            protocol: ping.protocol,
          }),
        )
        .catch((error) =>
          logger.warn("Herdr not reachable yet", {
            connection: runtime.identity.id,
            error: sanitizeConnectionError(error),
            action: "run `thyra herdr setup`; RPCs retry per request",
          }),
        );
    },
    onConnectionError: (error) => {
      logger.warn("default connection startup failed", {
        error: sanitizeConnectionError(error),
      });
    },
  });
  const listeningPort = server.port ?? config.port;
  const publicBrowserUrl = browserUrlFor(
    config.host,
    listeningPort,
    Boolean(config.tls),
  );
  logger.info("listening", {
    url: publicBrowserUrl,
    listener: primaryKind,
    websocket: "/ws",
    log_level: config.logLevel,
  });
  if (publicListener && publicServer) {
    logger.info("public listener", {
      origin: publicListener.origin,
      listen: browserUrlFor(
        publicListener.hostname,
        publicServer.port ?? publicListener.port,
      ),
    });
  }
  // Maximum-quality Brotli for the first-visit files, off the request path,
  // then keep this build's assets for pages that outlive the next update.
  // Source runs (development, tests) archive only when asked to.
  const archiveSetting = thyraEnv("ASSET_ARCHIVE_DIR");
  const assetArchive =
    archiveSetting === undefined
      ? Bun.isStandaloneExecutable
        ? join(dataRoot(), "asset-archive")
        : null
      : archiveSetting.trim() || null;
  setAssetArchiveDir(assetArchive);
  void prewarmStaticCompression(config.publicDir)
    .catch((error) =>
      logger.debug("static compression prewarm failed", {
        error: (error as Error).message,
      }),
    )
    .then(() =>
      assetArchive ? archiveRunningBuild(config.publicDir, assetArchive) : null,
    )
    .then((result) => {
      if (result?.copied || result?.removed)
        logger.debug("asset archive updated", result);
    })
    .catch((error) =>
      logger.warn("cannot archive frontend assets", {
        error: (error as Error).message,
      }),
    );
  logger.info("authentication", {
    scope: config.authRequired
      ? "all requests"
      : "proxied and non-local requests",
    mode: "passkeys",
    accounts: accountStore.userCount(),
    public_base_url: publicBaseUrls.origins.join(",") || undefined,
    tailnet_auth: tailnetAuth.mode,
    providers:
      [
        authProviders.email ? "email" : "",
        authProviders.github ? "github" : "",
        authProviders.google ? "google" : "",
        authProviders.microsoft ? "microsoft" : "",
        authProviders.oidc ? "oidc" : "",
      ]
        .filter(Boolean)
        .join(",") || "none",
    signup: signupSettings(accountStore).policy,
  });
  if (accountStore.userCount() === 0 && tailnetAuth.mode === "off") {
    logger.warn(
      "no accounts yet: run `thyra user add <name> --admin` on this host for a passkey enrollment link",
    );
  }
  logger.debug("Herdr sockets configured", {
    control_socket: config.socketPath,
    client_socket: config.clientSocketPath,
    public_dir: config.publicDir,
  });
  logger.info("browser URL", { url: publicBrowserUrl });

  const browserUrl = publicBrowserUrl;
  if (isAnyHost(config.host)) {
    const lanUrls = getLanIPs().map((ip) =>
      browserUrlFor(ip, listeningPort, Boolean(config.tls)),
    );
    if (lanUrls.length > 0) {
      for (const url of lanUrls) logger.info("LAN URL", { url });
    } else {
      logger.warn("no LAN IPv4 address detected");
    }
  }
  openBrowser(config, browserUrl);
}
