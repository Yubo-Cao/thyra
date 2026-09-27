import {
  isShareLinkId,
  parseShareDuration,
  type ShareLink,
  type ShareLinkStore,
  shareLinkPath,
} from "../accounts/share-links";
import type { AccountStore } from "../accounts/store";
import { type AuthzDeps, workspaceOfScopedId } from "../authz/authorize";
import type { HttpRouteId } from "../authz/http-policy";
import {
  type LoginRateLimiter,
  tooManyAttemptsResponse,
} from "../http/login-rate-limit";
import type { RequestAccess } from "../http/request-access";
import { HTML_SECURITY_HEADERS } from "../http/security-headers";
import { type Logger, silentLogger } from "../utils/logger";
import { pageLocale, renderSharePage } from "./pages";
import type { Authenticator, Principal } from "./principal";

/**
 * Share-link routes: the `/s/<id>` landing page and redemption (public,
 * rate-limited per client address), and listing, creating and revoking a
 * workspace's links (workspace owners and instance admins, checked by
 * `HTTP_POLICY` before these handlers run).
 */

const MAX_BODY_BYTES = 8 * 1024;
const NO_STORE = { "cache-control": "no-store" };

class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (
    req.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new RequestError("expected a JSON request", 415);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES)
    throw new RequestError("request too large", 413);
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestError("invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError("expected a JSON object");
  return value as Record<string, unknown>;
}

function actorOf(principal: Principal | null): string | null {
  if (!principal) return null;
  if (principal.kind === "local") return "local";
  return principal.kind === "user" ? principal.user.id : principal.key;
}

/** Link expiry choices: `1h`, `24h`, `7d` and the like, or milliseconds. */
function ttlOf(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? parseShareDuration(value)
        : null;
  if (ms === null || !Number.isSafeInteger(ms))
    throw new RequestError("expires must be a duration such as 1h, 24h or 7d");
  return ms;
}

export type ShareRoutes = ReturnType<typeof createShareRoutes>;

export function createShareRoutes(args: {
  store: AccountStore;
  shares: ShareLinkStore;
  authenticator: Authenticator;
  /** Failed redemptions per client address. */
  limiter: LoginRateLimiter;
  authzDeps: AuthzDeps;
  connectionExists: (connectionId: string) => boolean;
  /** The origin a new link points at (the public listener when set). */
  linkOrigin: (access: RequestAccess) => string | null;
  /** Account data changed in this process. */
  onChange: () => void;
  /** Guest sessions that ended (revocation, leaving): close their sockets. */
  onGuestsEnded: (idHashes: string[]) => void;
  logger?: Logger;
}) {
  const logger = args.logger ?? silentLogger;
  const { shares } = args;

  function view(link: ShareLink & { guests?: number }) {
    const creator =
      link.createdBy && link.createdBy.startsWith("u_")
        ? args.store.getUser(link.createdBy)
        : null;
    return {
      id: link.id,
      pane_id: link.paneId,
      role: link.role,
      label: link.label,
      created_by: creator?.displayName ?? link.createdBy,
      created_at: link.createdAt,
      expires_at: link.expiresAt,
      max_uses: link.maxUses,
      uses: link.uses,
      guests: link.guests ?? 0,
      state: shares.stateOf(link),
    };
  }

  function target(url: URL) {
    const connectionId = url.searchParams.get("connection_id") ?? "";
    const workspaceId = url.searchParams.get("workspace_id") ?? "";
    if (!connectionId || !workspaceId)
      throw new RequestError("connection_id and workspace_id required");
    if (!args.connectionExists(connectionId))
      throw new RequestError("unknown connection", 404);
    return { connectionId, workspaceId };
  }

  function list(connectionId: string, workspaceId: string) {
    return json({
      connection_id: connectionId,
      workspace_id: workspaceId,
      links: shares.listLinks({ connectionId, workspaceId }).map(view),
    });
  }

  async function redeem(req: Request, access: RequestAccess) {
    const client = access.clientAddress ?? "unknown";
    const retry = args.limiter.retryAfterSeconds(client);
    if (retry) return tooManyAttemptsResponse(retry);
    const body = await readJson(req);
    const id = typeof body.id === "string" ? body.id : "";
    const secret = typeof body.secret === "string" ? body.secret : "";
    // A signed-in browser keeps its account (and its grants): it becomes a
    // guest only when its user explicitly chooses "Open as guest".
    const asGuest = body.as_guest === true;
    if (!asGuest && (await args.authenticator.signedInAccount(req, access)))
      return json(
        { error: "signed in; open the link as a guest", reason: "signed_in" },
        409,
      );
    // A browser already watching through this link keeps its session and
    // does not spend another use.
    const token = args.authenticator.guestToken(req);
    const current = token ? shares.resolveGuest(token) : null;
    const asGuestCookie = (expiresAt: number) =>
      asGuest
        ? {
            "set-cookie": args.authenticator.asGuestCookie(
              access,
              (expiresAt - args.store.now()) / 1000,
            ),
          }
        : undefined;
    if (current?.link.id === id && shares.verifySecret(id, secret))
      return json({ ok: true }, 200, asGuestCookie(current.session.expiresAt));
    const result = shares.redeem({
      id,
      secret,
      userAgent: req.headers.get("user-agent"),
    });
    if (!result.ok) {
      // Only a wrong secret can be a guess; the others needed the secret.
      if (result.reason === "invalid") args.limiter.failure(client);
      return json(
        { error: `share link ${result.reason}`, reason: result.reason },
        result.reason === "invalid" ? 404 : 410,
      );
    }
    args.limiter.success(client);
    if (current) {
      // One guest session per browser: the previous link's view ends.
      shares.endGuest(current.session.idHash);
      args.onGuestsEnded([current.session.idHash]);
    }
    args.onChange();
    logger.info("share link redeemed", {
      link: result.link.id,
      guest: result.session.publicId,
    });
    const response = json({ ok: true }, 200, {
      "set-cookie": args.authenticator.guestCookie(
        result.token,
        access,
        (result.session.expiresAt - args.store.now()) / 1000,
      ),
    });
    const preference = asGuestCookie(result.session.expiresAt);
    if (preference)
      response.headers.append("set-cookie", preference["set-cookie"]);
    return response;
  }

  async function create(
    req: Request,
    url: URL,
    access: RequestAccess,
    principal: Principal,
  ) {
    const { connectionId, workspaceId } = target(url);
    const body = await readJson(req);
    const paneId =
      typeof body.pane_id === "string" && body.pane_id ? body.pane_id : null;
    if (paneId) {
      const located =
        workspaceOfScopedId(paneId) ??
        (await args.authzDeps.locate(connectionId, { pane: paneId }))
          ?.workspace;
      if (located !== workspaceId)
        throw new RequestError(`pane ${paneId} is not in this workspace`);
    }
    const maxUses =
      body.max_uses === undefined || body.max_uses === null
        ? null
        : Number(body.max_uses);
    let created: ReturnType<ShareLinkStore["createLink"]>;
    try {
      created = shares.createLink({
        connectionId,
        workspaceId,
        paneId,
        label: typeof body.label === "string" ? body.label : null,
        ttlMs: ttlOf(body.expires),
        maxUses,
        actor: actorOf(principal),
      });
    } catch (error) {
      throw new RequestError((error as Error).message);
    }
    args.onChange();
    logger.info("share link created", {
      link: created.link.id,
      workspace: workspaceId,
    });
    const origin = args.linkOrigin(access) ?? "";
    return json({
      link: view(created.link),
      // Shown once: only the secret's digest is stored.
      url: `${origin}${shareLinkPath(created.link.id, created.secret)}`,
    });
  }

  async function revoke(req: Request, url: URL, principal: Principal) {
    const scope = target(url);
    const body = await readJson(req);
    if (!isShareLinkId(body.id)) throw new RequestError("id required");
    const revoked = shares.revokeLink(body.id, {
      actor: actorOf(principal),
      scope,
    });
    if (!revoked) throw new RequestError("no such link", 404);
    args.onGuestsEnded(revoked.ended);
    args.onChange();
    logger.info("share link revoked", {
      link: revoked.link.id,
      guests: revoked.ended.length,
    });
    return list(scope.connectionId, scope.workspaceId);
  }

  return {
    async handle(
      route: HttpRouteId,
      req: Request,
      url: URL,
      access: RequestAccess,
      principal: Principal | null,
    ): Promise<Response | null> {
      try {
        switch (route) {
          case "share.page":
            return new Response(
              req.method === "HEAD"
                ? null
                : renderSharePage(
                    pageLocale(req.headers.get("accept-language")),
                    // Offer a signed-in visitor its own account first.
                    await args.authenticator.signedInAccount(req, access),
                  ),
              {
                headers: {
                  "content-type": "text/html; charset=utf-8",
                  ...NO_STORE,
                  ...HTML_SECURITY_HEADERS,
                  vary: "Accept-Language",
                },
              },
            );
          case "share.redeem":
            return await redeem(req, access);
          default:
            break;
        }
        if (!principal) return null;
        switch (route) {
          case "share.list": {
            const { connectionId, workspaceId } = target(url);
            return list(connectionId, workspaceId);
          }
          case "share.create":
            return await create(req, url, access, principal);
          case "share.revoke":
            return await revoke(req, url, principal);
          default:
            return null;
        }
      } catch (error) {
        if (error instanceof RequestError)
          return json({ error: error.message }, error.status);
        logger.warn("share link request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return json({ error: "request failed" }, 500);
      }
    },
  };
}
