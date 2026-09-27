import type { RequestAccess } from "../http/request-access";
import {
  type TailnetAuthMode,
  type TailnetUser,
  tailnetUser,
} from "../http/tailnet-auth";
import { type Logger, silentLogger } from "../utils/logger";
import type {
  AccountStore,
  InstanceRole,
  SessionRecord,
  User,
} from "../accounts/store";

/**
 * Who a request acts for.
 *
 * - `local`: direct use of a loopback listener from this machine (no proxy,
 *   loopback Host, no foreign Origin). It is the host owner and has
 *   instance-admin authority, without an account.
 * - `user`: a logged-in account, from its session cookie or from Tailscale
 *   `whois` behind a trusted proxy (which creates and links the account).
 */
export type Principal =
  | { kind: "local"; key: "local" }
  | {
      kind: "user";
      key: string;
      user: User;
      session: SessionRecord;
    };

export const LOCAL_PRINCIPAL: Principal = { kind: "local", key: "local" };

export function userPrincipal(user: User, session: SessionRecord): Principal {
  return { kind: "user", key: `user:${user.id}`, user, session };
}

export function isInstanceAdmin(principal: Principal | null | undefined) {
  return (
    principal?.kind === "local" ||
    (principal?.kind === "user" && principal.user.role === "admin")
  );
}

/** Public summary of a principal for `/api/auth/me` and the hello. */
export function principalView(principal: Principal) {
  if (principal.kind === "local")
    return { kind: "local" as const, role: "admin" as const, user: null };
  return {
    kind: "user" as const,
    role: principal.user.role,
    user: {
      id: principal.user.id,
      name: principal.user.name,
      display_name: principal.user.displayName,
      role: principal.user.role,
    },
    session_id: principal.session.publicId,
  };
}

export const SESSION_COOKIE = "thyra_session";

export {
  parseTailnetAuthMode,
  type TailnetAuthMode,
} from "../http/tailnet-auth";

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

export type AuthResult = {
  principal: Principal | null;
  /** Session cookie to set on this response (new or rotated session). */
  setCookie?: string;
};

export type TailnetUserLookup = (
  address: string,
) => Promise<TailnetUser | null>;

export type Authenticator = ReturnType<typeof createAuthenticator>;

export function createAuthenticator(args: {
  store: AccountStore;
  /** Non-loopback listener: even direct local requests must log in. */
  authRequired: boolean;
  tailnetMode: TailnetAuthMode;
  tailnetUser: TailnetUserLookup;
  /** Native TLS: cookies are always `Secure`. */
  secureCookies?: boolean;
  /**
   * `__Host-` cookies (the public listener): always `Secure`, `Path=/`,
   * no `Domain`, so no other subdomain can set or read the session.
   */
  hostOnlyCookie?: boolean;
  logger?: Logger;
}) {
  const logger = args.logger ?? silentLogger;
  const cookieName = args.hostOnlyCookie
    ? `__Host-${SESSION_COOKIE}`
    : SESSION_COOKIE;

  function secure(access: Pick<RequestAccess, "secure">) {
    return Boolean(args.hostOnlyCookie || args.secureCookies || access.secure);
  }

  function sessionCookie(
    token: string,
    access: Pick<RequestAccess, "secure">,
    maxAgeSeconds = 30 * 24 * 60 * 60,
  ): string {
    return `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure(access) ? "; Secure" : ""}`;
  }

  function clearCookie(access: Pick<RequestAccess, "secure">): string {
    return `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure(access) ? "; Secure" : ""}`;
  }

  function sessionToken(req: Request): string | null {
    return parseCookie(req.headers.get("cookie"), cookieName);
  }

  function bypassesLogin(access: Pick<RequestAccess, "local">): boolean {
    return !args.authRequired && access.local;
  }

  /** The session cookie's principal, rotating a session whose privileges changed. */
  function fromCookie(
    req: Request,
    access: Pick<RequestAccess, "secure">,
  ): AuthResult | null {
    const token = sessionToken(req);
    if (!token) return null;
    const resolved = args.store.resolveSession(token);
    if (!resolved) return null;
    if (resolved.session.privilegeEpoch !== resolved.user.privilegeEpoch) {
      const rotated = args.store.rotateSession(resolved.session.idHash);
      if (!rotated) return null;
      return {
        principal: userPrincipal(resolved.user, rotated.session),
        setCookie: sessionCookie(rotated.token, access),
      };
    }
    return { principal: userPrincipal(resolved.user, resolved.session) };
  }

  /** The account for a Tailscale login, creating and linking it when new. */
  function tailnetAccount(
    login: string,
    displayName: string | undefined,
  ): User | null {
    const existing = args.store.findIdentity("tailscale", login);
    if (existing) {
      if (existing.disabled) return null;
      args.store.touchIdentity("tailscale", login);
      return existing;
    }
    const role: InstanceRole =
      args.tailnetMode === "admin" ? "admin" : "member";
    const user = args.store.db.transaction(() => {
      const created = args.store.createUser({
        name: args.store.uniqueName(login),
        displayName: displayName || login.split("@")[0] || login,
        role,
        actor: "tailnet",
      });
      args.store.linkIdentity({
        provider: "tailscale",
        subject: login,
        userId: created.id,
        displayName: displayName ?? null,
        actor: "tailnet",
      });
      return created;
    })();
    logger.info("created account for tailnet user", {
      user: user.name,
      role,
    });
    return user;
  }

  async function fromTailnet(
    req: Request,
    access: RequestAccess,
  ): Promise<AuthResult | null> {
    const identity = await tailnetUser({
      mode: args.tailnetMode,
      access,
      lookupUser: args.tailnetUser,
    });
    if (!identity) return null;
    const user = tailnetAccount(identity.login, identity.displayName);
    if (!user) return null;
    const { token, session } = args.store.createSession({
      userId: user.id,
      authMethod: "tailscale",
      userAgent: req.headers.get("user-agent"),
    });
    logger.info("tailnet login", { user: user.name });
    return {
      principal: userPrincipal(user, session),
      setCookie: sessionCookie(token, access),
    };
  }

  /**
   * Authenticate a request: direct local use, the session cookie, then
   * Tailscale `whois` for proxied tailnet requests.
   */
  async function authenticate(
    req: Request,
    access: RequestAccess,
  ): Promise<AuthResult> {
    if (bypassesLogin(access)) return { principal: LOCAL_PRINCIPAL };
    const cookie = fromCookie(req, access);
    if (cookie) return cookie;
    return (await fromTailnet(req, access)) ?? { principal: null };
  }

  return {
    authenticate,
    bypassesLogin,
    sessionCookie,
    clearCookie,
    sessionToken,
    /**
     * For listeners and routes that require an account: the principal and
     * headers to add, or the response to return (login redirect for page
     * navigations, 401 otherwise).
     */
    async requireLogin(
      req: Request,
      access: RequestAccess,
    ): Promise<
      | { ok: true; principal: Principal; headers: Record<string, string> }
      | { ok: false; response: Response }
    > {
      const result = await authenticate(req, access);
      if (!result.principal) {
        const accept = req.headers.get("accept") ?? "";
        return {
          ok: false,
          response:
            req.method === "GET" && accept.includes("text/html")
              ? unauthenticatedLoginRedirect()
              : new Response("unauthorized", {
                  status: 401,
                  headers: { "cache-control": "no-store" },
                }),
        };
      }
      return {
        ok: true,
        principal: result.principal,
        headers: result.setCookie ? { "set-cookie": result.setCookie } : {},
      };
    },
  };
}

export function unauthenticatedLoginRedirect(): Response {
  // A relative Location keeps a reverse proxy's public origin.
  return new Response(null, {
    status: 302,
    headers: { location: "/login", "cache-control": "no-store" },
  });
}
