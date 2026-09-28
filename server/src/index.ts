import { join } from "node:path";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { isHtmlPath } from "../../shared/filePreview";
import { DOWNLOAD_TIMEOUT_MS } from "./workspace/file-constants";
import { createWebPushService } from "./notifications/web-push";
import { rmSync } from "node:fs";
import packageJson from "../../package.json";
import type { SshTunnelConfig } from "./bridge/ssh-tunnel";
import {
  flushCoalescedMessages,
  sendWebSocketMessage,
  WebSocketCleanupTracker,
  WS_PER_MESSAGE_DEFLATE,
} from "./bridge/websocket-send";
import {
  browserUrlFor,
  getLanIPs,
  isAnyHost,
  loadServerConfig,
  openBrowser,
} from "./config/server-config";
import {
  runServiceCommand,
  SERVICE_COMMAND_CONTINUE,
} from "./config/service-manager";
import { runHerdrCommand } from "./herdr/cli";
import { enrichIntegrationVersions } from "./herdr/integration-versions";
import {
  createHerdrSetupHandlers,
  herdrSetupGuardForProfile,
} from "./http/herdr-setup";
import { HerdrClient } from "./bridge/herdr-client";
import {
  connectionRoutingErrorResponse,
  type ParsedConnectionHttpRoute,
  parseConnectionHttpRoute,
  publishConnectionHttpResponse,
  rawRequestPathname,
  resolveConnectionHttpRoute,
} from "./connections/http-routing";
import {
  ConnectionManager,
  type ConnectionRuntimeContext,
  sanitizeConnectionError,
} from "./connections/manager";
import {
  ConnectionProfileService,
  connectionIdentityForProfile,
  loadConnectionProfileBootstrap,
  type SyntheticLocalProfile,
  testConnectionSockets,
} from "./connections/profile-service";
import {
  type ConnectionProfile,
  ConnectionProfileStore,
} from "./connections/profiles";
import { createSshProfileRuntimeConfig } from "./connections/ssh-profile-runtime";
import {
  ConnectionRoutingError,
  createConnectionReplyPublisher,
  createLegacyRoutingLogger,
  isBridgeGlobalMethod,
  serializeConnectionEnvelope,
  serializeHerdrEventEnvelope,
  validateConnectionGeneration,
  validateConnectionId,
} from "./connections/protocol";
import {
  type ConnectionRpcRequest,
  isConnectionRpcEnvelope,
  resolveRpcRoute,
} from "./connections/rpc-routing";
import {
  createLegacyConnectionRuntime,
  type LegacyConnectionRuntime,
} from "./connections/runtime";
import { createShutdownController } from "./connections/shutdown";
import { bindListenerBeforeConnectionStart } from "./connections/startup";
import { LEGACY_DEFAULT_CONNECTION_ID } from "./connections/types";
import { createLoginRateLimiter } from "./http/login-rate-limit";
import { parseTailnetAuthMode } from "./http/tailnet-auth";
import {
  createRequestAccessPolicy,
  forbiddenResponse,
  hostNotAllowedResponse,
  originCheckMode,
  parsePublicBaseUrls,
  type RequestAccess,
  type RequestAccessPolicy,
} from "./http/request-access";
import { lookupRpc } from "./authz/policy";
import {
  type AuthzDeps,
  authorize,
  TAKEOVER_PROTECTION_MS,
} from "./authz/authorize";
import {
  annotateOwnerAccess,
  filterBridgeStatus,
  filterConnections,
  filterDisplayOwners,
  filterEvent,
  filterListResult,
  filterPresenceResult,
  narrowLayoutResult,
  type PaneScope,
} from "./authz/filters";
import {
  authorizeHttp,
  connectionRouteId,
  type HttpRouteId,
  matchHttpRoute,
} from "./authz/http-policy";
import { runAccountsCommand } from "./accounts/cli";
import { defaultDatabasePath, openAccountDatabase } from "./accounts/database";
import { type AccountStore, createAccountStore } from "./accounts/store";
import {
  createShareLinkStore,
  type ShareLinkStore,
} from "./accounts/share-links";
import { createAccessControl } from "./auth/access";
import { createPasskeyService } from "./auth/passkeys";
import {
  type AuthResult,
  createAuthenticator,
  guestDisplayName,
  isInstanceAdmin,
  type Principal,
  principalView,
  unauthenticatedLoginRedirect,
} from "./auth/principal";
import { createPublicAuthenticator } from "./auth/public";
import { createAuthRoutes } from "./auth/routes";
import { createShareRoutes } from "./auth/share-routes";
import {
  createSsoCodeStore,
  createTailnetSso,
  parseTailnetSsoUrl,
} from "./auth/tailnet-sso";
import {
  type ListenerKind,
  loadPublicListenerConfig,
  primaryListenerKind,
} from "./http/listener";
import {
  inlineScriptHashes,
  isPublicStaticAsset,
  type PublicAuthenticator,
  publicContentSecurityPolicy,
  withPublicSecurityHeaders,
} from "./http/public-auth";
import {
  createRequestRateLimiter,
  rateLimitedResponse,
} from "./http/request-rate-limit";
import { collaborationParams } from "./authz/collaboration-params";
import { parseTrustedProxies } from "./identity/client-address";
import { dataRoot } from "./config/data-paths";
import { thyraEnv } from "./config/environment";
import {
  archiveRunningBuild,
  entryScriptPath,
  prewarmStaticCompression,
  readStaticText,
  serveStatic,
  setAssetArchiveDir,
} from "./http/static-files";
import {
  createUpdateHandlers,
  UPDATE_HTTP_IDLE_TIMEOUT_SECONDS,
} from "./http/update";
import {
  configureServerLogger,
  createRecoveryReporter,
  type RecoveryReporter,
  serverLogger,
} from "./utils/logger";
import { runProcessWithCodeTimeout, shQuote } from "./utils/process-utils";
import { rpcLogLevel } from "./utils/rpc-logging";
import { syncWorktreeBase } from "./worktree/create";
import {
  createVoiceHandlers,
  voiceProvidersFromEnv,
} from "./voice/transcription";
import {
  removeWorktreeWithRecovery,
  WORKTREE_REMOVE_TIMEOUT_MS,
} from "./worktree/remove";
import { voiceCleanupFromEnv } from "./voice/cleanup";
import { createIdentityServiceFromEnv } from "./identity/from-env";
import type { ClientContext } from "./identity/identity-service";
import { optionalString } from "./utils/rpc-params";
import { runMcpCommand } from "./mcp/cli";
import { createThyraMcpService } from "./mcp/service";

const APP_VERSION = packageJson.version;
const serviceCommandResult = runServiceCommand(process.argv.slice(2));
if (serviceCommandResult === SERVICE_COMMAND_CONTINUE) {
  process.argv.splice(2);
} else if (serviceCommandResult !== null) {
  process.exit(serviceCommandResult);
}
const herdrCommandResult = await runHerdrCommand(
  process.argv.slice(2),
  APP_VERSION,
);
if (herdrCommandResult !== null) {
  process.exit(herdrCommandResult);
}
const mcpCommandResult = await runMcpCommand(
  process.argv.slice(2),
  APP_VERSION,
);
if (mcpCommandResult !== null) {
  process.exit(mcpCommandResult);
}
const accountsCommandResult = await runAccountsCommand(process.argv.slice(2));
if (accountsCommandResult !== null) {
  process.exit(accountsCommandResult);
}
const config = loadServerConfig(APP_VERSION);
configureServerLogger(config.logLevel);
const logger = serverLogger;
const voice = createVoiceHandlers({
  providers: () => voiceProvidersFromEnv(),
  cleanup: () => voiceCleanupFromEnv(),
});
const webPush = createWebPushService({
  warn: (message) => logger.warn(message),
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
        // The login page's silent tailnet sign-in fetches a code there.
        tailnetSsoOrigin ? [tailnetSsoOrigin] : [],
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
const CLIENT_SESSION_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function withSetCookie(response: Response, setCookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", setCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type RpcRequest = ConnectionRpcRequest;

const clientIdentity = createIdentityServiceFromEnv<ServerWebSocket<unknown>>({
  secureCookies: Boolean(config.tls),
  logger: logger.child("identity"),
});
const tailnetAuth = parseTailnetAuthMode(
  thyraEnv("TAILNET_AUTH"),
  clientIdentity.whoisAvailable,
);
if (tailnetAuth.warning) logger.warn(tailnetAuth.warning);
const primaryKind: ListenerKind = primaryListenerKind(tailnetAuth.mode);
if (thyraEnv("PASSWORD"))
  logger.warn(
    "THYRA_PASSWORD is no longer used: log in with a passkey (`thyra user add`) or through tailnet login",
  );

let accountStore: AccountStore;
let shareLinks: ShareLinkStore;
try {
  accountStore = createAccountStore(openAccountDatabase(defaultDatabasePath()));
  accountStore.pruneExpired();
  shareLinks = createShareLinkStore(accountStore);
  shareLinks.pruneExpired();
} catch (error) {
  logger.error("cannot open the account database", {
    error: (error as Error).message,
  });
  process.exit(1);
}
/** The primary listener: direct local use, session cookies, tailnet login. */
const authenticator = createAuthenticator({
  store: accountStore,
  authRequired: config.authRequired,
  tailnetMode: tailnetAuth.mode,
  tailnetUser: clientIdentity.tailnetUser,
  secureCookies: Boolean(config.tls),
  shares: shareLinks,
  logger: logger.child("auth"),
});
/**
 * The public listener: `__Host-` session cookies only. It never skips login
 * and never runs tailnet login, whatever the request's headers.
 */
const publicAuthenticator = createAuthenticator({
  store: accountStore,
  authRequired: true,
  tailnetMode: "off",
  tailnetUser: async () => null,
  hostOnlyCookie: true,
  shares: shareLinks,
  logger: logger.child("auth"),
});
const accessControl = createAccessControl(accountStore);
/** Principal of each browser socket, fixed at its upgrade. */
const socketPrincipals = new WeakMap<ServerWebSocket<unknown>, Principal>();
/** Principal key owning each live presence participant. */
const participantPrincipals = new Map<string, string>();
const authzDeps: AuthzDeps = {
  roleOn: accessControl.roleOn,
  locate: async (connectionId, target) =>
    (await connectionManager
      .readyRuntime(connectionId)
      ?.topology.locate(target)) ?? null,
  claimOf: (connectionId, paneId) =>
    connectionManager.readyRuntime(connectionId)?.claims.get(paneId) ?? null,
  principalOfParticipant: (participantId) =>
    participantPrincipals.get(participantId) ?? null,
};
const passkeys = createPasskeyService({ store: accountStore });
const tailnetSsoCodes = createSsoCodeStore(accountStore);
/** Tailnet sign-in, when the public listener has a tailnet listener to ask. */
const tailnetSso =
  publicListener && tailnetSsoOrigin
    ? createTailnetSso({
        store: accountStore,
        codes: tailnetSsoCodes,
        publicOrigin: publicListener.origin,
        tailnetOrigin: tailnetSsoOrigin,
        tailnetAccount: authenticator.tailnetAccountFor,
        sessionCookie: publicAuthenticator.sessionCookie,
        logger: logger.child("auth"),
      })
    : null;
if (tailnetSso && tailnetAuth.mode === "off") {
  logger.warn(
    "THYRA_TAILNET_SSO_URL is set but tailnet login is off; tailnet sign-in on the public listener will always fall back to passkeys",
  );
}
function accountRoutes(
  listenerAuthenticator: typeof authenticator,
  limiter: ReturnType<typeof createLoginRateLimiter>,
) {
  const connectionExists = (connectionId: string) =>
    connectionProfiles.list().some((profile) => profile.id === connectionId);
  const onChange = () => {
    accessControl.invalidate();
    checkLiveSessions();
  };
  return createAuthRoutes({
    store: accountStore,
    authenticator: listenerAuthenticator,
    passkeys,
    limiter,
    authzDeps,
    connectionExists,
    onChange,
    onSessionEnded: (idHash) =>
      closeSockets(
        (principal) =>
          principal.kind === "user" && principal.session.idHash === idHash,
        4001,
        "Logged out",
      ),
    shares: shareLinks,
    onGuestsEnded: closeGuestSockets,
    tailnetSso,
    shareRoutes: createShareRoutes({
      store: accountStore,
      shares: shareLinks,
      authenticator: listenerAuthenticator,
      // Its own budget: failed share redemptions never block passkey login.
      limiter: createLoginRateLimiter(),
      authzDeps,
      connectionExists,
      // Guests open links on the public listener when there is one.
      linkOrigin: (access) => publicListener?.origin ?? access.ownOrigin,
      onChange,
      onGuestsEnded: closeGuestSockets,
      logger: logger.child("share"),
    }),
    logger: logger.child("auth"),
  });
}

/** Close the sockets of ended guest sessions (revoked links, leaving). */
function closeGuestSockets(idHashes: string[]) {
  const ended = new Set(idHashes);
  if (ended.size === 0) return;
  closeSockets(
    (principal) =>
      principal.kind === "guest" && ended.has(principal.guest.idHash),
    4001,
    "Shared view ended",
  );
}
const authRoutes = accountRoutes(authenticator, createLoginRateLimiter());
const publicRoutes = accountRoutes(publicAuthenticator, publicLoginLimiter);
/** Accounts and passkeys on the public listener. */
const publicAuth: PublicAuthenticator = createPublicAuthenticator({
  authenticator: publicAuthenticator,
  routes: publicRoutes,
});

function closeSockets(
  predicate: (principal: Principal) => boolean,
  code: number,
  reason: string,
) {
  for (const client of [...clients]) {
    const principal = socketPrincipals.get(client);
    if (!principal || !predicate(principal)) continue;
    webSocketCleanup.cleanup(client);
    client.close(code, reason);
  }
}

/**
 * Close browser sockets whose session ended (logout, revocation, expiry) or
 * whose account's privileges changed (role, grants, disabled): they
 * reconnect under current authority, or return to the login page. Runs when
 * the account database changed, here or in the CLI, and once a minute.
 */
function checkLiveSessions(force = false) {
  if (!accessControl.refresh() && !force) return;
  for (const client of [...clients]) {
    const principal = socketPrincipals.get(client);
    if (principal?.kind === "guest") {
      // Revoking a link deletes its guest sessions, here or in the CLI.
      if (!shareLinks.guestByHash(principal.guest.idHash)) {
        webSocketCleanup.cleanup(client);
        client.close(4001, "Shared view ended");
      }
      continue;
    }
    if (principal?.kind !== "user") continue;
    const session = accountStore.sessionByHash(principal.session.idHash);
    const user = accountStore.getUser(principal.user.id);
    if (!session || !user || user.disabled) {
      webSocketCleanup.cleanup(client);
      client.close(4001, "Session ended");
    } else if (user.privilegeEpoch !== principal.user.privilegeEpoch) {
      webSocketCleanup.cleanup(client);
      client.close(4003, "Access changed");
    }
  }
}
/** Guests whose link expired leave at once; expiry changes no database row. */
function closeExpiredGuests() {
  const now = Date.now();
  closeSockets(
    (principal) =>
      principal.kind === "guest" && principal.guest.expiresAt <= now,
    4001,
    "Shared view ended",
  );
}
setInterval(() => {
  checkLiveSessions();
  closeExpiredGuests();
}, 1000).unref();
setInterval(() => {
  accountStore.pruneExpired();
  shareLinks.pruneExpired();
  tailnetSsoCodes.pruneExpired();
  checkLiveSessions(true);
}, 60_000).unref();

/** A viewer's role lookup on one connection, or null for admins (no filter). */
function viewerRoles(ws: ServerWebSocket<unknown>, connectionId: string) {
  const principal = socketPrincipals.get(ws);
  if (!principal || isInstanceAdmin(principal)) return null;
  return accessControl.roleOf(principal, connectionId);
}

function scopedPaneOf(ws: ServerWebSocket<unknown>): string | null {
  const principal = socketPrincipals.get(ws);
  return principal?.kind === "guest" ? principal.link.paneId : null;
}

/**
 * The pane a guest's link is narrowed to, with the tab holding it, from the
 * last loaded topology (events are filtered synchronously).
 */
function peekScope(
  ws: ServerWebSocket<unknown>,
  connectionId: string,
): PaneScope | null {
  const pane = scopedPaneOf(ws);
  if (!pane) return null;
  const topology = connectionManager.readyRuntime(connectionId)?.topology;
  return { pane, tab: topology?.peek({ pane })?.tab ?? null };
}

/** `peekScope`, reloading a stale topology first (RPC results). */
async function freshScope(
  ws: ServerWebSocket<unknown>,
  connectionId: string,
): Promise<PaneScope | null> {
  const pane = scopedPaneOf(ws);
  if (!pane) return null;
  const topology = connectionManager.readyRuntime(connectionId)?.topology;
  return { pane, tab: (await topology?.locate({ pane }))?.tab ?? null };
}

const { handleUpdateCheck, handleUpdateInstall } = createUpdateHandlers({
  appVersion: APP_VERSION,
  runProcessWithCodeTimeout,
  shQuote,
  scheduleProcessExit: scheduleManagedShutdown,
});
const clients = new Set<ServerWebSocket<unknown>>();
/**
 * The collaboration service holding each browser socket's presence, so a
 * closed page leaves at once instead of lingering until its lease expires
 * (and followers stop following it).
 */
const socketPresence = new Map<
  ServerWebSocket<unknown>,
  LegacyConnectionRuntime["collaboration"]
>();

function leaveSocketPresence(ws: ServerWebSocket<unknown>) {
  const collaboration = socketPresence.get(ws);
  socketPresence.delete(ws);
  const participantId = participantIds.get(ws);
  if (
    participantId &&
    ![...clients].some((other) => participantIds.get(other) === participantId)
  )
    participantPrincipals.delete(participantId);
  if (!collaboration || !participantId) return;
  // A page that already reconnected keeps its id on the new socket.
  for (const other of socketPresence.keys()) {
    if (participantIds.get(other) === participantId) return;
  }
  clientIdentity.forgetParticipant(participantId);
  void collaboration
    .call("collaboration.leave", { participant_id: participantId })
    .catch(() => {
      // The runtime may be gone; its lease expires on its own.
    });
}
const clientIds = new WeakMap<ServerWebSocket<unknown>, number>();
/** Presence participant ids are assigned by the bridge, one per socket. */
const participantIds = new WeakMap<ServerWebSocket<unknown>, string>();
interface WebSocketCleanupSnapshot {
  client: string;
  viewedTerminals: string[];
}
let nextClientId = 1;

const rpcOutcomes = new Map<string, { status: "error"; detail?: string }>();

const IMPORTANT_RPC_METHODS = new Set([
  "bridge.pause_others",
  "agent_history.get",
  "agent_history.entry",
  "agent_session.get",
  "file.read",
  "file.write",
  "git.diff_file",
  "git.file_action",
  "git.pull",
  "git.repo_action",
  "launcher.launch",
  "settings.update_repo",
  "settings.workspace_auto_sync.get",
  "settings.workspace_auto_sync.list",
  "settings.workspace_auto_sync.update",
  "settings.workspace_auto_sync.update_key",
  "settings.worktree_hooks.get",
  "worktree.create",
  "worktree.open",
  "worktree.remove",
]);
// Pane-addressed input also makes this browser the OSC 52 clipboard owner.
const PANE_INPUT_METHODS = new Set([
  "pane.send_input",
  "pane.send_text",
  "pane.send_key",
  "pane.send_keys",
  "pane.paste",
]);
const SLOW_RPC_LOG_MS = 750;
const legacyRoutingLogger = createLegacyRoutingLogger({
  log: (message) =>
    logger.warn("deprecated request routing", { detail: message }),
});

function clientLabel(ws: ServerWebSocket<unknown>): string {
  const id = clientIds.get(ws);
  return id ? `c${id}` : "unknown";
}

function assignClientId(ws: ServerWebSocket<unknown>): string {
  clientIds.set(ws, nextClientId++);
  return clientLabel(ws);
}

function logDetail(value: string): string {
  return sanitizeConnectionError(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
    .trim()
    .slice(0, 300);
}

function parseRpcMeta(raw: string): {
  id: string | null;
  method: string | null;
  connectionId: unknown;
  connectionGeneration: unknown;
} {
  try {
    const msg = JSON.parse(raw);
    return {
      id: typeof msg?.id === "string" ? msg.id : null,
      method: typeof msg?.method === "string" ? msg.method : null,
      connectionId: Object.hasOwn(msg ?? {}, "connection_id")
        ? msg.connection_id
        : undefined,
      connectionGeneration: Object.hasOwn(msg ?? {}, "connection_generation")
        ? msg.connection_generation
        : undefined,
    };
  } catch {
    return {
      id: null,
      method: null,
      connectionId: undefined,
      connectionGeneration: undefined,
    };
  }
}

function rpcOutcomeKey(ws: ServerWebSocket<unknown>, id: string) {
  return `${clientLabel(ws)}\0${id}`;
}

function markRpcError(
  ws: ServerWebSocket<unknown>,
  id: string | null | undefined,
  detail?: string,
) {
  if (!id) return;
  rpcOutcomes.set(rpcOutcomeKey(ws, id), { status: "error", detail });
}

function takeRpcOutcome(ws: ServerWebSocket<unknown>, id: string | null) {
  if (!id) return null;
  const key = rpcOutcomeKey(ws, id);
  const outcome = rpcOutcomes.get(key) ?? null;
  rpcOutcomes.delete(key);
  return outcome;
}

function shouldLogRpc(
  method: string | null,
  elapsedMs: number,
  failed: boolean,
) {
  if (!method) return failed;
  if (failed) return true;
  if (method === "bridge.ping" || method === "bridge.status") return false;
  if (
    method === "terminal.input" ||
    method === "terminal.scroll" ||
    method === "terminal.frame_ack"
  )
    return false;
  if (method === "terminal.resize" && elapsedMs < SLOW_RPC_LOG_MS) return false;
  return IMPORTANT_RPC_METHODS.has(method) || elapsedMs >= SLOW_RPC_LOG_MS;
}

function logRpc(
  ws: ServerWebSocket<unknown>,
  method: string | null,
  startedAt: number,
  status: "ok" | "error",
  connectionId: string | null,
  detail?: string,
) {
  const elapsedMs = Date.now() - startedAt;
  const failed = status === "error";
  if (!shouldLogRpc(method, elapsedMs, failed)) return;
  const level = rpcLogLevel({ method, status, detail });
  logger[level]("rpc completed", {
    status,
    client: clientLabel(ws),
    method: method ? logDetail(method) : "unknown",
    connection: connectionId ? logDetail(connectionId) : undefined,
    duration_ms: elapsedMs,
    detail: detail ? logDetail(detail) : undefined,
  });
}

function summarizeHerdrEvent(event: any): string {
  const type = logDetail(String(event?.event ?? event?.type ?? "unknown"));
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const ids = ["workspace_id", "tab_id", "pane_id", "agent_id", "terminal_id"]
    .map((key) => {
      const value = data[key] ?? event?.[key];
      return typeof value === "string" && value
        ? `${key}=${logDetail(value)}`
        : "";
    })
    .filter(Boolean);
  return [`type=${type}`, ...ids].join(" ");
}

const connectionProfileStore = new ConnectionProfileStore();
const syntheticLegacyProfile: SyntheticLocalProfile = {
  id: LEGACY_DEFAULT_CONNECTION_ID,
  label: "Default",
  type: "local",
  control_socket_path: config.socketPath,
  client_socket_path: config.clientSocketPath,
  auto_connect: true,
};
const explicitLegacyOverride = Boolean(
  config.hasExplicitSocketPath ||
    config.hasExplicitClientSocketPath ||
    config.sshHost ||
    config.session,
);
let connectionBootstrap;
try {
  connectionBootstrap = loadConnectionProfileBootstrap({
    store: connectionProfileStore,
    legacyProfile: syntheticLegacyProfile,
    explicitLegacyOverride,
  });
} catch (error) {
  const registryLoadError = sanitizeConnectionError(error);
  logger.error("invalid connection registry preserved", {
    error: registryLoadError,
    profile_mutations: "disabled",
  });
  connectionBootstrap = {
    defaultConnectionId: LEGACY_DEFAULT_CONNECTION_ID,
    explicitLegacyOverride,
    persistedRegistry: null,
    registryLoadError,
    registrations: [
      { profile: syntheticLegacyProfile, readOnly: true as const },
    ],
  };
}

const connectionFailureReporters = new Map<string, RecoveryReporter>();
const readyConnectionGenerations = new Map<string, number>();

function connectionFailureReporter(connectionId: string): RecoveryReporter {
  let reporter = connectionFailureReporters.get(connectionId);
  if (!reporter) {
    reporter = createRecoveryReporter({
      logger: logger.child("connections"),
      failureMessage: "connection degraded",
      recoveryMessage: "connection recovered",
    });
    connectionFailureReporters.set(connectionId, reporter);
  }
  return reporter;
}

const connectionManager = new ConnectionManager<LegacyConnectionRuntime>(
  connectionBootstrap.defaultConnectionId,
  (status) => {
    const fields = {
      connection: status.id,
      state: status.state,
      generation: status.generation,
    };
    logger.debug("connection status", {
      ...fields,
      error: status.error?.message,
    });
    const reporter = connectionFailureReporter(status.id);
    if (
      (status.state === "error" || status.state === "reconnecting") &&
      status.error
    ) {
      reporter.failure(status.error.message, fields);
      return;
    }
    if (status.state !== "ready") return;
    if (reporter.recovered(fields)) {
      readyConnectionGenerations.set(status.id, status.generation);
    } else if (
      readyConnectionGenerations.get(status.id) !== status.generation
    ) {
      readyConnectionGenerations.set(status.id, status.generation);
      logger.info("connection ready", fields);
    }
  },
  logger.child("connections"),
);

const mcp = createThyraMcpService({
  version: APP_VERSION,
  readyRuntimes: () =>
    connectionManager
      .list()
      .flatMap((status) => connectionManager.readyRuntime(status.id) ?? []),
  defaultConnectionId: () => connectionManager.defaultId(),
  logger: logger.child("mcp"),
});

const { handleHerdrStatus, handleHerdrSetup } = createHerdrSetupHandlers({
  ping: () => {
    const runtime = connectionManager.defaultReadyRuntime();
    return runtime
      ? runtime.herdr.ping()
      : new HerdrClient(config.socketPath).ping();
  },
  guard: () =>
    herdrSetupGuardForProfile(
      config,
      connectionProfiles
        .list()
        .find((profile) => profile.id === connectionManager.defaultId()),
    ),
});

function runtimeFactoryForProfile(
  profile: ConnectionProfile | SyntheticLocalProfile,
) {
  const identity = connectionIdentityForProfile(profile);
  return (context: ConnectionRuntimeContext) => {
    const profileConfig: SshTunnelConfig =
      profile.id === LEGACY_DEFAULT_CONNECTION_ID
        ? downstreamConnectionConfig
        : profile.type === "ssh"
          ? createSshProfileRuntimeConfig(profile)
          : {
              socketPath: profile.control_socket_path,
              clientSocketPath: profile.client_socket_path,
              sshHost: undefined,
              session: undefined,
              hasExplicitSocketPath: true,
              hasExplicitClientSocketPath: true,
              ownedRuntimeDirectory: undefined,
            };
    let runtime: LegacyConnectionRuntime;
    try {
      runtime = createLegacyConnectionRuntime({
        identity,
        connectionGeneration: context.generation,
        config: profileConfig,
        logger: logger.child("connection"),
        safeSend,
        // Host-wide notices (the Herdr popup) reach instance admins only.
        broadcast: (payload, context) => {
          for (const ws of clients)
            if (isInstanceAdmin(socketPrincipals.get(ws)))
              safeSend(ws, payload, context);
        },
        clientLabel,
        markRpcError,
        presentSnapshot: clientIdentity.annotateSnapshot,
        socketIdentity: (ws) => {
          const participantId = participantIds.get(ws);
          return participantId
            ? {
                participantId,
                deviceKey: clientIdentity.deviceKeyOf(ws) ?? clientLabel(ws),
              }
            : null;
        },
        onTaskEvent: (event) => {
          mcp.recordTaskEvent(identity.id, event);
          const connections = connectionProfiles.list();
          webPush.notify(
            {
              ...event,
              connectionId: identity.id,
              connectionLabel:
                connections.length > 1
                  ? (connections.find(
                      (connection) => connection.id === identity.id,
                    )?.label ?? identity.label)
                  : undefined,
              runtimeGeneration: context.generation,
            },
            context.isCurrent,
            (owner) =>
              accessControl.subscriberSees(
                owner,
                identity.id,
                event.workspaceId,
              ),
          );
        },
        onEvent: (event, eventIdentity) => {
          if (!context.isCurrent()) return;
          mcp.recordHerdrEvent(eventIdentity.id, event);
          logger.debug("Herdr event", {
            connection: eventIdentity.id,
            detail: summarizeHerdrEvent(event),
          });
          const name = (event as { event?: unknown } | null)?.event;
          if (name === "workspace.closed") {
            const workspaceId = (event as { data?: { workspace_id?: unknown } })
              .data?.workspace_id;
            // Herdr may reuse the id of a closed workspace; its grants and
            // share links go.
            if (typeof workspaceId === "string") {
              const grants = accountStore.removeWorkspaceGrants(
                eventIdentity.id,
                workspaceId,
              ).length;
              const links = shareLinks.revokeWorkspaceLinks(
                eventIdentity.id,
                workspaceId,
              );
              if (grants > 0 || links > 0) {
                accessControl.invalidate();
                checkLiveSessions();
              }
            }
          }
          try {
            const line = serializeHerdrEventEnvelope(
              eventIdentity.id,
              event,
              context.generation,
            );
            // Each viewer sees only its workspaces' events.
            const views = new Map<string, string | null>();
            for (const ws of clients) {
              const roles = viewerRoles(ws, eventIdentity.id);
              if (!roles) {
                safeSend(ws, line, "event");
                continue;
              }
              const key = socketPrincipals.get(ws)?.key ?? "";
              let view = views.get(key);
              if (view === undefined) {
                const filtered = filterEvent(
                  event,
                  roles,
                  peekScope(ws, eventIdentity.id),
                );
                view = !filtered
                  ? null
                  : serializeHerdrEventEnvelope(
                      eventIdentity.id,
                      "resync" in filtered
                        ? { event: "session.resync_required", data: {} }
                        : filtered.event,
                      context.generation,
                    );
                views.set(key, view);
              }
              if (view) safeSend(ws, view, "event");
            }
          } catch (error) {
            logger.warn("dropped invalid Herdr event", {
              connection: eventIdentity.id,
              error: sanitizeConnectionError(error),
            });
          }
        },
        onTransportExit: profileConfig.sshHost
          ? (error) => {
              if (!context.isCurrent()) return;
              const reconnecting = connectionProfiles.willRetry(
                profile.id,
                error,
              );
              context.reportError(error, { reconnecting });
              connectionProfiles.runtimeFailed(profile.id, error);
            }
          : undefined,
      });
    } catch (error) {
      if (profileConfig.ownedRuntimeDirectory) {
        rmSync(profileConfig.ownedRuntimeDirectory, {
          recursive: true,
          force: true,
        });
      }
      throw error;
    }
    return {
      ...runtime,
      async startTransport() {
        await runtime.startTransport();
        await testConnectionSockets(
          profileConfig.socketPath,
          profileConfig.clientSocketPath,
        );
      },
    };
  };
}

const connectionProfiles = new ConnectionProfileService({
  manager: connectionManager,
  store: connectionProfileStore,
  bootstrap: connectionBootstrap,
  createRuntime: runtimeFactoryForProfile,
});

/** Browser sockets grouped by device (tabs and merged contexts count once). */
function countDevices(sockets: Iterable<ServerWebSocket<unknown>>): number {
  const devices = new Set<string>();
  for (const socket of sockets) {
    devices.add(clientIdentity.deviceKeyOf(socket) ?? clientLabel(socket));
  }
  return devices.size;
}

function notifyBrowserClientCount() {
  connectionManager.forEachCurrentRuntime((runtime) => {
    runtime.terminalBridge.browserClientCountChanged(clients.size);
  });
}

const webSocketCleanup = new WebSocketCleanupTracker<
  ServerWebSocket<unknown>,
  WebSocketCleanupSnapshot
>((ws) => {
  const viewedTerminals: string[] = [];
  connectionManager.forEachCurrentRuntime((runtime) => {
    viewedTerminals.push(...runtime.terminalBridge.viewedTerminals(ws));
    runtime.terminalBridge.cleanupWs(ws);
  });
  const snapshot = {
    client: clientLabel(ws),
    viewedTerminals,
  };
  clients.delete(ws);
  leaveSocketPresence(ws);
  clientIdentity.detach(ws);
  notifyBrowserClientCount();
  return snapshot;
});

function safeSend(
  ws: ServerWebSocket<unknown>,
  payload: string,
  context = "message",
  coalesceKey?: string,
): boolean {
  return sendWebSocketMessage(ws, payload, {
    cleanup: () => {
      webSocketCleanup.cleanup(ws);
    },
    coalesceKey,
    context,
    warn: (message) =>
      logger.warn("websocket send failed", {
        detail: message.replace(/^\[bridge\] /, ""),
      }),
  });
}

async function handleRpc(ws: ServerWebSocket<unknown>, raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeSend(
      ws,
      JSON.stringify({ error: { message: "bad json" } }),
      "bad-json",
    );
    return;
  }
  if (!isConnectionRpcEnvelope(parsed)) {
    safeSend(
      ws,
      JSON.stringify({ error: { message: "invalid request envelope" } }),
      "invalid-request-envelope",
    );
    return;
  }
  const req = parsed as RpcRequest;
  const { id, method } = req;
  let params: Record<string, any> | undefined = req.params;
  let validationConnectionId: string | undefined;
  let connectionIdValidationFailed = false;
  if (Object.hasOwn(req, "connection_id")) {
    try {
      validationConnectionId = validateConnectionId(req.connection_id);
    } catch {
      connectionIdValidationFailed = true;
    }
  }
  let validationConnectionGeneration: number | undefined;
  let connectionGenerationValidationFailed = false;
  if (Object.hasOwn(req, "connection_generation")) {
    try {
      validationConnectionGeneration = validateConnectionGeneration(
        req.connection_generation,
      );
    } catch {
      connectionGenerationValidationFailed = true;
    }
  }
  if (typeof id !== "string" || !id || typeof method !== "string" || !method) {
    const message = connectionIdValidationFailed
      ? "invalid connection_id"
      : connectionGenerationValidationFailed
        ? "invalid connection_generation"
        : "missing id/method";
    markRpcError(ws, typeof id === "string" ? id : undefined, message);
    const responseId = typeof id === "string" ? id : undefined;
    const payload = validationConnectionId
      ? serializeConnectionEnvelope(
          validationConnectionId,
          {
            ...(responseId ? { id: responseId } : {}),
            error: { message },
          },
          validationConnectionGeneration,
        )
      : JSON.stringify({
          ...(responseId ? { id: responseId } : {}),
          error: { message },
        });
    safeSend(ws, payload, "invalid-request");
    return;
  }
  // Deny by default: only methods in the policy table reach routing or any
  // handler, including the Herdr passthrough at the end.
  const known = lookupRpc(method);
  if (!known.allowed) {
    const message = known.message;
    markRpcError(ws, id, message);
    safeSend(
      ws,
      validationConnectionId
        ? serializeConnectionEnvelope(
            validationConnectionId,
            { id, error: { message } },
            validationConnectionGeneration,
          )
        : JSON.stringify({ id, error: { message } }),
      "rpc-denied",
    );
    return;
  }
  let route: ReturnType<typeof resolveRpcRoute<LegacyConnectionRuntime>>;
  try {
    route = resolveRpcRoute({
      request: req,
      registry: connectionManager,
      legacyClient: ws,
      legacyLogger: legacyRoutingLogger,
    });
  } catch (error) {
    const message = (error as Error).message;
    markRpcError(ws, id, message);
    const connectionId =
      error instanceof ConnectionRoutingError ? error.connectionId : undefined;
    const connectionGeneration =
      error instanceof ConnectionRoutingError
        ? error.connectionGeneration
        : undefined;
    const payload = connectionId
      ? serializeConnectionEnvelope(
          connectionId,
          {
            id,
            error: { message },
          },
          connectionGeneration,
        )
      : JSON.stringify({ id, error: { message } });
    safeSend(ws, payload, "connection-routing-error");
    return connectionId ?? null;
  }
  const connectionId = route.scope === "connection" ? route.connectionId : null;
  const requestIsCurrent = () => route.scope === "bridge" || route.isCurrent();
  const encode = (message: Record<string, unknown>) =>
    route.scope === "connection"
      ? serializeConnectionEnvelope(
          route.connectionId,
          message,
          route.generation,
        )
      : JSON.stringify(message);
  const replyPublisher =
    route.scope === "connection"
      ? createConnectionReplyPublisher({
          connectionId: route.connectionId,
          generation: route.generation,
          requestId: id,
          isCurrent: route.isCurrent,
          send: (payload, context) => safeSend(ws, payload, context),
          markError: (message) => markRpcError(ws, id, message),
        })
      : null;
  const sendReply = (
    message: Record<string, unknown>,
    context: string,
  ): boolean =>
    replyPublisher
      ? replyPublisher.send(message, context)
      : safeSend(ws, encode(message), context);
  const sendError = (context: string, error: unknown) => {
    const message = (error as Error).message;
    markRpcError(ws, id, message);
    sendReply({ id, error: { message } }, context);
  };
  // Authorize against the caller's account, grants and pane claims.
  const principal = socketPrincipals.get(ws);
  if (!principal) {
    sendError("rpc-denied", new Error("not logged in"));
    return;
  }
  const participantId = participantIds.get(ws) ?? null;
  if (
    route.scope === "connection" &&
    method.startsWith("terminal.") &&
    !(typeof params?.terminal_id === "string" && params.terminal_id)
  ) {
    // Terminal methods without terminal_id act on the socket's current one.
    const current = route.runtime.terminalBridge.currentTerminalId(ws);
    if (current) params = { ...(params ?? {}), terminal_id: current };
  }
  const authorization = await authorize(
    { principal, method, params: params ?? {}, connectionId, participantId },
    authzDeps,
  );
  if (!authorization.allowed) {
    sendError("rpc-denied", new Error(authorization.message));
    return;
  }
  params = authorization.params;
  if (authorization.stub) {
    sendReply({ id, result: authorization.stub.result }, "rpc-stub");
    return;
  }
  const roles = connectionId ? viewerRoles(ws, connectionId) : null;
  // A guest link narrowed to one pane filters results to that pane.
  const scope =
    connectionId && scopedPaneOf(ws)
      ? await freshScope(ws, connectionId)
      : null;
  if (
    authorization.autoClaim &&
    authorization.paneId &&
    participantId &&
    route.scope === "connection"
  ) {
    // Input to an unclaimed pane claims it: one writer at a time.
    const claimParams = {
      participant_id: participantId,
      pane_id: authorization.paneId,
      protect_ms: TAKEOVER_PROTECTION_MS,
    };
    try {
      const claimed = await route.runtime.collaboration.call(
        "collaboration.claim",
        claimParams,
      );
      route.runtime.claims.observeResult(
        "collaboration.claim",
        claimParams,
        claimed,
      );
      if (claimed?.granted === false) {
        sendError(
          "rpc-denied",
          new Error(
            `${method}: another collaborator controls this pane; take control first`,
          ),
        );
        return;
      }
    } catch {
      // Presence is unavailable (no participant yet): nobody else holds it.
    }
  }
  if (method === "bridge.ping") {
    sendReply({ id, result: { ok: true } }, "bridge-ping");
    return;
  }
  if (method === "bridge.identity" || method === "bridge.identity_profile") {
    try {
      const result =
        method === "bridge.identity"
          ? await clientIdentity.hello(ws, params ?? {})
          : await clientIdentity.updateProfile(ws, params ?? {});
      sendReply({ id, result }, method);
    } catch (error) {
      sendError(`${method}-error`, error);
    }
    return;
  }
  if (method === "bridge.status") {
    const status = {
      clients: clients.size,
      devices: countDevices(clients),
      terminals:
        connectionManager
          .defaultReadyRuntime()
          ?.terminalBridge.statusTerminals() ?? [],
      default_connection_id: connectionManager.defaultId(),
      connections: connectionProfiles.list(),
    };
    const visible = accessControl.connectionsOf(principal);
    sendReply(
      {
        id,
        result: isInstanceAdmin(principal)
          ? status
          : filterBridgeStatus(
              status,
              (connection) =>
                connection === status.default_connection_id ||
                visible.has(connection),
            ),
      },
      "bridge-status",
    );
    return;
  }
  if (method === "connections.list") {
    const connections = connectionProfiles.list();
    const visible = accessControl.connectionsOf(principal);
    sendReply(
      {
        id,
        result: {
          default_connection_id: connectionManager.defaultId(),
          connections: isInstanceAdmin(principal)
            ? connections
            : filterConnections(
                connections,
                (connection) =>
                  connection === connectionManager.defaultId() ||
                  visible.has(connection),
              ),
        },
      },
      "connections-list",
    );
    return;
  }
  if (method.startsWith("connections.")) {
    try {
      let result: unknown;
      if (method === "connections.create") {
        result = await connectionProfiles.create(params?.profile ?? params);
      } else if (method === "connections.update") {
        result = await connectionProfiles.update(
          params?.id,
          params?.profile ?? params,
        );
      } else if (method === "connections.remove") {
        result = await connectionProfiles.remove(params?.id);
      } else if (method === "connections.set_default") {
        result = await connectionProfiles.setDefault(params?.id);
      } else if (method === "connections.connect") {
        result = await connectionProfiles.connect(params?.id);
      } else if (method === "connections.disconnect") {
        result = await connectionProfiles.disconnect(params?.id);
      } else if (method === "connections.test") {
        result = await connectionProfiles.test(params?.profile ?? params);
      } else {
        throw new Error(`unknown bridge-global method: ${method}`);
      }
      sendReply({ id, result }, "connections-mutation");
    } catch (error) {
      const message = sanitizeConnectionError(error);
      markRpcError(ws, id, message);
      sendReply({ id, error: { message } }, "connections-mutation-error");
    }
    return;
  }
  if (method === "bridge.pause_others") {
    const targets = Array.from(clients).filter((client) => client !== ws);
    let pausedClients = 0;
    const pausedDevices = new Set<string>();
    for (const client of targets) {
      const ok = safeSend(
        client,
        JSON.stringify({
          control: {
            type: "pause_connection",
            reason:
              "Another Thyra client paused this connection. Resume when you want this browser to sync again.",
          },
        }),
        "pause-other-client",
      );
      if (ok) {
        pausedClients += 1;
        pausedDevices.add(
          clientIdentity.deviceKeyOf(client) ?? clientLabel(client),
        );
      }
    }
    sendReply(
      {
        id,
        result: {
          ok: true,
          paused_clients: pausedClients,
          paused_devices: pausedDevices.size,
          clients: clients.size,
          devices: countDevices(clients),
        },
      },
      "bridge-pause-others",
    );
    return;
  }

  if (route.scope === "bridge") {
    sendError(
      "unknown-bridge-method",
      new Error(`unknown bridge-global method: ${method}`),
    );
    return null;
  }
  const connection = route.runtime;
  const {
    sshHost,
    herdr,
    worktreeParents,
    handleSettingsRpc,
    worktreeRemovalCoordinator,
    worktreeRemovalRuntime,
    terminalBridge,
    collaboration,
  } = connection;
  const {
    listWorkspaceFiles,
    resolveWorkspaceFiles,
    readWorkspaceFile,
    writeWorkspaceFile,
    createWorkspaceEntry,
    readGitDiffSummary,
    readGitDiffFile,
    runGitPull,
    runWorkspaceGitFileAction,
    runWorkspaceGitRepoAction,
    resolveWorkspaceGitRoot,
  } = connection.files;
  const { enrichWorkspacesWithGitStatus, invalidateGitStatus } =
    connection.status;
  const {
    runPaseoWorktreeHook,
    worktreeRemoveHookContext,
    runWorktreeRemovedHook,
    runWorktreeOpenedHook,
    sourceWorkspaceForWorktreeCreate,
    runWorktreeSetupHook,
  } = connection.worktreeHooks;
  const {
    readHistory: readAgentMessageHistory,
    readSummary: readAgentSessionSummary,
    readEntry: readAgentHistoryEntry,
  } = connection.agentSessions;

  if (
    (method === "tab.create" || method === "workspace.create") &&
    params &&
    Object.hasOwn(params, "browser_source")
  ) {
    try {
      const result = await terminalBridge.createFromTerminal(
        ws,
        method,
        params,
        requestIsCurrent,
      );
      sendReply({ id, result }, method);
    } catch (error) {
      sendError(`${method}-error`, error);
    }
    return;
  }

  if (method === "agent.list") {
    try {
      const result = await connection.agentSessions.listWithActivity(
        params ?? {},
      );
      sendReply(
        {
          id,
          result: roles ? filterListResult(result, roles, scope) : result,
        },
        "agent-list",
      );
    } catch (e) {
      sendError("agent-list-error", e);
    }
    return;
  }
  if (method === "agent_history.get") {
    try {
      const result = await readAgentMessageHistory(params ?? {});
      sendReply({ id, result }, "agent-history-get");
    } catch (e) {
      sendError("agent-history-get-error", e);
    }
    return;
  }
  if (method === "agent_history.entry") {
    try {
      const result = await readAgentHistoryEntry(params ?? {});
      sendReply({ id, result }, "agent-history-entry");
    } catch (e) {
      sendError("agent-history-entry-error", e);
    }
    return;
  }
  if (method === "agent_session.get") {
    try {
      const result = await readAgentSessionSummary(params ?? {});
      sendReply({ id, result }, "agent-session-get");
    } catch (e) {
      sendError("agent-session-get-error", e);
    }
    return;
  }
  if (method === "file.list") {
    try {
      const result = await listWorkspaceFiles(params ?? {});
      sendReply({ id, result }, "file-list");
    } catch (e) {
      sendError("file-list-error", e);
    }
    return;
  }
  if (method === "file.resolve") {
    try {
      const result = await resolveWorkspaceFiles(params ?? {});
      sendReply({ id, result }, "file-resolve");
    } catch (e) {
      sendError("file-resolve-error", e);
    }
    return;
  }
  if (method === "file.read") {
    try {
      const result = await readWorkspaceFile(params ?? {});
      sendReply({ id, result }, "file-read");
    } catch (e) {
      sendError("file-read-error", e);
    }
    return;
  }
  if (method === "file.write") {
    try {
      const result = await writeWorkspaceFile(params ?? {});
      if (!result.scope) invalidateGitStatus(result.checkout_path);
      sendReply({ id, result }, "file-write");
    } catch (e) {
      sendError("file-write-error", e);
    }
    return;
  }
  if (method === "file.mkdir") {
    try {
      const result = await createWorkspaceEntry(params ?? {});
      sendReply({ id, result }, "file-mkdir");
    } catch (e) {
      sendError("file-mkdir-error", e);
    }
    return;
  }
  if (method === "git.diff_summary") {
    try {
      const result = await readGitDiffSummary(params ?? {});
      sendReply({ id, result }, "git-diff-summary");
    } catch (e) {
      sendError("git-diff-summary-error", e);
    }
    return;
  }
  if (method === "git.diff_file") {
    try {
      const result = await readGitDiffFile(params ?? {});
      sendReply({ id, result }, "git-diff-file");
    } catch (e) {
      sendError("git-diff-file-error", e);
    }
    return;
  }
  if (method === "git.pull") {
    try {
      const result = await runGitPull(params ?? {});
      invalidateGitStatus(result.root);
      sendReply({ id, result }, "git-pull");
    } catch (e) {
      sendError("git-pull-error", e);
    }
    return;
  }
  if (method === "git.file_action") {
    try {
      const result = await runWorkspaceGitFileAction(params ?? {});
      invalidateGitStatus(result.root);
      sendReply({ id, result }, "git-file-action");
    } catch (e) {
      sendError("git-file-action-error", e);
    }
    return;
  }
  if (method === "git.repo_action") {
    try {
      const result = await runWorkspaceGitRepoAction(params ?? {});
      invalidateGitStatus(result.root);
      sendReply({ id, result }, "git-repo-action");
    } catch (e) {
      sendError("git-repo-action-error", e);
    }
    return;
  }
  if (method.startsWith("terminal.")) {
    return terminalBridge.handleTerminalRpc(
      ws,
      id,
      method,
      params ?? {},
      requestIsCurrent,
      roles ? (result) => filterDisplayOwners(result, roles, scope) : undefined,
    );
  }
  if (method.startsWith("collaboration.")) {
    try {
      // The bridge, not the page, decides the participant id, role, name
      // and color; a page can only act as its own participant.
      const participantId = participantIds.get(ws);
      if (!participantId) throw new Error("presence unavailable");
      const validParams = collaborationParams(
        method,
        params ?? {},
        participantId,
        principal.kind === "guest"
          ? {
              workspace: principal.link.workspaceId,
              pane: principal.link.paneId,
            }
          : null,
      );
      const callParams =
        method === "collaboration.update"
          ? await clientIdentity.presenceParams(ws, validParams)
          : validParams;
      if (
        method === "collaboration.claim" &&
        authorization.takeoverAnytime &&
        callParams.takeover === true
      ) {
        // Workspace owners and admins take control during the protection.
        const paneId = String(callParams.pane_id);
        const holder = connection.claims.get(paneId);
        if (
          holder &&
          holder.participantId !== participantId &&
          (holder.protectedUntil ?? 0) > Date.now()
        ) {
          const releaseParams = {
            participant_id: holder.participantId,
            pane_id: paneId,
          };
          connection.claims.observeResult(
            "collaboration.release",
            releaseParams,
            await collaboration.call("collaboration.release", releaseParams),
          );
        }
      }
      if (method === "collaboration.leave") {
        clientIdentity.forgetParticipant(participantId);
        socketPresence.delete(ws);
      } else if (method === "collaboration.update") {
        // A page that closed meanwhile has already left; do not revive it.
        if (!clients.has(ws)) return;
        socketPresence.set(ws, collaboration);
      }
      const raw = await collaboration.call(method, callParams);
      connection.claims.observeResult(method, callParams, raw);
      const result = clientIdentity.annotateResult(
        raw,
        connection.presenceContext,
      );
      sendReply(
        {
          id,
          result: roles ? filterPresenceResult(result, roles, scope) : result,
        },
        method,
      );
    } catch (e) {
      sendError(`${method}-error`, e);
    }
    return;
  }
  if (method.startsWith("settings.")) {
    return handleSettingsRpc(ws, id, method, params ?? {}, requestIsCurrent);
  }
  if (method.startsWith("launcher.")) {
    try {
      const result = await connection.launcher.call(
        method,
        params ?? {},
        requestIsCurrent,
      );
      const paneId = (result as { pane_id?: unknown }).pane_id;
      if (typeof paneId === "string") terminalBridge.notePaneInput(ws, paneId);
      sendReply({ id, result }, method);
    } catch (e) {
      sendError(`${method}-error`, e);
    }
    return;
  }
  if (method === "worktree.create") {
    try {
      const sourceWorkspace = await sourceWorkspaceForWorktreeCreate(
        params ?? {},
      );
      const workspaceId = optionalString(params, "workspace_id") ?? "";
      const baseSync = await syncWorktreeBase({
        workspaceId,
        resolveGitRoot: async (id) =>
          resolveWorkspaceGitRoot({ workspace_id: id }),
        host: sshHost(),
        shQuote,
        runProcessWithCodeTimeout,
      });
      const result = await herdr.call(method, {
        ...(params ?? {}),
        base: baseSync.commit,
      });
      // Herdr identifies the repository but not which of several workspaces
      // for that repository initiated creation. Keep that GUI relationship.
      await worktreeParents
        .rememberWorktreeParent(result, workspaceId, requestIsCurrent)
        .catch((error) => {
          if (!requestIsCurrent()) return;
          logger.warn("unable to persist worktree parent", {
            connection: connectionId,
            error: sanitizeConnectionError(error),
          });
        });
      const hookSourceWorkspace = sourceWorkspace
        ? {
            ...sourceWorkspace,
            cwd:
              sourceWorkspace?.worktree?.checkout_path ||
              sourceWorkspace?.cwd ||
              baseSync.root,
          }
        : { cwd: baseSync.root };
      const setupHook = await runWorktreeSetupHook(result, hookSourceWorkspace);
      sendReply(
        {
          id,
          result: {
            ...result,
            base_sync: baseSync,
            setup_hook: setupHook,
          },
        },
        "worktree-create",
      );
    } catch (e) {
      sendError("worktree-create-error", e);
    }
    return;
  }
  if (method === "worktree.open") {
    try {
      const workspaceId = optionalString(params, "workspace_id") ?? "";
      const sourceWorkspace = await sourceWorkspaceForWorktreeCreate(
        params ?? {},
      );
      const result = await herdr.call(method, params ?? {});
      await worktreeParents
        .rememberWorktreeParent(result, workspaceId, requestIsCurrent)
        .catch((error) => {
          if (!requestIsCurrent()) return;
          logger.warn("unable to persist opened worktree parent", {
            connection: connectionId,
            error: sanitizeConnectionError(error),
          });
        });
      const openedHook = await runWorktreeOpenedHook(result, sourceWorkspace);
      sendReply(
        {
          id,
          result: { ...result, opened_hook: openedHook },
        },
        "worktree-open",
      );
    } catch (e) {
      sendError("worktree-open-error", e);
    }
    return;
  }
  if (method === "worktree.remove") {
    try {
      const workspaceId = optionalString(params, "workspace_id") ?? "";
      const result = await worktreeRemovalCoordinator.run(
        workspaceId,
        async () => {
          const removeHookContext = await worktreeRemoveHookContext(
            params ?? {},
          );
          const checkoutState = removeHookContext
            ? await worktreeRemovalRuntime
                .inspectCheckout(removeHookContext.checkoutPath)
                .catch(() => "unknown" as const)
            : "unknown";
          const beforeRemoveHook =
            removeHookContext && checkoutState !== "missing"
              ? await runPaseoWorktreeHook({
                  hook: "teardown",
                  checkoutPath: removeHookContext.checkoutPath,
                  sourceCheckoutPath: removeHookContext.sourceCheckoutPath,
                  repoSettingsKey: removeHookContext.repoSettingsKey,
                })
              : ({
                  event: "worktree.before_remove",
                  status: "skipped",
                } as const);
          if (beforeRemoveHook.status === "failed") {
            markRpcError(
              ws,
              id,
              beforeRemoveHook.error || "before-remove hook failed",
            );
            return {
              ok: false,
              skipped_remove: true,
              before_remove_hook: beforeRemoveHook,
            };
          }

          const removal = await removeWorktreeWithRecovery({
            call: (name, callParams) =>
              herdr.call(name, callParams, WORKTREE_REMOVE_TIMEOUT_MS),
            params: params ?? {},
            checkoutPath: removeHookContext?.checkoutPath,
            runtime: worktreeRemovalRuntime,
          });
          if (removal.cleanup?.preserved_path) {
            logger.warn("preserved stale worktree files", {
              connection: connectionId,
              path: removal.cleanup.preserved_path,
            });
          }
          if (removeHookContext?.checkoutPath) {
            await worktreeParents
              .forgetWorktree(removeHookContext.checkoutPath, requestIsCurrent)
              .catch((error) => {
                if (!requestIsCurrent()) return;
                logger.warn("unable to remove worktree parent", {
                  connection: connectionId,
                  error: sanitizeConnectionError(error),
                });
              });
          }
          const removedHook = await runWorktreeRemovedHook(removeHookContext);
          return {
            ...removal.result,
            ...(removal.cleanup ? { cleanup: removal.cleanup } : {}),
            before_remove_hook: beforeRemoveHook,
            removed_hook: removedHook,
          };
        },
      );
      sendReply({ id, result }, "worktree-remove");
    } catch (e) {
      sendError("worktree-remove-error", e);
    }
    return;
  }
  if (
    PANE_INPUT_METHODS.has(method) &&
    typeof params?.pane_id === "string" &&
    params.pane_id
  )
    terminalBridge.notePaneInput(ws, params.pane_id);
  try {
    const rawResult = await herdr.call(method, params ?? {});
    let result = rawResult;
    if (method === "integration.list") {
      result = await enrichIntegrationVersions(result, {
        sshHost: sshHost(),
        ping: () => herdr.ping(),
      });
    }
    if (method === "workspace.list") {
      result = await worktreeParents.enrichWorkspaceList(result);
      result = await enrichWorkspacesWithGitStatus(result);
      result = {
        ...result,
        navigation_mode: await terminalBridge.navigationMode(),
        endpoint_availability: terminalBridge.endpointAvailability(),
      };
    }
    if (authorization.entry.scope === "list")
      result = roles
        ? filterListResult(result, roles, scope)
        : method === "workspace.list"
          ? annotateOwnerAccess(result)
          : result;
    else if (scope && method === "pane.layout")
      result = narrowLayoutResult(result, scope);
    sendReply({ id, result }, method);
  } catch (e) {
    sendError(`${method}-error`, e);
  }
}

async function handleConnectionHttpRequest(
  route: ParsedConnectionHttpRoute,
  url: URL,
  req: Request,
): Promise<Response> {
  if (route.kind === "error") {
    return connectionRoutingErrorResponse(route.error);
  }

  let resolved: ReturnType<
    typeof resolveConnectionHttpRoute<LegacyConnectionRuntime>
  >;
  const generationText = url.searchParams.get("connection_generation");
  const requestedGeneration =
    generationText === null
      ? undefined
      : /^(0|[1-9]\d*)$/.test(generationText)
        ? Number(generationText)
        : generationText;
  try {
    resolved = resolveConnectionHttpRoute({
      route,
      requestedGeneration,
      registry: connectionManager,
      legacyLogger: legacyRoutingLogger,
    });
  } catch (error) {
    if (error instanceof ConnectionRoutingError) {
      return connectionRoutingErrorResponse(error);
    }
    return Response.json(
      { error: "connection routing failed" },
      { status: 500 },
    );
  }

  const { runtime: connection, endpoint } = resolved;
  try {
    let response: Response;
    if (endpoint === "herdr-info") {
      response = await connection.handleHerdrInfo();
    } else if (endpoint === "upload-image") {
      response = await connection.handleImageUpload(req);
    } else if (endpoint === "agent-session-download") {
      response = await connection.agentSessions.downloadFile({
        pane_id: url.searchParams.get("pane_id"),
        agent: url.searchParams.get("agent"),
      });
    } else if (endpoint === "agent-session-atif") {
      response = await connection.agentSessions.downloadAtif({
        pane_id: url.searchParams.get("pane_id"),
        agent: url.searchParams.get("agent"),
      });
    } else if (endpoint === "file-download") {
      try {
        response = await connection.files.downloadWorkspaceFile({
          workspace_id: url.searchParams.get("workspace_id"),
          path: url.searchParams.get("path"),
          scope: url.searchParams.get("scope"),
          inline: url.searchParams.get("inline") === "1",
        });
      } catch (error) {
        response = new Response((error as Error).message, { status: 400 });
      }
    } else if (endpoint === "file-upload") {
      try {
        const result = await connection.files.uploadWorkspaceFile(
          {
            workspace_id: url.searchParams.get("workspace_id"),
            directory: url.searchParams.get("directory"),
            filename: url.searchParams.get("filename"),
            scope: url.searchParams.get("scope"),
          },
          req,
        );
        response = Response.json(result);
      } catch (error) {
        response = Response.json(
          { error: (error as Error).message },
          { status: 400 },
        );
      }
    } else {
      try {
        const result = await connection.files.deleteWorkspaceFile({
          workspace_id: url.searchParams.get("workspace_id"),
          path: url.searchParams.get("path"),
          scope: url.searchParams.get("scope"),
        });
        response = Response.json(result);
      } catch (error) {
        response = Response.json(
          { error: (error as Error).message },
          { status: 400 },
        );
      }
    }
    return publishConnectionHttpResponse(resolved, response);
  } catch (error) {
    return publishConnectionHttpResponse(
      resolved,
      Response.json({ error: (error as Error).message }, { status: 500 }),
    );
  }
}

type SocketData = {
  /** Fixed at upgrade: who the socket acts for on its listener. */
  principal: Principal;
  client?: ClientContext;
  clientSession: string | null;
};

type AuthenticatedRoute = {
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

/** Routes after authentication, shared by every listener. */
async function routeAuthenticated(
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
        },
      })
    )
      return undefined;
    return new Response("websocket upgrade failed", { status: 400 });
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
  const connectionRoute = parseConnectionHttpRoute(requestPathname, req.method);
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
}

/** The policy route of an HTTP request (null: none matches) and its connection. */
function httpRoute(req: Request, url: URL, requestPathname: string) {
  const connectionRoute = parseConnectionHttpRoute(requestPathname, req.method);
  const routeId: HttpRouteId | null = connectionRoute
    ? connectionRoute.kind === "connection"
      ? connectionRouteId(connectionRoute.endpoint)
      : "connection.invalid"
    : matchHttpRoute(req.method, url.pathname);
  const connectionId =
    connectionRoute?.kind === "connection"
      ? (connectionRoute.requestedConnectionId ?? connectionManager.defaultId())
      : null;
  return { routeId, connectionId };
}

/** Deny by default: a request no HTTP_POLICY route matches. */
function unmatchedRoute(url: URL): Response {
  return url.pathname.startsWith("/api/")
    ? Response.json({ error: "not found" }, { status: 404 })
    : new Response("method not allowed", { status: 405 });
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
  logger.warn("rejected unauthorized request", {
    route: route.routeId,
    reason: decision.message,
  });
  return Response.json(
    { error: decision.message },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
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
  const route = httpRoute(req, url, requestPathname);
  const originMode = originCheckMode(url.pathname, req.method);
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

  // Direct local use, the session cookie, or tailnet login. Bearer MCP,
  // icons, the login script, logout, share links and tailnet sign-in (which
  // runs `whois` itself) never start a session.
  const auth: AuthResult =
    routeId === "mcp" ||
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
  // MCP authenticates with its own bearer tokens, never the cookie.
  if (routeId === "mcp") {
    server.timeout(req, 60);
    return mcp.handle(req, access.clientAddress ?? peer);
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
 * API, MCP and WebSocket request with 401.
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
    : publicRequests.take(access.clientAddress ?? "unknown");
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
  const originMode = originCheckMode(url.pathname, req.method);
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
  // MCP agents use bearer tokens on the private listener only.
  if (url.pathname === "/mcp") {
    return new Response("not found", { status: 404 });
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

const websocketHandlers: WebSocketHandler<SocketData> = {
  perMessageDeflate: WS_PER_MESSAGE_DEFLATE,
  open(ws) {
    clients.add(ws);
    socketPrincipals.set(ws, ws.data.principal);
    clientIdentity.attach(ws, ws.data.client);
    const participantId = clientIdentity.participantId(
      ws,
      ws.data.clientSession,
    );
    participantIds.set(ws, participantId);
    participantPrincipals.set(participantId, ws.data.principal.key);
    const label = assignClientId(ws);
    logger.debug("client connected", {
      client: label,
      clients: clients.size,
    });
    notifyBrowserClientCount();
    safeSend(
      ws,
      JSON.stringify({
        hello: true,
        ...(isInstanceAdmin(ws.data.principal)
          ? { socket: config.socketPath }
          : {}),
        principal: principalView(ws.data.principal),
        bridge_protocol_version: 2,
        ...(webEntry ? { web_entry: webEntry } : {}),
        default_connection_id: connectionManager.defaultId(),
        participant_id: participantId,
        capabilities: {
          connection_id: true,
          connection_scoped_http: true,
          connection_runtime_generation: true,
        },
      }),
      "hello",
    );
  },
  drain(ws) {
    // The viewer caught up: send the newest repaint we held back.
    flushCoalescedMessages(ws, {
      cleanup: () => {
        webSocketCleanup.cleanup(ws);
      },
      warn: (detail) =>
        logger.warn("websocket send failed", {
          detail: detail.replace(/^\[bridge\] /, ""),
        }),
    });
  },
  message(ws, message) {
    if (!clients.has(ws)) return;
    const text = typeof message === "string" ? message : message.toString();
    const { id, method, connectionId, connectionGeneration } =
      parseRpcMeta(text);
    const startedAt = Date.now();
    let responseConnectionId: string | null = null;
    let logConnectionId: string | null = null;
    if (method && !isBridgeGlobalMethod(method)) {
      if (connectionId === undefined) {
        responseConnectionId = connectionManager.defaultId();
        logConnectionId = responseConnectionId;
      } else {
        try {
          responseConnectionId = validateConnectionId(connectionId);
          logConnectionId = responseConnectionId;
        } catch {
          logConnectionId = "invalid";
        }
      }
    }
    handleRpc(ws, text)
      .then(() => {
        const outcome = takeRpcOutcome(ws, id);
        logRpc(
          ws,
          method,
          startedAt,
          outcome?.status ?? "ok",
          logConnectionId,
          outcome?.detail,
        );
      })
      .catch((e) => {
        logRpc(
          ws,
          method,
          startedAt,
          "error",
          logConnectionId,
          (e as Error).message,
        );
        const errorMessage: Record<string, unknown> = {
          error: { message: (e as Error).message },
        };
        if (id) errorMessage.id = id;
        safeSend(
          ws,
          responseConnectionId
            ? serializeConnectionEnvelope(
                responseConnectionId,
                errorMessage,
                typeof connectionGeneration === "number"
                  ? connectionGeneration
                  : undefined,
              )
            : JSON.stringify(errorMessage),
          "message-error",
        );
      });
  },
  close(ws) {
    const { client, viewedTerminals } = webSocketCleanup.complete(ws);
    logger.debug("client disconnected", {
      client,
      clients: clients.size,
      terminals: viewedTerminals.length ? viewedTerminals.join(",") : "none",
    });
  },
};

let publicServer: Server<SocketData> | null = null;

function main() {
  const server = bindListenerBeforeConnectionStart({
    bindListener: () => {
      const primary = Bun.serve<SocketData>({
        port: config.port,
        hostname: config.host,
        tls: config.tls,
        fetch: primaryFetch,
        websocket: websocketHandlers,
      });
      if (publicListener) {
        try {
          // Plain HTTP on loopback; cloudflared terminates TLS at the edge.
          publicServer = Bun.serve<SocketData>({
            port: publicListener.port,
            hostname: publicListener.hostname,
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
      await connectionProfiles.startConfigured();
      notifyBrowserClientCount();
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

let managerStopTask: Promise<void> | null = null;
function stopManagerOnce(): Promise<void> {
  webPush.stop();
  connectionProfiles.stopSupervision();
  managerStopTask ??= connectionManager.stopAll();
  return managerStopTask;
}

const shutdownController = createShutdownController({
  stop: stopManagerOnce,
  exit: (code) => process.exit(code),
  onStopError: (error) => {
    logger.error("connection shutdown failed", {
      error: sanitizeConnectionError(error),
    });
  },
});

function scheduleManagedShutdown(): void {
  const timer = setTimeout(() => {
    void shutdownController.request(0);
  }, 1_000);
  timer.unref();
}

process.on("exit", () => {
  void stopManagerOnce();
});
process.on("SIGINT", () => {
  void shutdownController.request(130);
});
process.on("SIGTERM", () => {
  void shutdownController.request(143);
});

try {
  main();
} catch (e) {
  logger.error("fatal startup error", { error: e });
  void shutdownController.request(1);
}
