import type { WorkspaceRole } from "../accounts/store";
import { isInstanceAdmin, type Principal } from "../auth/principal";
import { isPublicStaticAsset } from "../http/public-auth";
import { type AuthzDeps, authorizeTarget } from "./authorize";
import type { RpcClass, RpcTarget } from "./policy";
import { targetResolvers } from "./policy";

/**
 * Deny-by-default authorization table for HTTP routes, the counterpart of
 * `RPC_POLICY`. `matchHttpRoute` maps a request to a route id; a request
 * that matches nothing is refused. Scopes:
 *
 * - `public`: no login (health, login and enrollment, logout, the login
 *   page's icons, fingerprinted assets, share-link pages and redemption,
 *   and tailnet sign-in).
 * - `session`: any logged-in principal; the handler acts on its own data.
 *   Share-link guests reach only the routes marked `guest`.
 * - `workspace`: `resolve` names the target from the query string; the caller
 *   needs `minimum` there.
 * - `connection`: an editor of at least one workspace on the connection.
 * - `editor`: an editor of at least one workspace anywhere (server-side
 *   services with the owner's credentials, such as voice recognition).
 * - `host`: instance admins only.
 */

export type HttpScope =
  | "public"
  | "session"
  | "workspace"
  | "connection"
  | "editor"
  | "host";

export type HttpPolicyEntry = {
  class: RpcClass;
  scope: HttpScope;
  minimum?: WorkspaceRole;
  resolve?: (query: URLSearchParams) => RpcTarget;
  /** A `session` route share-link guests may use (default: denied). */
  guest?: true;
};

const fromQuery =
  (resolve: (params: Record<string, unknown>) => RpcTarget) =>
  (query: URLSearchParams): RpcTarget =>
    resolve(Object.fromEntries(query));

export const HTTP_POLICY = {
  health: { class: "read", scope: "public" },
  "login.page": { class: "read", scope: "public" },
  "enroll.page": { class: "read", scope: "public" },
  // The login and enrollment pages' script (no inline scripts under CSP).
  "login.script": { class: "read", scope: "public" },
  "login.icon": { class: "read", scope: "public" },
  "passkey.login": { class: "write", scope: "public" },
  // Needs a session or an enrollment secret, checked by the handler.
  "passkey.register": { class: "write", scope: "public" },
  logout: { class: "write", scope: "public" },
  // The share-link landing page and redemption (rate-limited); the secret
  // stays in the URL fragment until the page posts it.
  "share.page": { class: "read", scope: "public" },
  "share.redeem": { class: "write", scope: "public" },
  // Tailnet sign-in (auth/tailnet-sso.ts). The tailnet listener issues a
  // single-use code to a Tailscale-identified caller (`code`: CORS for the
  // public origin only; `authorize`: the redirect flow); the public listener
  // starts the redirect flow, redeems codes for sessions, and tells the login
  // page where the tailnet listener is (`config`) so its HTML never names it.
  "sso.code": { class: "write", scope: "public" },
  "sso.authorize": { class: "write", scope: "public" },
  "sso.config": { class: "read", scope: "public" },
  "sso.start": { class: "read", scope: "public" },
  "sso.callback": { class: "write", scope: "public" },
  "sso.redeem": { class: "write", scope: "public" },
  // Optional sign-in providers (auth/sign-in-routes.ts): email codes and
  // links, GitHub and Google, and invitation links. Rate-limited per client;
  // POSTs need this origin's Origin header.
  "email.start": { class: "write", scope: "public" },
  "email.verify": { class: "write", scope: "public" },
  "email.page": { class: "read", scope: "public" },
  "oauth.start": { class: "write", scope: "public" },
  "oauth.callback": { class: "write", scope: "public" },
  "oauth.poll": { class: "write", scope: "public" },
  "oauth.confirm": { class: "write", scope: "public" },
  "invite.page": { class: "read", scope: "public" },
  "invite.check": { class: "read", scope: "public" },
  "invite.accept": { class: "write", scope: "public" },

  "auth.me": { class: "read", scope: "session", guest: true },
  "auth.sessions": { class: "read", scope: "session" },
  "auth.sessions.revoke": { class: "write", scope: "session" },
  "auth.passkeys": { class: "read", scope: "session" },
  "auth.passkeys.remove": { class: "write", scope: "session" },
  // The account page (auth/account-routes.ts): profile, avatar, sign-in
  // methods and other sessions of the caller's own account.
  "auth.passkeys.rename": { class: "write", scope: "session" },
  "auth.methods": { class: "read", scope: "session" },
  "auth.profile": { class: "write", scope: "session" },
  "auth.avatar": { class: "write", scope: "session" },
  "auth.avatar.remove": { class: "write", scope: "session" },
  "auth.avatar.source": { class: "read", scope: "session" },
  "auth.identities.remove": { class: "write", scope: "session" },
  "auth.email.add": { class: "write", scope: "session" },
  "auth.email.confirm": { class: "write", scope: "session" },
  "auth.sessions.revoke_others": { class: "write", scope: "session" },
  // Profile pictures shown in presence, including to share-link guests.
  "avatar.file": { class: "read", scope: "session", guest: true },
  // Workspace owners (and admins) invite people by email.
  "invites.create": {
    class: "write",
    scope: "workspace",
    minimum: "owner",
    resolve: fromQuery(targetResolvers.workspace),
  },
  // Workspace owners (and admins) read and change a workspace's grants.
  "grants.list": {
    class: "read",
    scope: "workspace",
    minimum: "owner",
    resolve: fromQuery(targetResolvers.workspace),
  },
  "grants.set": {
    class: "write",
    scope: "workspace",
    minimum: "owner",
    resolve: fromQuery(targetResolvers.workspace),
  },
  // Workspace owners (and admins) list, create and revoke share links.
  "share.list": {
    class: "read",
    scope: "workspace",
    minimum: "owner",
    resolve: fromQuery(targetResolvers.workspace),
  },
  "share.create": {
    class: "write",
    scope: "workspace",
    minimum: "owner",
    resolve: fromQuery(targetResolvers.workspace),
  },
  "share.revoke": {
    class: "write",
    scope: "workspace",
    minimum: "owner",
    resolve: fromQuery(targetResolvers.workspace),
  },

  ws: { class: "read", scope: "session", guest: true },
  "api.health": { class: "read", scope: "session", guest: true },
  push: { class: "write", scope: "session" },
  "voice.status": { class: "read", scope: "session" },
  // Cloud recognition and cleanup spend the owner's provider credentials.
  "voice.transcribe": { class: "write", scope: "editor" },
  "voice.cleanup": { class: "write", scope: "editor" },
  "update.check": { class: "admin", scope: "host" },
  "update.install": { class: "dangerous", scope: "host" },
  "herdr.status": { class: "admin", scope: "host" },
  "herdr.setup": { class: "dangerous", scope: "host" },

  "connection.herdr-info": { class: "read", scope: "session" },
  // A malformed connection route: log in first, then see the routing error.
  "connection.invalid": { class: "read", scope: "session", guest: true },
  // Writes the image to the host's temporary directory for pasting.
  "connection.upload-image": { class: "write", scope: "connection" },
  "connection.file-download": {
    class: "read",
    scope: "workspace",
    resolve: fromQuery(targetResolvers.files),
  },
  "connection.file-upload": {
    class: "write",
    scope: "workspace",
    resolve: fromQuery(targetResolvers.files),
  },
  "connection.file-delete": {
    class: "write",
    scope: "workspace",
    resolve: fromQuery(targetResolvers.files),
  },
  // Fingerprinted bundles, font slices, icons and the web manifest: public
  // open-source files, the same for everyone, never starting a session.
  "static.asset": { class: "read", scope: "public" },
  // The application shell (entry document, service worker, asset list).
  static: { class: "read", scope: "session", guest: true },
} as const satisfies Record<string, HttpPolicyEntry>;

export type HttpRouteId = keyof typeof HTTP_POLICY;

const EXACT: Record<string, Partial<Record<string, HttpRouteId>>> = {
  "/health": { GET: "health", HEAD: "health" },
  "/healthz": { GET: "health", HEAD: "health" },
  "/login": { GET: "login.page", HEAD: "login.page" },
  "/enroll": { GET: "enroll.page", HEAD: "enroll.page" },
  "/auth/passkey.js": { GET: "login.script", HEAD: "login.script" },
  "/thyra-icon-192.png": { GET: "login.icon", HEAD: "login.icon" },
  "/thyra-icon.svg": { GET: "login.icon", HEAD: "login.icon" },
  "/auth/tailnet-sso/code": { POST: "sso.code", OPTIONS: "sso.code" },
  "/auth/tailnet-sso/authorize": { GET: "sso.authorize" },
  "/auth/tailnet-sso/config": { GET: "sso.config" },
  "/auth/tailnet-sso/start": { GET: "sso.start" },
  "/auth/tailnet-sso/callback": { GET: "sso.callback" },
  "/auth/tailnet-sso/redeem": { POST: "sso.redeem" },
  "/auth/email/start": { POST: "email.start" },
  "/auth/email/verify": { POST: "email.verify" },
  "/auth/email": { GET: "email.page", HEAD: "email.page" },
  "/auth/oauth/poll": { POST: "oauth.poll" },
  "/auth/oauth/confirm": { POST: "oauth.confirm" },
  "/invite": { GET: "invite.page", HEAD: "invite.page" },
  "/auth/invite/check": { POST: "invite.check" },
  "/auth/invite/accept": { POST: "invite.accept" },
  "/api/auth/methods": { GET: "auth.methods" },
  "/api/auth/profile": { POST: "auth.profile" },
  "/api/auth/avatar": { POST: "auth.avatar" },
  "/api/auth/avatar/remove": { POST: "auth.avatar.remove" },
  "/api/auth/avatar/source": { GET: "auth.avatar.source" },
  "/api/auth/identities/remove": { POST: "auth.identities.remove" },
  "/api/auth/email/add": { POST: "auth.email.add" },
  "/api/auth/email/confirm": { POST: "auth.email.confirm" },
  "/api/auth/passkeys/rename": { POST: "auth.passkeys.rename" },
  "/api/auth/sessions/revoke-others": { POST: "auth.sessions.revoke_others" },
  "/api/invites": { POST: "invites.create" },
  "/api/auth/passkey/login/options": { POST: "passkey.login" },
  "/api/auth/passkey/login/verify": { POST: "passkey.login" },
  "/api/auth/passkey/register/options": { POST: "passkey.register" },
  "/api/auth/passkey/register/verify": { POST: "passkey.register" },
  "/api/logout": { POST: "logout" },
  "/api/auth/me": { GET: "auth.me" },
  "/api/auth/sessions": { GET: "auth.sessions" },
  "/api/auth/sessions/revoke": { POST: "auth.sessions.revoke" },
  "/api/auth/passkeys": { GET: "auth.passkeys" },
  "/api/auth/passkeys/remove": { POST: "auth.passkeys.remove" },
  "/api/workspace-grants": { GET: "grants.list", POST: "grants.set" },
  "/api/share-links": { GET: "share.list", POST: "share.create" },
  "/api/share-links/revoke": { POST: "share.revoke" },
  "/api/share/redeem": { POST: "share.redeem" },
  "/ws": { GET: "ws" },
  "/api/health": { GET: "api.health" },
  "/api/notifications/push": { GET: "push", POST: "push", DELETE: "push" },
  "/api/voice/status": { GET: "voice.status" },
  "/api/voice/transcribe": { POST: "voice.transcribe" },
  "/api/voice/cleanup": { POST: "voice.cleanup" },
  "/api/update/check": { GET: "update.check" },
  "/api/update/install": { POST: "update.install" },
  "/api/herdr/status": { GET: "herdr.status" },
  "/api/herdr/setup": { POST: "herdr.setup" },
};

/** GitHub and Google sign-in: start (POST) and the provider's return (GET). */
const OAUTH_PATH = /^\/auth\/oauth\/(?:github|google)\/(start|callback)$/;
/** An uploaded profile picture, named by its content hash. */
const AVATAR_PATH = /^\/avatars\/[0-9a-f]{64}\.(?:webp|jpg)$/;

/** A share link's landing page, `/s/<id>` (the secret is in the fragment). */
const SHARE_PAGE_PATH = /^\/s\/[A-Za-z0-9_-]{8,32}$/;

/** Connection-scoped endpoint names from `connections/http-routing.ts`. */
export function connectionRouteId(endpoint: string): HttpRouteId | null {
  const id = `connection.${endpoint}`;
  return Object.hasOwn(HTTP_POLICY, id) ? (id as HttpRouteId) : null;
}

/**
 * The route id for a method and path outside the connection-scoped API.
 * Unknown `/api/` paths match nothing; other GET/HEAD paths are public
 * static assets or the application shell.
 */
export function matchHttpRoute(
  method: string,
  pathname: string,
): HttpRouteId | null {
  const exact = Object.hasOwn(EXACT, pathname) ? EXACT[pathname] : undefined;
  if (exact) return exact[method] ?? null;
  const oauth = OAUTH_PATH.exec(pathname);
  if (oauth)
    return oauth[1] === "start"
      ? method === "POST"
        ? "oauth.start"
        : null
      : method === "GET"
        ? "oauth.callback"
        : null;
  if (pathname.startsWith("/avatars/"))
    return AVATAR_PATH.test(pathname) && (method === "GET" || method === "HEAD")
      ? "avatar.file"
      : null;
  if (pathname === "/s" || pathname.startsWith("/s/"))
    return SHARE_PAGE_PATH.test(pathname) &&
      (method === "GET" || method === "HEAD")
      ? "share.page"
      : null;
  if (pathname === "/api" || pathname.startsWith("/api/")) return null;
  if (method !== "GET" && method !== "HEAD") return null;
  return isPublicStaticAsset(pathname) ? "static.asset" : "static";
}

export type HttpAuthorization =
  | { ok: true }
  | { ok: false; status: 401 | 403; message: string };

/** Apply `HTTP_POLICY` to a matched route for a (possibly absent) principal. */
export async function authorizeHttp(args: {
  route: HttpRouteId;
  principal: Principal | null;
  connectionId: string | null;
  query: URLSearchParams;
  deps: AuthzDeps;
  /** Whether the principal edits a workspace on the connection (null: any). */
  editsConnection: (
    principal: Principal,
    connectionId: string | null,
  ) => boolean;
}): Promise<HttpAuthorization> {
  const entry: HttpPolicyEntry = HTTP_POLICY[args.route];
  if (entry.scope === "public") return { ok: true };
  const principal = args.principal;
  if (!principal) return { ok: false, status: 401, message: "unauthorized" };
  if (principal.kind === "guest" && entry.scope === "session" && !entry.guest)
    return {
      ok: false,
      status: 403,
      message: "this is not available through a share link",
    };
  const admin = isInstanceAdmin(principal);
  if (
    entry.class === "admin" ||
    entry.class === "dangerous" ||
    entry.scope === "host"
  )
    return admin
      ? { ok: true }
      : { ok: false, status: 403, message: "this needs an instance admin" };
  if (entry.scope === "session") return { ok: true };
  if (entry.scope === "connection" || entry.scope === "editor") {
    const connectionId = entry.scope === "editor" ? null : args.connectionId;
    return admin ||
      ((entry.scope === "editor" || connectionId !== null) &&
        args.editsConnection(principal, connectionId))
      ? { ok: true }
      : { ok: false, status: 403, message: "this needs the editor role" };
  }
  const decision = await authorizeTarget({
    principal,
    // Connection routes name it in the path; others in the query string.
    connectionId: args.connectionId ?? args.query.get("connection_id"),
    target: entry.resolve?.(args.query) ?? {},
    minimum: entry.minimum ?? (entry.class === "read" ? "viewer" : "editor"),
    deps: args.deps,
  });
  return decision.ok
    ? { ok: true }
    : { ok: false, status: 403, message: decision.message };
}
