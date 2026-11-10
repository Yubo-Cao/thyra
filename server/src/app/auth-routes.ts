import { createAccountRoutes } from "../auth/account-routes";
import { createAdminRoutes } from "../auth/admin-routes";
import { createPublicAuthenticator } from "../auth/public";
import { createAuthRoutes } from "../auth/routes";
import { createShareRoutes } from "../auth/share-routes";
import { createSignInRoutes } from "../auth/sign-in-routes";
import type { ClientRegistry } from "../bridge/client-registry";
import type { ConnectionProfileService } from "../connections/profile-service";
import { createLoginRateLimiter } from "../http/login-rate-limit";
import type { PublicAuthenticator } from "../http/public-auth";
import type { RequestAccess } from "../http/request-access";
import type { AccountServices } from "./accounts";
import type { ServerBootstrap } from "./bootstrap";
import type { LiveSessions } from "./live-sessions";

export type ListenerAuthRoutes = ReturnType<typeof createListenerAuthRoutes>;

/**
 * The login, account, admin and share routes of each listener.
 *
 * Connection profiles are created later and read per request.
 */
export function createListenerAuthRoutes(deps: {
  bootstrap: ServerBootstrap;
  registry: ClientRegistry;
  accounts: AccountServices;
  sessions: LiveSessions;
  connectionProfiles: () => ConnectionProfileService;
}) {
  const { logger, publicListener, publicLoginLimiter } = deps.bootstrap;
  const { closeSockets } = deps.registry;
  const {
    clientIdentity,
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
    tailnetSso,
  } = deps.accounts;
  const { closeGuestSockets, checkLiveSessions } = deps.sessions;

  function accountRoutes(
    listenerAuthenticator: typeof authenticator,
    limiter: ReturnType<typeof createLoginRateLimiter>,
  ) {
    const connectionExists = (connectionId: string) =>
      deps
        .connectionProfiles()
        .list()
        .some((profile) => profile.id === connectionId);
    const onChange = () => {
      accessControl.invalidate();
      checkLiveSessions();
    };
    // Invitations point at the public address when there is one.
    const inviteOrigin = (access: RequestAccess) =>
      publicListener?.origin ?? access.ownOrigin;
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
      signIn: createSignInRoutes({
        store: accountStore,
        authenticator: listenerAuthenticator,
        providers: authProviders,
        mailer,
        codes: emailCodes,
        flows: oauthFlows,
        invites,
        signedInCookies: (access) =>
          access.listener === "public" && tailnetSso
            ? [tailnetSso.signedOutCookie(false)]
            : [],
        onChange,
        logger: logger.child("auth"),
      }),
      account: createAccountRoutes({
        store: accountStore,
        providers: authProviders,
        mailer,
        codes: emailCodes,
        invites,
        avatars: avatarFiles,
        inviteOrigin,
        connectionExists,
        onChange,
        onSessionEnded: (idHash) =>
          closeSockets(
            (principal) =>
              principal.kind === "user" && principal.session.idHash === idHash,
            4001,
            "Logged out",
          ),
        // Pages reconnect and announce the new name and picture.
        onProfileChanged: (userId, change) => {
          if (change.name) clientIdentity.clearCustomName(`user:${userId}`);
          closeSockets(
            (principal) =>
              principal.kind === "user" && principal.user.id === userId,
            4003,
            "Profile changed",
          );
        },
        logger: logger.child("auth"),
      }),
      admin: createAdminRoutes({
        store: accountStore,
        invites,
        mailer,
        inviteOrigin,
        onChange,
        logger: logger.child("admin"),
      }),
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

  const authRoutes = accountRoutes(authenticator, createLoginRateLimiter());
  const publicRoutes = accountRoutes(publicAuthenticator, publicLoginLimiter);
  /** Accounts and passkeys on the public listener. */
  const publicAuth: PublicAuthenticator = createPublicAuthenticator({
    authenticator: publicAuthenticator,
    routes: publicRoutes,
  });

  return { authRoutes, publicRoutes, publicAuth };
}
