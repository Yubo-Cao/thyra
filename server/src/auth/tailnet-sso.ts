import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import {
  type AccountStore,
  hashSecret,
  randomToken,
  type User,
} from "../accounts/store";
import type { HttpRouteId } from "../authz/http-policy";
import {
  type LoginRateLimiter,
  createLoginRateLimiter,
  tooManyAttemptsResponse,
} from "../http/login-rate-limit";
import { publicCookie, readPublicCookie } from "../http/public-auth";
import type { RequestAccess } from "../http/request-access";
import {
  createRequestRateLimiter,
  rateLimitedResponse,
  type RequestRateLimiter,
} from "../http/request-rate-limit";
import { type Logger, silentLogger } from "../utils/logger";

/**
 * Tailnet sign-in for the public listener: a device on the owner's tailnet
 * proves who it is to the tailnet listener (Tailscale `whois` of its
 * connection, through the trusted proxy), which hands it a single-use code
 * that the public listener redeems for a normal session. Both listeners run
 * in this process and share the account database, so redemption is a
 * database lookup, never a network call.
 *
 * Codes carry at least 256 bits, are stored only as SHA-256 digests, live
 * 60 seconds, are deleted on first use, and are bound to the account, a
 * PKCE challenge (SHA-256 of a verifier only the requesting page holds) and
 * the public origin allowed to redeem them.
 *
 * Two ways to get a code:
 *
 * - Silent (`sso.code`): the public login page `fetch`es
 *   `POST <tailnet>/auth/tailnet-sso/code` without credentials. CORS allows
 *   exactly `THYRA_PUBLIC_ORIGIN`; other origins get no code. The page then
 *   posts the code and its verifier to `sso.redeem`.
 * - Redirect (`sso.start` -> `sso.authorize` -> `sso.callback`): the
 *   "Sign in with tailnet" button. `start` keeps a random state and the
 *   verifier in a short-lived `__Host-` cookie and navigates to the tailnet
 *   listener, which redirects back only to `THYRA_PUBLIC_ORIGIN`.
 */

export const SSO_CODE_TTL_MS = 60_000;
/** The redirect flow's state cookie. */
const FLOW_COOKIE = "thyra_tailnet_sso";
const FLOW_TTL_SECONDS = 300;
/** Set by logout on the public listener: no silent tailnet sign-in. */
const SIGNED_OUT_COOKIE = "thyra_signed_out";
const SIGNED_OUT_TTL_SECONDS = 30 * 24 * 60 * 60;
/** 32 random bytes or a SHA-256 digest, base64url without padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 4 * 1024;
const NO_STORE = { "cache-control": "no-store" };

export type SsoRejection =
  | "invalid"
  | "expired"
  | "verifier"
  | "origin"
  | "account";

/** base64url SHA-256 of a PKCE verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * `THYRA_TAILNET_SSO_URL`: the HTTPS origin of the tailnet listener, such as
 * `https://dev.example.com` (plain HTTP only for loopback tests). Null when
 * unset; misconfiguration throws.
 */
export function parseTailnetSsoUrl(
  value: string | undefined,
  publicOrigin: string | null,
): string | null {
  const text = value?.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      `THYRA_TAILNET_SSO_URL must be the tailnet listener's origin, such as https://dev.example.com (got ${JSON.stringify(text)})`,
    );
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 && !loopback)
  ) {
    throw new Error(
      `THYRA_TAILNET_SSO_URL must be an HTTPS origin without a path, such as https://dev.example.com (got ${JSON.stringify(text)})`,
    );
  }
  if (!publicOrigin) {
    throw new Error(
      "THYRA_TAILNET_SSO_URL needs the public listener (THYRA_PUBLIC_LISTEN and THYRA_PUBLIC_ORIGIN)",
    );
  }
  if (url.origin === publicOrigin) {
    throw new Error(
      "THYRA_TAILNET_SSO_URL must be the tailnet listener's origin, not THYRA_PUBLIC_ORIGIN",
    );
  }
  return url.origin;
}

type CodeRow = {
  code_hash: string;
  user_id: string;
  challenge: string;
  return_origin: string;
  created_at: number;
  expires_at: number;
};

export type SsoCodeStore = ReturnType<typeof createSsoCodeStore>;

/** Single-use sign-in codes in the account database. */
export function createSsoCodeStore(store: AccountStore) {
  const { db } = store;
  return {
    /** A new code for an account, bound to a challenge and return origin. */
    issue(args: {
      userId: string;
      challenge: string;
      returnOrigin: string;
      flow: "silent" | "redirect";
    }): { code: string; expiresAt: number } {
      const code = randomToken(32);
      const at = store.now();
      const expiresAt = at + SSO_CODE_TTL_MS;
      db.query(
        `INSERT INTO tailnet_sso_codes (code_hash, user_id, challenge, return_origin, created_at, expires_at)
         VALUES ($hash, $user, $challenge, $origin, $at, $expires)`,
      ).run({
        hash: hashSecret(code),
        user: args.userId,
        challenge: args.challenge,
        origin: args.returnOrigin,
        at,
        expires: expiresAt,
      });
      store.audit(args.userId, "tailnet_sso.issue", args.userId, {
        flow: args.flow,
      });
      store.markChanged();
      return { code, expiresAt };
    },

    /**
     * Redeem a code with its PKCE verifier at `origin`. The code is deleted
     * whatever the outcome, so it can never be tried twice.
     */
    redeem(args: {
      code: string;
      verifier: string;
      origin: string;
    }): { ok: true; user: User } | { ok: false; reason: SsoRejection } {
      if (!TOKEN_PATTERN.test(args.code))
        return { ok: false, reason: "invalid" };
      const row = db
        .query<CodeRow, { hash: string }>(
          "DELETE FROM tailnet_sso_codes WHERE code_hash = $hash RETURNING *",
        )
        .get({ hash: hashSecret(args.code) });
      if (!row) return { ok: false, reason: "invalid" };
      store.markChanged();
      if (row.expires_at <= store.now())
        return { ok: false, reason: "expired" };
      if (!sameText(row.return_origin, args.origin))
        return { ok: false, reason: "origin" };
      if (
        !TOKEN_PATTERN.test(args.verifier) ||
        !sameText(row.challenge, pkceChallenge(args.verifier))
      )
        return { ok: false, reason: "verifier" };
      const user = store.getUser(row.user_id);
      if (!user || user.disabled) return { ok: false, reason: "account" };
      return { ok: true, user };
    },

    pruneExpired() {
      db.query("DELETE FROM tailnet_sso_codes WHERE expires_at <= $now").run({
        now: store.now(),
      });
    },
  };
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, ...NO_STORE });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (
    req.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    return null;
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export type TailnetSso = ReturnType<typeof createTailnetSso>;

/** Login-page state for the public listener. */
export type TailnetSsoLogin = {
  /** The tailnet listener's origin. */
  url: string;
  /** Try the silent sign-in before showing the buttons. */
  silent: boolean;
  /** A failed redirect sign-in to explain. */
  message: "unavailable" | "failed" | "expired" | null;
};

export function createTailnetSso(args: {
  store: AccountStore;
  codes: SsoCodeStore;
  /** `THYRA_PUBLIC_ORIGIN`, the only origin that may receive or redeem codes. */
  publicOrigin: string;
  /** `THYRA_TAILNET_SSO_URL`, the tailnet listener's origin. */
  tailnetOrigin: string;
  /**
   * The account of a request's Tailscale login (`whois` of its connection
   * through the trusted proxy), created on first sight; null otherwise.
   */
  tailnetAccount: (req: Request, access: RequestAccess) => Promise<User | null>;
  /** The public listener's session cookie for a new session token. */
  sessionCookie: (token: string, access: RequestAccess) => string;
  /** Code requests per tailnet client address. */
  issueLimiter?: RequestRateLimiter;
  /** Failed redemptions per public client address. */
  redeemLimiter?: LoginRateLimiter;
  logger?: Logger;
}) {
  const logger = args.logger ?? silentLogger;
  const issueLimiter =
    args.issueLimiter ??
    createRequestRateLimiter({ limit: 20, windowMs: 60_000 });
  const redeemLimiter = args.redeemLimiter ?? createLoginRateLimiter();
  const loginUrl = (message: TailnetSsoLogin["message"]) =>
    `${args.publicOrigin}/login?tailnet=${message}`;

  function signedOutCookie(signedOut: boolean): string {
    return publicCookie(
      SIGNED_OUT_COOKIE,
      signedOut ? "1" : "",
      signedOut ? SIGNED_OUT_TTL_SECONDS : 0,
    );
  }

  function corsHeaders(): Record<string, string> {
    return {
      "access-control-allow-origin": args.publicOrigin,
      vary: "Origin",
    };
  }

  function reject(reason: string, detail: Record<string, unknown> = {}) {
    args.store.audit(null, "tailnet_sso.reject", null, { reason, ...detail });
    logger.info("tailnet sign-in refused", { reason, ...detail });
  }

  /** `sso.code`: CORS preflight and silent code issue (tailnet listener). */
  async function code(req: Request, access: RequestAccess): Promise<Response> {
    const origin = req.headers.get("origin");
    if (origin !== args.publicOrigin) {
      // No CORS headers: the browser hides the refusal from the page.
      return new Response("forbidden: origin not allowed", {
        status: 403,
        headers: { ...NO_STORE, vary: "Origin" },
      });
    }
    if (req.method === "OPTIONS") {
      const method = req.headers.get("access-control-request-method");
      if (method !== "POST")
        return new Response(null, { status: 403, headers: NO_STORE });
      const headers: Record<string, string> = {
        ...corsHeaders(),
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
        vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
        ...NO_STORE,
      };
      // Private Network Access: a public page reaching a private address.
      if (req.headers.get("access-control-request-private-network") === "true")
        headers["access-control-allow-private-network"] = "true";
      return new Response(null, { status: 204, headers });
    }
    const retry = issueLimiter.take(access.clientAddress ?? "unknown");
    if (retry) {
      const limited = rateLimitedResponse(retry);
      for (const [name, value] of Object.entries(corsHeaders()))
        limited.headers.set(name, value);
      return limited;
    }
    const body = await readJson(req);
    const challenge = body?.code_challenge;
    if (typeof challenge !== "string" || !TOKEN_PATTERN.test(challenge))
      return json({ error: "code_challenge required" }, 400, corsHeaders());
    const user = await args.tailnetAccount(req, access);
    if (!user) {
      reject("not_tailnet", { flow: "silent" });
      return json({ error: "not on the tailnet" }, 403, corsHeaders());
    }
    const issued = args.codes.issue({
      userId: user.id,
      challenge,
      returnOrigin: args.publicOrigin,
      flow: "silent",
    });
    logger.info("tailnet sign-in code issued", {
      user: user.name,
      flow: "silent",
    });
    return json(
      { code: issued.code, expires_in: SSO_CODE_TTL_MS / 1000 },
      200,
      corsHeaders(),
    );
  }

  /** `sso.authorize`: the redirect flow's tailnet step. */
  async function authorize(
    req: Request,
    url: URL,
    access: RequestAccess,
  ): Promise<Response> {
    // Only ever redirect to the configured public origin.
    if (url.searchParams.get("return") !== args.publicOrigin) {
      reject("return_origin", { flow: "redirect" });
      return new Response("invalid return origin", {
        status: 400,
        headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" },
      });
    }
    const state = url.searchParams.get("state") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (!TOKEN_PATTERN.test(state) || !TOKEN_PATTERN.test(challenge))
      return redirect(loginUrl("failed"));
    const retry = issueLimiter.take(access.clientAddress ?? "unknown");
    if (retry) return rateLimitedResponse(retry);
    const user = await args.tailnetAccount(req, access);
    if (!user) {
      reject("not_tailnet", { flow: "redirect" });
      return redirect(loginUrl("unavailable"));
    }
    const issued = args.codes.issue({
      userId: user.id,
      challenge,
      returnOrigin: args.publicOrigin,
      flow: "redirect",
    });
    logger.info("tailnet sign-in code issued", {
      user: user.name,
      flow: "redirect",
    });
    const next = new URL("/auth/tailnet-sso/callback", args.publicOrigin);
    next.searchParams.set("code", issued.code);
    next.searchParams.set("state", state);
    return redirect(next.href);
  }

  function login(user: User, req: Request, access: RequestAccess): string[] {
    const { token } = args.store.createSession({
      userId: user.id,
      authMethod: "tailnet-sso",
      userAgent: req.headers.get("user-agent"),
    });
    args.store.audit(user.id, "session.create", user.id, {
      method: "tailnet-sso",
    });
    redeemLimiter.success(access.clientAddress ?? "unknown");
    logger.info("tailnet sign-in", { user: user.name });
    return [args.sessionCookie(token, access), signedOutCookie(false)];
  }

  function redeemFailed(access: RequestAccess, reason: SsoRejection) {
    redeemLimiter.failure(access.clientAddress ?? "unknown");
    reject(reason);
  }

  /** `sso.start`: begin the redirect flow (public listener). */
  function start(): Response {
    const state = randomToken(32);
    const verifier = randomToken(32);
    const next = new URL("/auth/tailnet-sso/authorize", args.tailnetOrigin);
    next.searchParams.set("state", state);
    next.searchParams.set("code_challenge", pkceChallenge(verifier));
    next.searchParams.set("return", args.publicOrigin);
    return redirect(next.href, [
      publicCookie(FLOW_COOKIE, `${state}.${verifier}`, FLOW_TTL_SECONDS),
    ]);
  }

  /** `sso.callback`: finish the redirect flow (public listener). */
  function callback(req: Request, url: URL, access: RequestAccess): Response {
    const clearFlow = publicCookie(FLOW_COOKIE, "", 0);
    const fail = (message: TailnetSsoLogin["message"]) =>
      redirect("/login?tailnet=" + message, [clearFlow]);
    if (redeemLimiter.retryAfterSeconds(access.clientAddress ?? "unknown"))
      return fail("failed");
    const [state = "", verifier = ""] = (
      readPublicCookie(req, FLOW_COOKIE) ?? ""
    ).split(".");
    const returned = url.searchParams.get("state") ?? "";
    if (!state || !TOKEN_PATTERN.test(returned) || !sameText(state, returned)) {
      redeemFailed(access, "invalid");
      return fail("failed");
    }
    const result = args.codes.redeem({
      code: url.searchParams.get("code") ?? "",
      verifier,
      origin: args.publicOrigin,
    });
    if (!result.ok) {
      redeemFailed(access, result.reason);
      return fail(result.reason === "expired" ? "expired" : "failed");
    }
    return redirect("/", [...login(result.user, req, access), clearFlow]);
  }

  /** `sso.redeem`: finish the silent flow (public listener). */
  async function redeem(
    req: Request,
    access: RequestAccess,
  ): Promise<Response> {
    const retry = redeemLimiter.retryAfterSeconds(
      access.clientAddress ?? "unknown",
    );
    if (retry) return tooManyAttemptsResponse(retry);
    const body = await readJson(req);
    const result = args.codes.redeem({
      code: typeof body?.code === "string" ? body.code : "",
      verifier:
        typeof body?.code_verifier === "string" ? body.code_verifier : "",
      origin: args.publicOrigin,
    });
    if (!result.ok) {
      redeemFailed(access, result.reason);
      return json({ error: "sign-in failed", reason: result.reason }, 401);
    }
    const headers = new Headers(NO_STORE);
    for (const cookie of login(result.user, req, access))
      headers.append("set-cookie", cookie);
    return Response.json({ ok: true }, { headers });
  }

  return {
    signedOutCookie,

    /** Login-page state for a public-listener request. */
    loginState(req: Request, url: URL): TailnetSsoLogin {
      const raw = url.searchParams.get("tailnet");
      const message =
        raw === "unavailable" || raw === "failed" || raw === "expired"
          ? raw
          : null;
      return {
        url: args.tailnetOrigin,
        silent: !message && readPublicCookie(req, SIGNED_OUT_COOKIE) !== "1",
        message,
      };
    },

    /**
     * Serve a tailnet sign-in route: `sso.code` and `sso.authorize` on the
     * tailnet listener, the rest on the public listener; 404 elsewhere.
     */
    async handle(
      route: HttpRouteId,
      req: Request,
      url: URL,
      access: RequestAccess,
    ): Promise<Response | null> {
      const tailnetRoute = route === "sso.code" || route === "sso.authorize";
      const publicRoute =
        route === "sso.start" ||
        route === "sso.callback" ||
        route === "sso.redeem";
      if (!tailnetRoute && !publicRoute) return null;
      if (
        (tailnetRoute && access.listener !== "tailnet") ||
        (publicRoute && access.listener !== "public")
      )
        return new Response("not found", { status: 404, headers: NO_STORE });
      switch (route) {
        case "sso.code":
          return code(req, access);
        case "sso.authorize":
          return authorize(req, url, access);
        case "sso.start":
          return start();
        case "sso.callback":
          return callback(req, url, access);
        default:
          return redeem(req, access);
      }
    },
  };
}
