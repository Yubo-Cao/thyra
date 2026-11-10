import { parseTailnetSsoUrl, tailnetConnectSource } from "../auth/tailnet-sso";
import { thyraEnv } from "../config/environment";
import { loadServerConfig } from "../config/server-config";
import { loadPublicListenerConfig } from "../http/listener";
import { createLoginRateLimiter } from "../http/login-rate-limit";
import {
  inlineScriptHashes,
  publicContentSecurityPolicy,
} from "../http/public-auth";
import {
  createRequestAccessPolicy,
  parsePublicBaseUrls,
} from "../http/request-access";
import { createRequestRateLimiter } from "../http/request-rate-limit";
import { entryScriptPath, readStaticText } from "../http/static-files";
import { createWebPushService } from "../notifications/web-push";
import { refreshShellScripts } from "../shell/installer";
import { configureServerLogger, serverLogger } from "../utils/logger";
import { voiceCleanupFromEnv } from "../voice/cleanup";
import {
  createVoiceHandlers,
  voiceProvidersFromEnv,
} from "../voice/transcription";

export type ServerBootstrap = Awaited<ReturnType<typeof loadServerBootstrap>>;

/**
 * Configuration, logging and the listener setup read from the environment.
 * A misconfigured public listener stops the process here.
 */
export async function loadServerBootstrap(APP_VERSION: string) {
  const config = loadServerConfig(APP_VERSION);
  await refreshShellScripts().catch(() =>
    console.warn("[bridge] shell integration script refresh failed"),
  );
  configureServerLogger(config.logLevel);
  const logger = serverLogger;
  const voice = createVoiceHandlers({
    providers: () => voiceProvidersFromEnv(),
    cleanup: () => voiceCleanupFromEnv(),
  });
  const webPush = createWebPushService({
    warn: (message) => logger.warn(message),
    // Declared below; read at delivery time.
    launchOrigin: () => publicListener?.origin ?? null,
  });
  const downstreamConnectionConfig = {
    socketPath: config.socketPath,
    clientSocketPath: config.clientSocketPath,
    sshHost: config.sshHost,
    session: config.session,
    hasExplicitSocketPath: config.hasExplicitSocketPath,
    hasExplicitClientSocketPath: config.hasExplicitClientSocketPath,
  };
  const publicBaseUrls = parsePublicBaseUrls(thyraEnv("PUBLIC_BASE_URL"));
  if (publicBaseUrls.invalid.length > 0) {
    logger.warn("ignoring invalid THYRA_PUBLIC_BASE_URL entries", {
      entries: publicBaseUrls.invalid.join(","),
    });
  }

  // The internet-facing listener behind Cloudflare Tunnel. Misconfiguration
  // stops startup rather than serving public traffic half-configured.
  let publicListener: ReturnType<typeof loadPublicListenerConfig> = null;
  try {
    publicListener = loadPublicListenerConfig({
      listen: thyraEnv("PUBLIC_LISTEN"),
      origin: thyraEnv("PUBLIC_ORIGIN"),
      trustedProxies: thyraEnv("PUBLIC_TRUSTED_PROXIES"),
      primaryOrigins: publicBaseUrls.origins,
      primary: { hostname: config.host, port: config.port },
    });
  } catch (error) {
    console.error(`[bridge] ${(error as Error).message}`);
    process.exit(2);
  }
  for (const warning of publicListener?.warnings ?? []) logger.warn(warning);
  // Tailnet sign-in for the public listener: its login page asks the tailnet
  // listener at this origin for a single-use code.
  let tailnetSsoOrigin: string | null = null;
  try {
    tailnetSsoOrigin = parseTailnetSsoUrl(
      thyraEnv("TAILNET_SSO_URL"),
      publicListener?.origin ?? null,
    );
  } catch (error) {
    console.error(`[bridge] ${(error as Error).message}`);
    process.exit(2);
  }
  const publicAccessPolicy = publicListener
    ? createRequestAccessPolicy({
        listenerKind: "public",
        port: publicListener.port,
        tls: false,
        bindHost: publicListener.hostname,
        publicOrigins: [publicListener.origin],
        trustedProxies: publicListener.trustedProxies,
      })
    : null;
  const publicRequests = createRequestRateLimiter();
  const publicLoginLimiter = createLoginRateLimiter();
  let publicHtmlPolicy: Promise<string> | null = null;
  /** The public CSP, allowing the SPA entry's inline scripts by hash. */
  function publicPagePolicy(): Promise<string> {
    publicHtmlPolicy ??= readStaticText(config.publicDir, "/index.html")
      .catch(() => null)
      .then((html) =>
        publicContentSecurityPolicy(
          inlineScriptHashes(html ?? ""),
          // The login page's silent tailnet sign-in fetches a code there, and
          // the app asks it for the direct path (web/src/directPath.ts).
          tailnetSsoOrigin && publicListener
            ? [tailnetConnectSource(tailnetSsoOrigin, publicListener.origin)]
            : [],
        ),
      );
    return publicHtmlPolicy;
  }
  /**
   * The entry script of the frontend this process serves, sent in the hello:
   * a page running another build (an open tab after an update) offers a reload.
   */
  let webEntry: string | null = null;
  void readStaticText(config.publicDir, "/index.html")
    .then((html) => {
      webEntry = html ? entryScriptPath(html) : null;
    })
    .catch(() => {});
  return {
    config,
    logger,
    voice,
    webPush,
    downstreamConnectionConfig,
    publicBaseUrls,
    publicListener,
    tailnetSsoOrigin,
    publicAccessPolicy,
    publicRequests,
    publicLoginLimiter,
    publicPagePolicy,
    /** Read at hello time: the entry is resolved asynchronously. */
    webEntry: () => webEntry,
  };
}
