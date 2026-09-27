import {
  type AccountStore,
  isWorkspaceRole,
  type SessionRecord,
  type User,
} from "../accounts/store";
import { type AuthzDeps, authorizeTarget } from "../authz/authorize";
import type { HttpRouteId } from "../authz/http-policy";
import {
  type LoginRateLimiter,
  tooManyAttemptsResponse,
} from "../http/login-rate-limit";
import type { RequestAccess } from "../http/request-access";
import { HTML_SECURITY_HEADERS } from "../http/security-headers";
import { type Logger, silentLogger } from "../utils/logger";
import type { ShareLinkStore } from "../accounts/share-links";
import {
  AUTH_SCRIPT,
  type PageLocale,
  pageLocale,
  renderEnrollPage,
  renderLoginPage,
  renderShareEndedPage,
} from "./pages";
import type { ShareRoutes } from "./share-routes";
import { PasskeyError, type PasskeyService, passkeyOrigin } from "./passkeys";
import {
  type Authenticator,
  isInstanceAdmin,
  type Principal,
  principalView,
} from "./principal";

const MAX_BODY_BYTES = 64 * 1024;
const NO_STORE = { "cache-control": "no-store" };

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (
    req.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new PasskeyError("expected a JSON request", 415);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES)
    throw new PasskeyError("request too large", 413);
  if (!text) return {};
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PasskeyError("expected a JSON object");
  return value as Record<string, unknown>;
}

function sessionView(
  session: SessionRecord,
  current: string | null,
  user?: User | null,
) {
  return {
    id: session.publicId,
    auth_method: session.authMethod,
    user_agent: session.userAgent,
    created_at: session.createdAt,
    last_seen_at: session.lastSeenAt,
    expires_at: session.expiresAt,
    current: session.publicId === current,
    ...(user ? { user: { id: user.id, name: user.name } } : {}),
  };
}

function actorOf(principal: Principal | null): string | null {
  if (!principal) return null;
  if (principal.kind === "local") return "local";
  return principal.kind === "user" ? principal.user.id : principal.key;
}

export type AuthRoutes = ReturnType<typeof createAuthRoutes>;

export function createAuthRoutes(args: {
  store: AccountStore;
  authenticator: Authenticator;
  passkeys: PasskeyService;
  limiter: LoginRateLimiter;
  authzDeps: AuthzDeps;
  /** Known connection ids, for grant requests. */
  connectionExists: (connectionId: string) => boolean;
  /** Account data changed in this process. */
  onChange: () => void;
  /** A session ended by logout or revocation. */
  onSessionEnded: (idHash: string) => void;
  /** Share links: guest sessions, and the routes that manage links. */
  shares?: ShareLinkStore;
  shareRoutes?: ShareRoutes;
  /** Guest sessions that ended (the guest left). */
  onGuestsEnded?: (idHashes: string[]) => void;
  logger?: Logger;
}) {
  const logger = args.logger ?? silentLogger;

  function htmlPage(req: Request, render: (locale: PageLocale) => string) {
    return new Response(
      render(pageLocale(req.headers.get("accept-language"))),
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...NO_STORE,
          ...HTML_SECURITY_HEADERS,
          vary: "Accept-Language",
        },
      },
    );
  }

  function limited(access: RequestAccess): Response | null {
    const retry = args.limiter.retryAfterSeconds(
      access.clientAddress ?? "unknown",
    );
    return retry ? tooManyAttemptsResponse(retry) : null;
  }

  function failure(access: RequestAccess, caught: unknown): Response {
    if (caught instanceof PasskeyError) {
      if (
        caught.status === 401 ||
        caught.status === 403 ||
        caught.status === 410
      )
        args.limiter.failure(access.clientAddress ?? "unknown");
      return error(caught.message, caught.status);
    }
    if (caught instanceof SyntaxError) return error("invalid JSON", 400);
    logger.warn("authentication request failed", {
      error: caught instanceof Error ? caught.message : String(caught),
    });
    return error("request failed", 500);
  }

  function originOrError(access: RequestAccess) {
    const origin = passkeyOrigin(access.ownOrigin);
    if (!origin)
      throw new PasskeyError(
        "passkeys need HTTPS or localhost; open Thyra through its HTTPS address",
      );
    return origin;
  }

  function login(
    user: User,
    method: string,
    req: Request,
    access: RequestAccess,
  ) {
    const { token } = args.store.createSession({
      userId: user.id,
      authMethod: method,
      userAgent: req.headers.get("user-agent"),
    });
    args.store.audit(user.id, "session.create", user.id, { method });
    args.limiter.success(access.clientAddress ?? "unknown");
    return args.authenticator.sessionCookie(token, access);
  }

  async function grants(
    req: Request,
    url: URL,
    principal: Principal,
  ): Promise<Response> {
    const body = req.method === "POST" ? await readJson(req) : {};
    // The target is in the query string, where HTTP_POLICY checks it.
    const connectionId = url.searchParams.get("connection_id");
    const workspaceId = url.searchParams.get("workspace_id");
    if (
      typeof connectionId !== "string" ||
      typeof workspaceId !== "string" ||
      !workspaceId
    )
      return error("connection_id and workspace_id required", 400);
    if (!args.connectionExists(connectionId))
      return error("unknown connection", 404);
    // Checked by HTTP_POLICY already; kept as defense in depth.
    const decision = await authorizeTarget({
      principal,
      connectionId,
      target: { workspace: workspaceId },
      minimum: "owner",
      deps: args.authzDeps,
    });
    if (!decision.ok) return error(decision.message, 403);
    if (req.method === "POST") {
      const role = body.role;
      if (role !== "none" && !isWorkspaceRole(role))
        return error("role must be owner, editor, viewer or none", 400);
      const query = typeof body.user === "string" ? body.user : "";
      const target = args.store.findUser(query);
      if (!target) return error(`no user named ${JSON.stringify(query)}`, 404);
      if (principal.kind === "user" && target.id === principal.user.id)
        return error("you cannot change your own access", 400);
      if (
        args.store.setGrant({
          connectionId,
          workspaceId,
          userId: target.id,
          role: role === "none" ? null : role,
          actor: actorOf(principal),
        })
      )
        args.onChange();
    }
    return json({
      connection_id: connectionId,
      workspace_id: workspaceId,
      grants: args.store.grantsOn(connectionId, workspaceId).map((grant) => ({
        user: {
          id: grant.userId,
          name: grant.userName,
          display_name: grant.displayName,
        },
        role: grant.role,
        updated_at: grant.updatedAt,
      })),
    });
  }

  /**
   * Handle an authentication or account route. `principal` is null for
   * requests that are not logged in (public routes only reach here then).
   */
  async function handle(
    route: HttpRouteId,
    req: Request,
    url: URL,
    access: RequestAccess,
    principal: Principal | null,
  ): Promise<Response | null> {
    if (route.startsWith("share."))
      return args.shareRoutes
        ? args.shareRoutes.handle(route, req, url, access, principal)
        : null;
    try {
      switch (route) {
        case "login.page": {
          // A guest whose link ended lands here: explain, and drop the
          // stale guest cookie.
          if (!principal && args.authenticator.guestToken(req)) {
            const ended = htmlPage(req, renderShareEndedPage);
            ended.headers.append(
              "set-cookie",
              args.authenticator.guestCookie("", access, 0),
            );
            return ended;
          }
          return htmlPage(req, renderLoginPage);
        }
        case "enroll.page":
          return htmlPage(req, renderEnrollPage);
        case "login.script":
          return new Response(req.method === "HEAD" ? null : AUTH_SCRIPT, {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": "no-cache",
              "x-content-type-options": "nosniff",
            },
          });
        case "passkey.login": {
          const blocked = limited(access);
          if (blocked) return blocked;
          const origin = originOrError(access);
          if (url.pathname.endsWith("/options"))
            return json(await args.passkeys.loginOptions(origin));
          const user = await args.passkeys.loginVerify(
            origin,
            await readJson(req),
          );
          logger.info("passkey login", { user: user.name });
          return json({ ok: true }, 200, {
            "set-cookie": login(user, "passkey", req, access),
          });
        }
        case "passkey.register": {
          const blocked = limited(access);
          if (blocked) return blocked;
          const origin = originOrError(access);
          const body = await readJson(req);
          if (url.pathname.endsWith("/options")) {
            const secret = typeof body.secret === "string" ? body.secret : "";
            let user: User | null = null;
            if (secret) {
              user = args.store.enrollmentUser(secret);
              if (!user)
                throw new PasskeyError(
                  "this enrollment link is invalid or expired",
                  401,
                );
            } else if (principal?.kind === "user") {
              user = principal.user;
            } else {
              return error(
                principal
                  ? "direct local use has no account; run `thyra user add` to create one"
                  : "log in or open an enrollment link first",
                401,
              );
            }
            const options = await args.passkeys.registrationOptions(
              origin,
              user,
              secret || undefined,
            );
            return json({
              ...options,
              mode: secret ? "enroll" : "add",
              user: { name: user.name, display_name: user.displayName },
            });
          }
          const user = await args.passkeys.registrationVerify(origin, body);
          args.onChange();
          logger.info("passkey registered", { user: user.name });
          const same =
            principal?.kind === "user" && principal.user.id === user.id;
          return json(
            { ok: true },
            200,
            same
              ? {}
              : { "set-cookie": login(user, "enrollment", req, access) },
          );
        }
        case "logout": {
          // Custom headers require a CORS preflight; the bridge grants none.
          if (
            req.headers.get("x-thyra-logout") !== "1" ||
            req.headers.get("sec-fetch-site") === "cross-site"
          )
            return error("forbidden", 403);
          // A guest leaves its shared view (its session ends on the server);
          // an account session in the same browser is untouched. An account
          // wins over a guest cookie unless its user chose "Open as guest",
          // so only then, or without an account, does logout end the guest.
          // A guest cookie whose link already ended stays so the login page
          // can say so.
          const guestToken = args.authenticator.guestToken(req);
          if (
            guestToken &&
            (args.authenticator.prefersGuest(req) ||
              !(await args.authenticator.signedInAccount(req, access)))
          ) {
            const guest = args.shares?.resolveGuest(guestToken);
            if (!guest)
              return new Response(null, { status: 204, headers: NO_STORE });
            args.shares!.endGuest(guest.session.idHash);
            args.onGuestsEnded?.([guest.session.idHash]);
            args.onChange();
            const headers = new Headers({
              ...NO_STORE,
              "set-cookie": args.authenticator.guestCookie("", access, 0),
            });
            headers.append(
              "set-cookie",
              args.authenticator.asGuestCookie(access, 0),
            );
            return new Response(null, { status: 204, headers });
          }
          const token = args.authenticator.sessionToken(req);
          const resolved = token ? args.store.resolveSession(token) : null;
          if (resolved) {
            args.store.deleteSessionByHash(
              resolved.session.idHash,
              resolved.user.id,
            );
            args.onSessionEnded(resolved.session.idHash);
            args.onChange();
          }
          return new Response(null, {
            status: 204,
            headers: {
              ...NO_STORE,
              "set-cookie": args.authenticator.clearCookie(access),
            },
          });
        }
        default:
          break;
      }
      if (!principal) return null;
      switch (route) {
        case "auth.me":
          return json({
            ...principalView(principal),
            passkeys:
              principal.kind === "user"
                ? args.store.passkeysOf(principal.user.id).length
                : 0,
            identities:
              principal.kind === "user"
                ? args.store
                    .identitiesOf(principal.user.id)
                    .map((identity) => ({
                      provider: identity.provider,
                      subject: identity.subject,
                    }))
                : [],
          });
        case "auth.sessions": {
          const current =
            principal.kind === "user" ? principal.session.publicId : null;
          if (
            url.searchParams.get("all") === "1" &&
            isInstanceAdmin(principal)
          ) {
            const users = new Map(
              args.store.listUsers().map((user) => [user.id, user]),
            );
            return json({
              sessions: args.store
                .listSessions()
                .map((session) =>
                  sessionView(session, current, users.get(session.userId)),
                ),
            });
          }
          if (principal.kind !== "user") return json({ sessions: [] });
          return json({
            sessions: args.store
              .listSessions(principal.user.id)
              .map((session) => sessionView(session, current)),
          });
        }
        case "auth.sessions.revoke": {
          const body = await readJson(req);
          if (typeof body.id !== "string") return error("id required", 400);
          const revoked = args.store.revokeSession(body.id, {
            ...(isInstanceAdmin(principal) || principal.kind !== "user"
              ? {}
              : { userId: principal.user.id }),
            actor: actorOf(principal),
          });
          if (!revoked) return error("no such session", 404);
          args.onSessionEnded(revoked.idHash);
          args.onChange();
          return json({ ok: true });
        }
        case "auth.passkeys":
          return json({
            passkeys:
              principal.kind === "user"
                ? args.store.passkeysOf(principal.user.id).map((passkey) => ({
                    id: passkey.credentialId,
                    name: passkey.name,
                    rp_id: passkey.rpId,
                    created_at: passkey.createdAt,
                    last_used_at: passkey.lastUsedAt,
                  }))
                : [],
          });
        case "auth.passkeys.remove": {
          const body = await readJson(req);
          if (principal.kind !== "user" || typeof body.id !== "string")
            return error("id required", 400);
          if (
            !args.store.removePasskey(
              body.id,
              principal.user.id,
              principal.user.id,
            )
          )
            return error("no such passkey", 404);
          args.onChange();
          return json({ ok: true });
        }
        case "grants.list":
        case "grants.set":
          return await grants(req, url, principal);
        default:
          return null;
      }
    } catch (caught) {
      return failure(access, caught);
    }
  }

  return { handle };
}
