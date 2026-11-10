import type { ServerWebSocket } from "bun";
import { dirname, join } from "node:path";
import { createAvatarFiles } from "../accounts/avatars";
import { defaultDatabasePath, openAccountDatabase } from "../accounts/database";
import {
  createShareLinkStore,
  type ShareLinkStore,
} from "../accounts/share-links";
import { type AccountStore, createAccountStore } from "../accounts/store";
import { createAccessControl } from "../auth/access";
import { createEmailCodeStore, createResendMailer } from "../auth/email";
import { createOAuthFlowStore } from "../auth/oauth";
import { createPasskeyService } from "../auth/passkeys";
import { createAuthenticator } from "../auth/principal";
import { loadAuthProviders, providerEnvironment } from "../auth/providers";
import { createInviteStore } from "../auth/sign-in";
import { createSsoCodeStore, createTailnetSso } from "../auth/tailnet-sso";
import type { AuthzDeps } from "../authz/authorize";
import type { ClientRegistry } from "../bridge/client-registry";
import { thyraEnv } from "../config/environment";
import { EXIT_NEEDS_OPERATOR } from "../config/service-definitions";
import type { ConnectionManager } from "../connections/manager";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import { type ListenerKind, primaryListenerKind } from "../http/listener";
import { parseTailnetAuthMode } from "../http/tailnet-auth";
import { createIdentityServiceFromEnv } from "../identity/from-env";
import { createMessageBoard } from "../message-board/service";
import type { ServerBootstrap } from "./bootstrap";

export type AccountServices = ReturnType<typeof createAccountServices>;

/**
 * Identity, the account database and everything that signs people in: both
 * listeners' authenticators, access control and the sign-in stores. An
 * unreadable account database stops the process here.
 *
 * The connection manager is created later and read per authorization.
 */
export function createAccountServices(deps: {
  bootstrap: ServerBootstrap;
  registry: ClientRegistry;
  connectionManager: () => ConnectionManager<LegacyConnectionRuntime>;
}) {
  const { config, logger, publicListener, tailnetSsoOrigin } = deps.bootstrap;
  const { clients, socketPrincipals, participantPrincipals, safeSend } =
    deps.registry;
  const clientIdentity = createIdentityServiceFromEnv<ServerWebSocket<unknown>>(
    {
      secureCookies: Boolean(config.tls),
      // Pictures of people without an account, beside the accounts' pictures.
      avatars: {
        save: (bytes, image) => avatarFiles.save(bytes, image),
        remove: (name) => avatarFiles.remove(name),
      },
      logger: logger.child("identity"),
    },
  );
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

  let messageBoard: ReturnType<typeof createMessageBoard>;
  let accountStore: AccountStore;
  let shareLinks: ShareLinkStore;
  try {
    const accountDatabase = openAccountDatabase(defaultDatabasePath());
    accountStore = createAccountStore(accountDatabase);
    messageBoard = createMessageBoard(accountDatabase, (owner, id, event) => {
      for (const client of clients)
        if (socketPrincipals.get(client)?.key === owner)
          safeSend(
            client,
            JSON.stringify({ type: `message_board.${event}`, message_id: id }),
            "message-board",
          );
    });
    accountStore.pruneExpired();
    shareLinks = createShareLinkStore(accountStore);
    shareLinks.pruneExpired();
  } catch (error) {
    // Restarting cannot fix this, so the service manager is told not to.
    const path = (() => {
      try {
        return defaultDatabasePath();
      } catch {
        return "(invalid THYRA_DB_PATH)";
      }
    })();
    logger.error("cannot open the account database; Thyra will not start", {
      path,
      error: (error as Error).message,
      fix: "back up the file, repair the reported schema problem or restore a backup, then start Thyra again",
    });
    process.exit(EXIT_NEEDS_OPERATOR);
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
  const authzDeps: AuthzDeps = {
    roleOn: accessControl.roleOn,
    locate: async (connectionId, target) =>
      (await deps
        .connectionManager()
        .readyRuntime(connectionId)
        ?.topology.locate(target)) ?? null,
    claimOf: (connectionId, paneId) =>
      deps.connectionManager().readyRuntime(connectionId)?.claims.get(paneId) ??
      null,
    principalOfParticipant: (participantId) =>
      participantPrincipals.get(participantId) ?? null,
  };
  const passkeys = createPasskeyService({ store: accountStore });
  // Optional sign-in providers, each on only when its variables are set.
  const providerEnv = providerEnvironment(process.env);
  const authProviders = loadAuthProviders(providerEnv.env);
  for (const warning of [...providerEnv.warnings, ...authProviders.warnings])
    logger.warn(warning);
  const mailer = authProviders.email
    ? createResendMailer(authProviders.email)
    : null;
  const emailCodes = createEmailCodeStore(accountStore);
  const oauthFlows = createOAuthFlowStore(accountStore);
  const invites = createInviteStore(accountStore);
  const avatarFiles = createAvatarFiles(
    join(dirname(defaultDatabasePath()), "avatars"),
    {
      inUse: (name) =>
        accountStore.avatarInUse(name) || clientIdentity.avatarInUse(name),
    },
  );
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
  return {
    clientIdentity,
    tailnetAuth,
    primaryKind,
    messageBoard,
    accountStore,
    shareLinks,
    authenticator,
    publicAuthenticator,
    accessControl,
    authzDeps,
    passkeys,
    authProviders,
    mailer,
    emailCodes,
    oauthFlows,
    invites,
    avatarFiles,
    tailnetSsoCodes,
    tailnetSso,
  };
}
