import type { AccountStore, User } from "../accounts/store";
import { hashSecret, randomToken } from "../accounts/store";
import type { HttpRouteId } from "../authz/http-policy";
import {
  createLoginRateLimiter,
  type LoginRateLimiter,
  tooManyAttemptsResponse,
} from "../http/login-rate-limit";
import { publicCookie, readPublicCookie } from "../http/public-auth";
import type { RequestAccess } from "../http/request-access";
import {
  createRequestRateLimiter,
  rateLimitedResponse,
  type RequestRateLimiter,
} from "../http/request-rate-limit";
import { HTML_SECURITY_HEADERS } from "../http/security-headers";
import { type Logger, silentLogger } from "../utils/logger";
import {
  type EmailCodeStore,
  type Mailer,
  normalizeEmail,
  signInEmail,
} from "./email";
import {
  authorizationUrl,
  fetchIdentity,
  type OAuthFlow,
  type OAuthFlowStore,
} from "./oauth";
import {
  type PageLocale,
  pageLocale,
  renderEmailLinkPage,
  renderInvitePage,
  renderOAuthConfirmPage,
  renderSignInResultPage,
} from "./pages";
import type { Authenticator, Principal } from "./principal";
import {
  type AuthProviders,
  type OAuthProviderConfig,
  type OAuthProviderId,
  providerFlags,
} from "./providers";
import {
  type ExternalIdentity,
  type InviteStore,
  resolveIdentity,
  type SignInError,
  type SignInOutcome,
} from "./sign-in";

/**
 * Login routes for the optional providers: email codes and links, GitHub
 * and Google, and invitation links. They run on whichever listener serves
 * them (sessions use that listener's cookie); the public listener is the
 * usual one. State-changing routes are JSON POSTs, which the listeners
 * accept only with this origin's `Origin` header (a CORS preflight stops
 * other sites), and OAuth callbacks are bound to a single-use state.
 */

const MAX_BODY_BYTES = 8 * 1024;
const NO_STORE = { "cache-control": "no-store" };
const FLOW_COOKIE = "thyra_oauth";

class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
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

function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers(NO_STORE);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return Response.json(body, { status, headers });
}

function parseCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** An origin OAuth may return to: HTTPS, or plain HTTP on loopback. */
export function oauthCapableOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
    );
  } catch {
    return false;
  }
}

export type SignInRoutes = ReturnType<typeof createSignInRoutes>;

export function createSignInRoutes(args: {
  store: AccountStore;
  authenticator: Authenticator;
  providers: AuthProviders;
  mailer: Mailer | null;
  codes: EmailCodeStore;
  flows: OAuthFlowStore;
  invites: InviteStore;
  /** Cookies that re-enable silent tailnet sign-in after a new login. */
  signedInCookies?: (access: RequestAccess) => string[];
  /** Failed codes, links and invitations per client address. */
  limiter?: LoginRateLimiter;
  /** Sign-in emails per client address. */
  sendLimiter?: RequestRateLimiter;
  onChange?: () => void;
  fetch?: typeof fetch;
  logger?: Logger;
}) {
  const logger = args.logger ?? silentLogger;
  const limiter = args.limiter ?? createLoginRateLimiter();
  const sendLimiter =
    args.sendLimiter ??
    createRequestRateLimiter({ limit: 10, windowMs: 10 * 60_000 });
  const clientOf = (access: RequestAccess) => access.clientAddress ?? "unknown";

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

  /** A new session for `user` in this browser: the cookies to set. */
  function startSession(
    user: User,
    method: string,
    req: Request,
    access: RequestAccess,
  ): string[] {
    const { token } = args.store.createSession({
      userId: user.id,
      authMethod: method,
      userAgent: req.headers.get("user-agent"),
    });
    args.store.audit(user.id, "session.create", user.id, { method });
    limiter.success(clientOf(access));
    logger.info("sign-in", { user: user.name, method });
    args.onChange?.();
    return [
      args.authenticator.sessionCookie(token, access),
      ...(args.signedInCookies?.(access) ?? []),
    ];
  }

  function flowCookie(access: RequestAccess, value: string, maxAge: number) {
    if (access.listener === "public")
      return publicCookie(FLOW_COOKIE, value, maxAge);
    return `${FLOW_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${access.secure ? "; Secure" : ""}`;
  }

  function readFlowCookie(req: Request, access: RequestAccess) {
    return access.listener === "public"
      ? readPublicCookie(req, FLOW_COOKIE)
      : parseCookie(req.headers.get("cookie"), FLOW_COOKIE);
  }

  function providerConfig(url: URL): OAuthProviderConfig | null {
    const id = url.pathname.split("/")[3] as OAuthProviderId | undefined;
    if (id !== "github" && id !== "google") return null;
    return args.providers[id];
  }

  const redirectUri = (access: RequestAccess, provider: OAuthProviderConfig) =>
    `${access.ownOrigin}/auth/oauth/${provider.id}/callback`;

  function resolve(
    identity: ExternalIdentity,
    options: { linkUserId?: string | null; inviteHash?: string | null },
  ): SignInOutcome {
    const invite = options.inviteHash
      ? args.invites.peekHash(options.inviteHash)
      : null;
    const outcome = resolveIdentity(args.store, identity, {
      signup: args.providers.signup,
      linkUserId: options.linkUserId,
      inviteUserId: invite?.user.id ?? null,
    });
    if (
      outcome.kind === "user" &&
      invite &&
      outcome.user.id === invite.user.id &&
      options.inviteHash
    )
      args.invites.consumeHash(options.inviteHash);
    if (outcome.kind === "user") args.onChange?.();
    return outcome;
  }

  // Email ------------------------------------------------------------------

  async function emailStart(req: Request, access: RequestAccess) {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    if (!email) throw new RequestError("enter a valid email address");
    const retry = sendLimiter.take(clientOf(access));
    if (retry) return rateLimitedResponse(retry);
    const issued = args.codes.issue({ email, purpose: "login" });
    if (issued) {
      const link = `${access.ownOrigin}/auth/email#${issued.id}.${issued.linkSecret}`;
      try {
        const sent = await args.mailer!.send({
          to: email,
          ...signInEmail({ code: issued.code, link }),
        });
        logger.info("sign-in email sent", { id: sent.id ?? "-" });
      } catch (error) {
        args.codes.release(issued.id);
        logger.error("sign-in email failed", {
          error: (error as Error).message,
        });
        throw new RequestError("email delivery failed; try again later", 503);
      }
    }
    // The same answer whether or not the address has an account or was in
    // its cooldown; the page offers another code after a minute.
    return json({ flow: issued?.id ?? randomToken(12), resend_after: 60 });
  }

  async function emailVerify(req: Request, access: RequestAccess) {
    const retry = limiter.retryAfterSeconds(clientOf(access));
    if (retry) return tooManyAttemptsResponse(retry);
    const body = await readJson(req);
    const result = args.codes.verify({
      id: typeof body.flow === "string" ? body.flow : "",
      ...(typeof body.code === "string" ? { code: body.code } : {}),
      ...(typeof body.link === "string" ? { link: body.link } : {}),
    });
    if (!result.ok || result.purpose !== "login") {
      limiter.failure(clientOf(access));
      args.store.audit(null, "signin.email_failed", null, {
        reason: result.ok ? "purpose" : result.reason,
      });
      return json(
        {
          error: "that code is wrong or expired",
          reason: result.ok ? "invalid" : result.reason,
        },
        401,
      );
    }
    const invite =
      typeof body.invite === "string" ? args.invites.peek(body.invite) : null;
    const outcome = resolve(
      {
        provider: "email",
        subject: result.email,
        email: result.email,
        emailVerified: true,
        displayName: null,
        avatarUrl: null,
        label: result.email,
      },
      {
        inviteHash: invite ? hashSecret(body.invite as string) : null,
      },
    );
    if (outcome.kind === "user")
      return json(
        { status: "signed_in" },
        200,
        startSession(outcome.user, "email", req, access),
      );
    if (outcome.kind === "unknown")
      return json({ status: "unknown", label: outcome.label });
    return json({ error: outcome.message }, 403);
  }

  // OAuth ------------------------------------------------------------------

  async function oauthStart(
    req: Request,
    url: URL,
    access: RequestAccess,
    principal: Principal | null,
  ) {
    const provider = providerConfig(url);
    if (!provider) return json({ error: "not configured" }, 404);
    if (!oauthCapableOrigin(access.ownOrigin))
      throw new RequestError("sign-in with this provider needs HTTPS");
    const body = await readJson(req);
    const intent = body.intent === "link" ? "link" : "login";
    if (intent === "link" && principal?.kind !== "user")
      throw new RequestError("log in first", 401);
    const invite =
      typeof body.invite === "string" && args.invites.peek(body.invite)
        ? body.invite
        : null;
    const flow = args.flows.create({
      provider: provider.id,
      intent,
      userId:
        principal?.kind === "user" && intent === "link"
          ? principal.user.id
          : null,
      invite,
      origin: access.ownOrigin!,
      userAgent: req.headers.get("user-agent"),
    });
    const popup = body.popup === true;
    return json(
      {
        url: authorizationUrl(
          provider,
          redirectUri(access, provider),
          flow.state,
          flow.verifier,
        ),
        flow: flow.id,
        poll: flow.poll,
        pairing: flow.pairing,
      },
      200,
      [flowCookie(access, popup ? `${flow.id}:popup` : flow.id, 600)],
    );
  }

  function resultPage(
    req: Request,
    flow: Pick<OAuthFlow, "provider"> | null,
    outcome:
      | { kind: "unknown"; label: string }
      | { kind: "error"; code: SignInError; message?: string }
      | { kind: "done"; close: boolean; linked: boolean },
    cookies: string[] = [],
  ) {
    const response = htmlPage(req, (locale) =>
      renderSignInResultPage(locale, {
        provider: flow?.provider ?? null,
        ...outcome,
      }),
    );
    for (const cookie of cookies) response.headers.append("set-cookie", cookie);
    return response;
  }

  async function oauthCallback(req: Request, url: URL, access: RequestAccess) {
    const provider = providerConfig(url);
    if (!provider) return json({ error: "not configured" }, 404);
    const clear = flowCookie(access, "", 0);
    const flow = args.flows.takeByState(url.searchParams.get("state") ?? "");
    if (
      !flow ||
      flow.provider !== provider.id ||
      flow.origin !== access.ownOrigin
    ) {
      limiter.failure(clientOf(access));
      return resultPage(
        req,
        null,
        {
          kind: "error",
          code: "expired",
        },
        [clear],
      );
    }
    const code = url.searchParams.get("code");
    if (!code) {
      args.flows.finish(flow.id, "failed", { error: "cancelled" });
      return resultPage(
        req,
        flow,
        {
          kind: "error",
          code: "cancelled",
        },
        [clear],
      );
    }
    let identity: ExternalIdentity;
    try {
      identity = await fetchIdentity(
        provider,
        redirectUri(access, provider),
        code,
        flow.verifier,
        args.fetch,
      );
    } catch (error) {
      logger.warn("OAuth sign-in failed", {
        provider: provider.id,
        error: (error as Error).message,
      });
      args.flows.finish(flow.id, "failed", { error: "provider" });
      return resultPage(
        req,
        flow,
        {
          kind: "error",
          code: "provider",
        },
        [clear],
      );
    }
    const [cookieFlow, mode] = (readFlowCookie(req, access) ?? "").split(":");
    const sameBrowser = cookieFlow === flow.id;
    if (!sameBrowser) {
      // Another browser (Safari for a Home Screen app, or someone else's
      // link): ask before handing the result to the starting page.
      const token = args.flows.awaitConfirm(flow.id, { identity });
      return htmlPage(req, (locale) =>
        renderOAuthConfirmPage(locale, {
          flow: flow.id,
          confirm: token,
          pairing: flow.pairing,
          provider: flow.provider,
          label: identity.label,
          intent: flow.intent,
        }),
      );
    }
    const outcome = resolve(identity, {
      linkUserId: flow.intent === "link" ? flow.userId : null,
      inviteHash: flow.inviteHash,
    });
    if (outcome.kind === "user") {
      args.flows.finish(flow.id, "done", {
        userId: outcome.user.id,
        linked: outcome.linked,
        here: true,
      });
      const cookies =
        flow.intent === "login"
          ? startSession(outcome.user, provider.id, req, access)
          : [];
      if (mode === "popup")
        return resultPage(
          req,
          flow,
          {
            kind: "done",
            close: true,
            linked: flow.intent === "link",
          },
          [...cookies, clear],
        );
      const headers = new Headers({ location: "/", ...NO_STORE });
      for (const cookie of [...cookies, clear])
        headers.append("set-cookie", cookie);
      return new Response(null, { status: 303, headers });
    }
    if (outcome.kind === "unknown") {
      args.flows.finish(flow.id, "unknown", { label: outcome.label });
      return resultPage(req, flow, outcome, [clear]);
    }
    args.flows.finish(flow.id, "failed", { error: outcome.message });
    return resultPage(req, flow, outcome, [clear]);
  }

  async function oauthConfirm(req: Request) {
    const body = await readJson(req);
    const flow = args.flows.takeConfirm(
      typeof body.flow === "string" ? body.flow : "",
      typeof body.confirm === "string" ? body.confirm : "",
    );
    const identity = flow?.result?.identity;
    if (!flow || !identity) return json({ error: "this sign-in expired" }, 410);
    if (body.accept !== true) {
      args.flows.finish(flow.id, "failed", { error: "cancelled" });
      args.store.audit(null, "signin.oauth_declined", null, {
        provider: flow.provider,
      });
      return json({ status: "cancelled" });
    }
    const outcome = resolve(identity, {
      linkUserId: flow.intent === "link" ? flow.userId : null,
      inviteHash: flow.inviteHash,
    });
    if (outcome.kind === "user") {
      args.flows.finish(flow.id, "done", {
        userId: outcome.user.id,
        linked: outcome.linked,
      });
      return json({ status: "done" });
    }
    if (outcome.kind === "unknown") {
      args.flows.finish(flow.id, "unknown", { label: outcome.label });
      return json({ status: "unknown", label: outcome.label });
    }
    args.flows.finish(flow.id, "failed", { error: outcome.message });
    return json({ status: "failed", error: outcome.message });
  }

  async function oauthPoll(req: Request, access: RequestAccess) {
    const body = await readJson(req);
    const flow = args.flows.poll(
      typeof body.flow === "string" ? body.flow : "",
      typeof body.poll === "string" ? body.poll : "",
    );
    if (!flow) return json({ status: "expired" }, 404);
    const result = flow.result ?? {};
    switch (flow.status) {
      case "pending":
      case "confirm":
        return json({ status: "pending" });
      case "done": {
        const user = result.userId ? args.store.getUser(result.userId) : null;
        if (flow.intent === "login" && !result.here && user && !user.disabled)
          return json(
            { status: "done" },
            200,
            startSession(user, flow.provider, req, access),
          );
        return json({ status: "done" });
      }
      case "collected":
        return json({ status: "done" });
      case "unknown":
        return json({
          status: "unknown",
          label: result.label ?? "",
          provider: flow.provider,
        });
      default:
        return json({ status: "failed", error: result.error ?? "failed" });
    }
  }

  // Invitations ------------------------------------------------------------

  async function inviteCheck(req: Request, access: RequestAccess) {
    const retry = limiter.retryAfterSeconds(clientOf(access));
    if (retry) return tooManyAttemptsResponse(retry);
    const body = await readJson(req);
    const invite = args.invites.peek(body.token);
    if (!invite) {
      limiter.failure(clientOf(access));
      return json({ error: "this invitation is invalid or expired" }, 404);
    }
    return json({
      email: invite.email,
      name: invite.user.displayName,
      providers: providerFlags(args.providers),
    });
  }

  async function inviteAccept(req: Request, access: RequestAccess) {
    const retry = limiter.retryAfterSeconds(clientOf(access));
    if (retry) return tooManyAttemptsResponse(retry);
    const body = await readJson(req);
    const invite = args.invites.consume(body.token);
    if (!invite) {
      limiter.failure(clientOf(access));
      return json({ error: "this invitation is invalid or expired" }, 404);
    }
    // The mailed link proves the address: it becomes a verified sign-in.
    args.store.linkIdentity({
      provider: "email",
      subject: invite.email,
      userId: invite.user.id,
      email: invite.email,
      emailVerified: true,
      actor: invite.user.id,
    });
    return json(
      { status: "signed_in" },
      200,
      startSession(invite.user, "invite", req, access),
    );
  }

  return {
    /** Which providers are on, for the login and account pages. */
    flags: () => providerFlags(args.providers),

    async handle(
      route: HttpRouteId,
      req: Request,
      url: URL,
      access: RequestAccess,
      principal: Principal | null,
    ): Promise<Response | null> {
      try {
        switch (route) {
          case "email.start":
            return args.mailer
              ? await emailStart(req, access)
              : json({ error: "not configured" }, 404);
          case "email.verify":
            return args.mailer
              ? await emailVerify(req, access)
              : json({ error: "not configured" }, 404);
          case "email.page":
            return htmlPage(req, renderEmailLinkPage);
          case "oauth.start":
            return await oauthStart(req, url, access, principal);
          case "oauth.callback":
            return await oauthCallback(req, url, access);
          case "oauth.confirm":
            return await oauthConfirm(req);
          case "oauth.poll":
            return await oauthPoll(req, access);
          case "invite.page":
            return htmlPage(req, (locale) =>
              renderInvitePage(locale, providerFlags(args.providers)),
            );
          case "invite.check":
            return await inviteCheck(req, access);
          case "invite.accept":
            return await inviteAccept(req, access);
          default:
            return null;
        }
      } catch (error) {
        if (error instanceof RequestError)
          return json({ error: error.message }, error.status);
        logger.warn("sign-in request failed", {
          route,
          error: (error as Error).message,
        });
        return json({ error: "request failed" }, 500);
      }
    },
  };
}
