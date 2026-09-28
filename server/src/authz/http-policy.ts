import type { WorkspaceRole } from "../accounts/store";
import { isInstanceAdmin, type Principal } from "../auth/principal";
import { type AuthzDeps, authorizeTarget } from "./authorize";
import type { RpcClass, RpcTarget } from "./policy";
import { targetResolvers } from "./policy";

/**
 * Deny-by-default authorization table for HTTP routes, the counterpart of
 * `RPC_POLICY`. `matchHttpRoute` maps a request to a route id; a request
 * that matches nothing is refused. Scopes:
 *
 * - `public`: no login (health, login and enrollment, logout, the login
 *   page's icons, share-link pages and redemption, tailnet sign-in, and
 *   `/mcp`, which
 *   authenticates with its own bearer tokens).
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
  mcp: { class: "read", scope: "public" },
  // The share-link landing page and redemption (rate-limited); the secret
  // stays in the URL fragment until the page posts it.
  "share.page": { class: "read", scope: "public" },
  "share.redeem": { class: "write", scope: "public" },
  // Tailnet sign-in (auth/tailnet-sso.ts). The tailnet listener issues a
  // single-use code to a Tailscale-identified caller (`code`: CORS for the
  // public origin only; `authorize`: the redirect flow); the public listener
  // starts the redirect flow and redeems codes for sessions.
  "sso.code": { class: "write", scope: "public" },
  "sso.authorize": { class: "write", scope: "public" },
  "sso.start": { class: "read", scope: "public" },
  "sso.callback": { class: "write", scope: "public" },
  "sso.redeem": { class: "write", scope: "public" },

  "auth.me": { class: "read", scope: "session", guest: true },
  "auth.sessions": { class: "read", scope: "session" },
  "auth.sessions.revoke": { class: "write", scope: "session" },
  "auth.passkeys": { class: "read", scope: "session" },
  "auth.passkeys.remove": { class: "write", scope: "session" },
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
  "connection.agent-session-download": {
    class: "read",
    scope: "workspace",
    resolve: fromQuery(targetResolvers.pane),
  },
  "connection.agent-session-atif": {
    class: "read",
    scope: "workspace",
    resolve: fromQuery(targetResolvers.pane),
  },
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
  // The application shell and its assets.
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
  "/auth/tailnet-sso/start": { GET: "sso.start" },
  "/auth/tailnet-sso/callback": { GET: "sso.callback" },
  "/auth/tailnet-sso/redeem": { POST: "sso.redeem" },
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

/** A share link's landing page, `/s/<id>` (the secret is in the fragment). */
const SHARE_PAGE_PATH = /^\/s\/[A-Za-z0-9_-]{8,32}$/;

/** Connection-scoped endpoint names from `connections/http-routing.ts`. */
export function connectionRouteId(endpoint: string): HttpRouteId | null {
  const id = `connection.${endpoint}`;
  return Object.hasOwn(HTTP_POLICY, id) ? (id as HttpRouteId) : null;
}

/**
 * The route id for a method and path outside the connection-scoped API.
 * Unknown `/api/` paths and `/mcp` subpaths match nothing; other GET/HEAD
 * paths are the application shell and its static assets.
 */
export function matchHttpRoute(
  method: string,
  pathname: string,
): HttpRouteId | null {
  const exact = Object.hasOwn(EXACT, pathname) ? EXACT[pathname] : undefined;
  if (exact) return exact[method] ?? null;
  if (pathname === "/mcp") return "mcp";
  if (pathname === "/s" || pathname.startsWith("/s/"))
    return SHARE_PAGE_PATH.test(pathname) &&
      (method === "GET" || method === "HEAD")
      ? "share.page"
      : null;
  if (pathname === "/api" || pathname.startsWith("/api/")) return null;
  if (pathname.startsWith("/mcp/")) return null;
  return method === "GET" || method === "HEAD" ? "static" : null;
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
