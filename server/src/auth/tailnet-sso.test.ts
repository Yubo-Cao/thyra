import { describe, expect, test } from "bun:test";
import { openAccountDatabase } from "../accounts/database";
import { createAccountStore, randomToken } from "../accounts/store";
import { testDeps } from "../authz/test-principals";
import { matchHttpRoute } from "../authz/http-policy";
import { createLoginRateLimiter } from "../http/login-rate-limit";
import type { RequestAccess } from "../http/request-access";
import { createPasskeyService } from "./passkeys";
import { renderLoginPage } from "./pages";
import { createAuthenticator } from "./principal";
import { createAuthRoutes } from "./routes";
import {
  createSsoCodeStore,
  createTailnetSso,
  parseTailnetSsoUrl,
  pkceChallenge,
  SSO_CODE_TTL_MS,
  tailnetConnectSource,
} from "./tailnet-sso";

const PUBLIC = "https://thyra.example";
const TAILNET = "https://dev.example";
const TAILNET_ADDRESS = "100.64.7.7";

/** A request as the tailnet listener sees it through Caddy. */
function tailnetAccess(overrides: Partial<RequestAccess> = {}): RequestAccess {
  return {
    listener: "tailnet",
    hostAllowed: true,
    host: "dev.example",
    ownOrigin: TAILNET,
    proxied: true,
    local: false,
    secure: true,
    clientAddress: TAILNET_ADDRESS,
    cloudflare: false,
    ...overrides,
  };
}

/** A request as the public listener sees it through cloudflared. */
function publicAccess(overrides: Partial<RequestAccess> = {}): RequestAccess {
  return {
    listener: "public",
    hostAllowed: true,
    host: "thyra.example",
    ownOrigin: PUBLIC,
    proxied: true,
    local: false,
    secure: true,
    clientAddress: "203.0.113.9",
    cloudflare: true,
    ...overrides,
  };
}

function setup() {
  let clock = 1_700_000_000_000;
  const store = createAccountStore(openAccountDatabase(":memory:"), {
    now: () => clock,
  });
  const primary = createAuthenticator({
    store,
    authRequired: false,
    tailnetMode: "admin",
    tailnetUser: async (address) =>
      address === TAILNET_ADDRESS ? { login: "owner@example.com" } : null,
  });
  const publicAuthenticator = createAuthenticator({
    store,
    authRequired: true,
    tailnetMode: "off",
    tailnetUser: async () => null,
    hostOnlyCookie: true,
  });
  const codes = createSsoCodeStore(store);
  const sso = createTailnetSso({
    store,
    codes,
    publicOrigin: PUBLIC,
    tailnetOrigin: TAILNET,
    tailnetAccount: primary.tailnetAccountFor,
    sessionCookie: publicAuthenticator.sessionCookie,
  });
  const routes = createAuthRoutes({
    store,
    authenticator: publicAuthenticator,
    passkeys: createPasskeyService({ store }),
    limiter: createLoginRateLimiter(),
    authzDeps: testDeps(),
    connectionExists: () => false,
    onChange: () => {},
    onSessionEnded: () => {},
    tailnetSso: sso,
  });
  /** Route a request the way the listeners do. */
  const call = (
    method: string,
    target: string,
    access: RequestAccess,
    init: { headers?: Record<string, string>; body?: unknown } = {},
  ) => {
    const url = new URL(target);
    const route = matchHttpRoute(method, url.pathname);
    if (!route) throw new Error(`no route for ${method} ${url.pathname}`);
    const req = new Request(url, {
      method,
      headers: {
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return sso.handle(route, req, url, access) as Promise<Response>;
  };
  const sessionUser = async (response: Response) => {
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-thyra_session="));
    if (!cookie) return null;
    const result = await publicAuthenticator.authenticate(
      new Request(`${PUBLIC}/`, { headers: { cookie: cookie.split(";")[0]! } }),
      publicAccess(),
    );
    return result.principal?.kind === "user" ? result.principal.user : null;
  };
  return {
    store,
    codes,
    sso,
    routes,
    call,
    sessionUser,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function pkce() {
  const verifier = randomToken(32);
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** Ask the tailnet listener for a code as the public login page does. */
async function silentCode(
  ctx: ReturnType<typeof setup>,
  challenge: string,
  access = tailnetAccess(),
  origin = PUBLIC,
) {
  return ctx.call("POST", `${TAILNET}/auth/tailnet-sso/code`, access, {
    headers: { origin },
    body: { code_challenge: challenge },
  });
}

describe("tailnet sign-in configuration", () => {
  test("THYRA_TAILNET_SSO_URL is an HTTPS origin next to the public listener", () => {
    expect(parseTailnetSsoUrl(undefined, PUBLIC)).toBeNull();
    expect(parseTailnetSsoUrl(" https://dev.example/ ", PUBLIC)).toBe(TAILNET);
    expect(parseTailnetSsoUrl("http://127.0.0.1:8845", PUBLIC)).toBe(
      "http://127.0.0.1:8845",
    );
    for (const bad of [
      "http://dev.example",
      "https://dev.example/path",
      "https://user@dev.example",
      "https://100.64.0.1",
      "not a url",
      PUBLIC,
    ])
      expect(() => parseTailnetSsoUrl(bad, PUBLIC)).toThrow(
        "THYRA_TAILNET_SSO_URL",
      );
    expect(() => parseTailnetSsoUrl(TAILNET, null)).toThrow(
      "needs the public listener",
    );
  });
});

describe("tailnet sign-in codes", () => {
  test("are single-use, stored as digests and bound to challenge, origin and time", () => {
    const ctx = setup();
    const user = ctx.store.createUser({ name: "owner", role: "admin" });
    const { verifier, challenge } = pkce();
    const issue = () =>
      ctx.codes.issue({
        userId: user.id,
        challenge,
        returnOrigin: PUBLIC,
        flow: "silent",
      }).code;

    const code = issue();
    expect(code.length).toBeGreaterThanOrEqual(43);
    const stored = ctx.store.db
      .query<{ code_hash: string }, []>(
        "SELECT code_hash FROM tailnet_sso_codes",
      )
      .all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.code_hash).not.toContain(code);
    const redeemed = ctx.codes.redeem({ code, verifier, origin: PUBLIC });
    expect(redeemed.ok && redeemed.user.id).toBe(user.id);
    // Replay.
    expect(ctx.codes.redeem({ code, verifier, origin: PUBLIC })).toEqual({
      ok: false,
      reason: "invalid",
    });

    // Verifier mismatch burns the code.
    const wrongVerifier = issue();
    expect(
      ctx.codes.redeem({
        code: wrongVerifier,
        verifier: randomToken(32),
        origin: PUBLIC,
      }),
    ).toEqual({ ok: false, reason: "verifier" });
    expect(
      ctx.codes.redeem({ code: wrongVerifier, verifier, origin: PUBLIC }),
    ).toEqual({ ok: false, reason: "invalid" });

    expect(
      ctx.codes.redeem({ code: issue(), verifier, origin: TAILNET }),
    ).toEqual({ ok: false, reason: "origin" });

    const late = issue();
    ctx.advance(SSO_CODE_TTL_MS);
    expect(ctx.codes.redeem({ code: late, verifier, origin: PUBLIC })).toEqual({
      ok: false,
      reason: "expired",
    });

    const disabled = issue();
    ctx.store.setDisabled(user.id, true, "cli");
    expect(
      ctx.codes.redeem({ code: disabled, verifier, origin: PUBLIC }),
    ).toEqual({ ok: false, reason: "account" });

    ctx.codes.pruneExpired();
    expect(
      ctx.store.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tailnet_sso_codes")
        .get()?.n,
    ).toBe(0);
  });
});

describe("silent tailnet sign-in", () => {
  test("answers the CORS preflight for the public origin only", async () => {
    const ctx = setup();
    const preflight = await ctx.call(
      "OPTIONS",
      `${TAILNET}/auth/tailnet-sso/code`,
      tailnetAccess(),
      {
        headers: {
          origin: PUBLIC,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
          "access-control-request-private-network": "true",
        },
      },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(PUBLIC);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toBe(
      "content-type",
    );
    expect(preflight.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
    expect(
      preflight.headers.get("access-control-allow-credentials"),
    ).toBeNull();

    const foreign = await ctx.call(
      "OPTIONS",
      `${TAILNET}/auth/tailnet-sso/code`,
      tailnetAccess(),
      {
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "POST",
        },
      },
    );
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("issues a code to a tailnet device that the public listener redeems once", async () => {
    const ctx = setup();
    const { verifier, challenge } = pkce();
    const issued = await silentCode(ctx, challenge);
    expect(issued.status).toBe(200);
    expect(issued.headers.get("access-control-allow-origin")).toBe(PUBLIC);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const { code, expires_in } = (await issued.json()) as any;
    expect(expires_in).toBe(60);

    const redeem = (body: unknown) =>
      ctx.call("POST", `${PUBLIC}/auth/tailnet-sso/redeem`, publicAccess(), {
        headers: { origin: PUBLIC },
        body,
      });
    const done = await redeem({ code, code_verifier: verifier });
    expect(done.status).toBe(200);
    const user = await ctx.sessionUser(done);
    // The existing tailnet auto-account: created, linked and an admin.
    expect(user?.name).toBe("owner");
    expect(user?.role).toBe("admin");
    expect(ctx.store.findIdentity("tailscale", "owner@example.com")?.id).toBe(
      user!.id,
    );
    expect(ctx.store.listSessions(user!.id)[0]?.authMethod).toBe("tailnet-sso");
    // Signing in clears a previous logout's opt-out and marks the browser
    // as a tailnet device, so its login page offers the tailnet button.
    expect(
      done.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith("__Host-thyra_signed_out=;")),
    ).toBe(true);
    expect(
      done.headers
        .getSetCookie()
        .some((cookie) =>
          cookie.startsWith("__Host-thyra_tailnet_device=1; Path=/; Secure"),
        ),
    ).toBe(true);
    const actions = ctx.store.listAudit().map((row) => row.action);
    expect(actions).toContain("tailnet_sso.issue");
    expect(actions).toContain("session.create");

    const replay = await redeem({ code, code_verifier: verifier });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as any).reason).toBe("invalid");
  });

  test("refuses other origins, verifier mismatches and devices off the tailnet", async () => {
    const ctx = setup();
    const { challenge } = pkce();
    const foreign = await silentCode(
      ctx,
      challenge,
      tailnetAccess(),
      "https://evil.example",
    );
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    expect(await foreign.text()).not.toContain("code");

    // Off the tailnet: not proxied, not a tailnet address, or through a
    // Cloudflare tunnel. whois never runs, whatever the headers say.
    for (const access of [
      tailnetAccess({ proxied: false }),
      tailnetAccess({ clientAddress: "203.0.113.4" }),
      tailnetAccess({ cloudflare: true }),
      tailnetAccess({ clientAddress: "100.64.9.9" }),
    ]) {
      const refused = await silentCode(ctx, challenge, access);
      expect(refused.status).toBe(403);
      // Readable by the page, so it falls back at once.
      expect(refused.headers.get("access-control-allow-origin")).toBe(PUBLIC);
    }
    expect(ctx.store.userCount()).toBe(0);

    const bad = await silentCode(ctx, "short");
    expect(bad.status).toBe(400);

    const issued = (await (await silentCode(ctx, challenge)).json()) as any;
    const mismatch = await ctx.call(
      "POST",
      `${PUBLIC}/auth/tailnet-sso/redeem`,
      publicAccess(),
      { body: { code: issued.code, code_verifier: randomToken(32) } },
    );
    expect(mismatch.status).toBe(401);
    expect(((await mismatch.json()) as any).reason).toBe("verifier");
  });

  test("an expired code is refused", async () => {
    const ctx = setup();
    const { verifier, challenge } = pkce();
    const { code } = (await (await silentCode(ctx, challenge)).json()) as any;
    ctx.advance(SSO_CODE_TTL_MS + 1);
    const late = await ctx.call(
      "POST",
      `${PUBLIC}/auth/tailnet-sso/redeem`,
      publicAccess(),
      { body: { code, code_verifier: verifier } },
    );
    expect(late.status).toBe(401);
    expect(((await late.json()) as any).reason).toBe("expired");
  });

  test("is rate-limited per tailnet address and redemption failures per client", async () => {
    const ctx = setup();
    const { challenge } = pkce();
    let status = 200;
    for (let index = 0; index < 21 && status === 200; index += 1)
      status = (await silentCode(ctx, challenge)).status;
    expect(status).toBe(429);

    let redeemStatus = 401;
    for (let index = 0; index < 11 && redeemStatus === 401; index += 1)
      redeemStatus = (
        await ctx.call(
          "POST",
          `${PUBLIC}/auth/tailnet-sso/redeem`,
          publicAccess(),
          { body: { code: randomToken(32), code_verifier: randomToken(32) } },
        )
      ).status;
    expect(redeemStatus).toBe(429);
  });

  test("each side serves only its own listener", async () => {
    const ctx = setup();
    const { challenge } = pkce();
    expect((await silentCode(ctx, challenge, publicAccess())).status).toBe(404);
    expect(
      (
        await ctx.call(
          "GET",
          `${TAILNET}/auth/tailnet-sso/start`,
          tailnetAccess(),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await ctx.call(
          "POST",
          `${TAILNET}/auth/tailnet-sso/redeem`,
          tailnetAccess({ listener: "local" }),
          { body: {} },
        )
      ).status,
    ).toBe(404);
  });
});

describe("redirect tailnet sign-in", () => {
  /** start -> authorize -> the callback URL and the state cookie. */
  async function roundTrip(ctx: ReturnType<typeof setup>) {
    const started = await ctx.call(
      "GET",
      `${PUBLIC}/auth/tailnet-sso/start`,
      publicAccess(),
    );
    expect(started.status).toBe(303);
    const flowCookie = started.headers.getSetCookie()[0]!;
    expect(flowCookie).toStartWith("__Host-thyra_tailnet_sso=");
    expect(flowCookie).toContain("HttpOnly");
    expect(flowCookie).toContain("Secure");
    const authorizeUrl = new URL(started.headers.get("location")!);
    expect(authorizeUrl.origin).toBe(TAILNET);
    expect(authorizeUrl.pathname).toBe("/auth/tailnet-sso/authorize");
    expect(authorizeUrl.searchParams.get("return")).toBe(PUBLIC);
    const authorized = await ctx.call(
      "GET",
      authorizeUrl.href,
      tailnetAccess(),
    );
    expect(authorized.status).toBe(303);
    const callback = new URL(authorized.headers.get("location")!);
    expect(callback.origin).toBe(PUBLIC);
    expect(callback.pathname).toBe("/auth/tailnet-sso/callback");
    expect(callback.searchParams.get("state")).toBe(
      authorizeUrl.searchParams.get("state"),
    );
    return { callback, cookie: flowCookie.split(";")[0]! };
  }

  test("round-trips to a session, once", async () => {
    const ctx = setup();
    const { callback, cookie } = await roundTrip(ctx);
    const done = await ctx.call("GET", callback.href, publicAccess(), {
      headers: { cookie },
    });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/");
    expect((await ctx.sessionUser(done))?.name).toBe("owner");
    expect(
      done.headers
        .getSetCookie()
        .some((value) => value.startsWith("__Host-thyra_tailnet_sso=;")),
    ).toBe(true);

    const replay = await ctx.call("GET", callback.href, publicAccess(), {
      headers: { cookie },
    });
    expect(replay.headers.get("location")).toBe("/login?tailnet=failed");
    expect(await ctx.sessionUser(replay)).toBeNull();
  });

  test("refuses a wrong or missing state cookie", async () => {
    const ctx = setup();
    const { callback } = await roundTrip(ctx);
    const other = await roundTrip(ctx);
    for (const cookie of [other.cookie, ""]) {
      const refused = await ctx.call("GET", callback.href, publicAccess(), {
        headers: cookie ? { cookie } : {},
      });
      expect(refused.headers.get("location")).toBe("/login?tailnet=failed");
      expect(await ctx.sessionUser(refused)).toBeNull();
    }
  });

  test("an expired code sends the visitor back to log in", async () => {
    const ctx = setup();
    const { callback, cookie } = await roundTrip(ctx);
    ctx.advance(SSO_CODE_TTL_MS + 1);
    const late = await ctx.call("GET", callback.href, publicAccess(), {
      headers: { cookie },
    });
    expect(late.headers.get("location")).toBe("/login?tailnet=expired");
  });

  test("never redirects anywhere but the public origin", async () => {
    const ctx = setup();
    const { challenge } = pkce();
    const state = randomToken(32);
    for (const target of [
      "https://evil.example",
      `${PUBLIC}.evil.example`,
      `${PUBLIC}/path`,
      "",
    ]) {
      const refused = await ctx.call(
        "GET",
        `${TAILNET}/auth/tailnet-sso/authorize?${new URLSearchParams({ state, code_challenge: challenge, return: target })}`,
        tailnetAccess(),
      );
      expect(refused.status).toBe(400);
      expect(refused.headers.get("location")).toBeNull();
    }
  });

  test("a device off the tailnet returns to the login page with an explanation", async () => {
    const ctx = setup();
    const { challenge } = pkce();
    const refused = await ctx.call(
      "GET",
      `${TAILNET}/auth/tailnet-sso/authorize?${new URLSearchParams({ state: randomToken(32), code_challenge: challenge, return: PUBLIC })}`,
      tailnetAccess({ proxied: false }),
    );
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toBe(
      `${PUBLIC}/login?tailnet=unavailable`,
    );
    expect(ctx.store.userCount()).toBe(0);
  });
});

describe("the public login page", () => {
  const loginPage = (
    ctx: ReturnType<typeof setup>,
    path: string,
    cookie = "",
  ) =>
    ctx.routes.handle(
      "login.page",
      new Request(`${PUBLIC}${path}`, { headers: cookie ? { cookie } : {} }),
      new URL(`${PUBLIC}${path}`),
      publicAccess(),
      null,
    ) as Promise<Response>;

  test("tries silent sign-in first, unless the visitor logged out", async () => {
    const ctx = setup();
    const html = await (await loginPage(ctx, "/login")).text();
    expect(html).toContain('<div id="choices" hidden>');
    expect(html).toContain('"tailnet":{"silent":true,"known":false}');
    // Nothing names the tailnet listener or shows its button to strangers.
    expect(html).not.toContain("dev.example");
    expect(html).not.toContain('id="tailnet"');
    expect(html).toContain("Checking this device...");

    const logout = (await ctx.routes.handle(
      "logout",
      new Request(`${PUBLIC}/api/logout`, {
        method: "POST",
        headers: { "x-thyra-logout": "1" },
      }),
      new URL(`${PUBLIC}/api/logout`),
      publicAccess(),
      null,
    )) as Response;
    const signedOut = logout.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-thyra_signed_out=1"));
    expect(signedOut).toBeDefined();
    const after = await (
      await loginPage(ctx, "/login", signedOut!.split(";")[0]!)
    ).text();
    expect(after).toContain('"silent":false');
    expect(after).toContain('<div id="choices">');

    const failed = await (
      await loginPage(ctx, "/login?tailnet=unavailable")
    ).text();
    expect(failed).toContain('"silent":false');
    expect(failed).toContain("not on the owner's tailnet");
  });

  test("marks a browser that signed in through the tailnet before", async () => {
    const ctx = setup();
    const html = await (
      await loginPage(ctx, "/login", "__Host-thyra_tailnet_device=1")
    ).text();
    expect(html).toContain('"tailnet":{"silent":true,"known":true}');
    expect(html).not.toContain("dev.example");
  });

  test("tells only the login page's tailnet code path where the listener is", async () => {
    const ctx = setup();
    const config = await ctx.call(
      "GET",
      `${PUBLIC}/auth/tailnet-sso/config`,
      publicAccess(),
    );
    expect(config.status).toBe(200);
    expect(config.headers.get("cache-control")).toBe("no-store");
    expect(await config.json()).toEqual({ url: TAILNET });
    expect(
      (
        await ctx.call(
          "GET",
          `${TAILNET}/auth/tailnet-sso/config`,
          tailnetAccess(),
        )
      ).status,
    ).toBe(404);
  });

  test("allows the tailnet listener in the CSP without naming a sibling host", () => {
    expect(
      tailnetConnectSource("https://dev.yubo.fun", "https://thyra.yubo.fun"),
    ).toBe("https://*.yubo.fun");
    expect(
      tailnetConnectSource(
        "https://dev.yubo.fun:8443",
        "https://thyra.yubo.fun",
      ),
    ).toBe("https://*.yubo.fun:8443");
    // No shared parent, or a parent that is only a TLD: the exact origin.
    expect(tailnetConnectSource(TAILNET, PUBLIC)).toBe(TAILNET);
    expect(
      tailnetConnectSource("https://dev.other.example", "https://thyra.x.io"),
    ).toBe("https://dev.other.example");
    expect(
      tailnetConnectSource("http://127.0.0.1:9", "https://thyra.yubo.fun"),
    ).toBe("http://127.0.0.1:9");
  });

  test("renders without tailnet sign-in elsewhere", () => {
    const html = renderLoginPage("en");
    expect(html).not.toContain("tailnet-sso");
    expect(html).not.toContain(" hidden");
    const zh = renderLoginPage("zh-CN", {
      silent: false,
      known: true,
      message: null,
    });
    expect(zh).not.toContain('id="tailnet"');
    expect(zh).toContain('"tailnet":{"silent":false,"known":true}');
  });
});
