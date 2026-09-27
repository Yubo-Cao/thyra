import { describe, expect, test } from "bun:test";
import { openAccountDatabase } from "../accounts/database";
import { type AccountStore, createAccountStore } from "../accounts/store";
import { createLoginRateLimiter } from "../http/login-rate-limit";
import type { RequestAccess } from "../http/request-access";
import { testDeps } from "../authz/test-principals";
import { createPasskeyService, passkeyOrigin } from "./passkeys";
import {
  createAuthenticator,
  parseTailnetAuthMode,
  type Principal,
  SESSION_COOKIE,
} from "./principal";
import { createAuthRoutes } from "./routes";
import { createSoftwareAuthenticator } from "./test-authenticator";

const ORIGIN = "https://thyra.example";

function access(overrides: Partial<RequestAccess> = {}): RequestAccess {
  return {
    hostAllowed: true,
    host: "thyra.example",
    ownOrigin: ORIGIN,
    proxied: false,
    local: false,
    secure: true,
    clientAddress: "203.0.113.9",
    listener: "tailnet",
    cloudflare: false,
    ...overrides,
  };
}

function setup(
  options: {
    tailnetMode?: "admin" | "member" | "off";
    whois?: Record<string, string>;
  } = {},
) {
  const store = createAccountStore(openAccountDatabase(":memory:"));
  const authenticator = createAuthenticator({
    store,
    authRequired: false,
    tailnetMode: options.tailnetMode ?? "admin",
    tailnetUser: async (address) =>
      options.whois?.[address] ? { login: options.whois[address]! } : null,
  });
  const ended: string[] = [];
  const routes = createAuthRoutes({
    store,
    authenticator,
    passkeys: createPasskeyService({ store }),
    limiter: createLoginRateLimiter(),
    authzDeps: {
      ...testDeps(),
      roleOn: (principal, _connection, workspace) =>
        principal.kind === "local" || principal.user.role === "admin"
          ? "owner"
          : (store.grantsOf(principal.user.id).get(`c1\u0000${workspace}`) ??
            null),
    },
    connectionExists: (id) => id === "c1",
    onChange: () => {},
    onSessionEnded: (hash) => ended.push(hash),
  });
  return { store, authenticator, routes, ended };
}

function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  expect(header).toContain(`${SESSION_COOKIE}=`);
  expect(header).toContain("HttpOnly");
  expect(header).toContain("Secure");
  return header.split(";", 1)[0]!;
}

async function principalFor(
  ctx: ReturnType<typeof setup>,
  cookie: string,
): Promise<Principal | null> {
  return (
    await ctx.authenticator.authenticate(
      new Request(`${ORIGIN}/`, { headers: { cookie } }),
      access(),
    )
  ).principal;
}

const post = (path: string, body: unknown, cookie = "") =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

async function enroll(
  ctx: ReturnType<typeof setup>,
  secret: string,
  authenticator: Awaited<ReturnType<typeof createSoftwareAuthenticator>>,
) {
  const start = await ctx.routes.handle(
    "passkey.register",
    post("/api/auth/passkey/register/options", { secret }),
    new URL(`${ORIGIN}/api/auth/passkey/register/options`),
    access(),
    null,
  );
  expect(start?.status).toBe(200);
  const { flow, options } = (await start!.json()) as any;
  return ctx.routes.handle(
    "passkey.register",
    post("/api/auth/passkey/register/verify", {
      flow,
      response: authenticator.create(options, ORIGIN),
    }),
    new URL(`${ORIGIN}/api/auth/passkey/register/verify`),
    access(),
    null,
  );
}

async function login(
  ctx: ReturnType<typeof setup>,
  authenticator: Awaited<ReturnType<typeof createSoftwareAuthenticator>>,
) {
  const start = await ctx.routes.handle(
    "passkey.login",
    post("/api/auth/passkey/login/options", {}),
    new URL(`${ORIGIN}/api/auth/passkey/login/options`),
    access(),
    null,
  );
  const { flow, options } = (await start!.json()) as any;
  return ctx.routes.handle(
    "passkey.login",
    post("/api/auth/passkey/login/verify", {
      flow,
      response: await authenticator.get(options, ORIGIN, "thyra.example"),
    }),
    new URL(`${ORIGIN}/api/auth/passkey/login/verify`),
    access(),
    null,
  );
}

describe("passkeys", () => {
  test("need a secure, named origin", () => {
    expect(passkeyOrigin("https://thyra.example")).toEqual({
      origin: "https://thyra.example",
      rpId: "thyra.example",
    });
    expect(passkeyOrigin("http://localhost:8787")?.rpId).toBe("localhost");
    expect(passkeyOrigin("http://192.168.1.5:8787")).toBeNull();
    expect(passkeyOrigin("https://192.168.1.5")).toBeNull();
    expect(passkeyOrigin("http://thyra.example")).toBeNull();
  });

  test("enrollment registers a passkey once and logs in; login works after", async () => {
    const ctx = setup();
    const user = ctx.store.createUser({ name: "alice", role: "member" });
    const { secret } = ctx.store.createEnrollment(user.id, "cli");
    const key = await createSoftwareAuthenticator();
    const registered = await enroll(ctx, secret, key);
    expect(registered?.status).toBe(200);
    const cookie = cookieOf(registered!);
    expect((await principalFor(ctx, cookie))?.key).toBe(`user:${user.id}`);
    expect(
      ctx.store.passkeysOf(user.id).map((passkey) => passkey.rpId),
    ).toEqual(["thyra.example"]);

    // The link is single-use.
    const again = await ctx.routes.handle(
      "passkey.register",
      post("/api/auth/passkey/register/options", { secret }),
      new URL(`${ORIGIN}/api/auth/passkey/register/options`),
      access(),
      null,
    );
    expect(again?.status).toBe(401);

    const loggedIn = await login(ctx, key);
    expect(loggedIn?.status).toBe(200);
    const second = cookieOf(loggedIn!);
    expect(second).not.toBe(cookie);
    expect((await principalFor(ctx, second))?.key).toBe(`user:${user.id}`);
    expect(ctx.store.passkeysOf(user.id)[0]?.counter).toBe(2);
  });

  test("a passkey from another site or origin is refused", async () => {
    const ctx = setup();
    const user = ctx.store.createUser({ name: "eve", role: "member" });
    const key = await createSoftwareAuthenticator();
    await enroll(ctx, ctx.store.createEnrollment(user.id, null).secret, key);
    const start = await ctx.routes.handle(
      "passkey.login",
      post("/api/auth/passkey/login/options", {}),
      new URL(`${ORIGIN}/api/auth/passkey/login/options`),
      access(),
      null,
    );
    const { flow, options } = (await start!.json()) as any;
    const forged = await ctx.routes.handle(
      "passkey.login",
      post("/api/auth/passkey/login/verify", {
        flow,
        response: await key.get(
          options,
          "https://evil.example",
          "thyra.example",
        ),
      }),
      new URL(`${ORIGIN}/api/auth/passkey/login/verify`),
      access(),
      null,
    );
    expect(forged?.status).toBe(401);
    // Plain HTTP on a LAN address cannot use passkeys at all.
    const insecure = await ctx.routes.handle(
      "passkey.login",
      post("/api/auth/passkey/login/options", {}),
      new URL("http://192.168.1.5/api/auth/passkey/login/options"),
      access({ ownOrigin: "http://192.168.1.5:8787", secure: false }),
      null,
    );
    expect(insecure?.status).toBe(400);
  });

  test("ten failed attempts block the client address", async () => {
    const ctx = setup();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await ctx.routes.handle(
        "passkey.register",
        post("/api/auth/passkey/register/options", {
          secret: `guess-${attempt}`,
        }),
        new URL(`${ORIGIN}/api/auth/passkey/register/options`),
        access(),
        null,
      );
      expect(response?.status).toBe(401);
    }
    const blocked = await ctx.routes.handle(
      "passkey.login",
      post("/api/auth/passkey/login/options", {}),
      new URL(`${ORIGIN}/api/auth/passkey/login/options`),
      access(),
      null,
    );
    expect(blocked?.status).toBe(429);
  });
});

describe("authenticator", () => {
  test("direct local use needs no account; everything else does", async () => {
    const ctx = setup();
    const local = await ctx.authenticator.authenticate(
      new Request("http://localhost/"),
      access({ local: true }),
    );
    expect(local.principal?.kind).toBe("local");
    expect(
      (
        await ctx.authenticator.authenticate(
          new Request(`${ORIGIN}/`),
          access(),
        )
      ).principal,
    ).toBeNull();
  });

  test("tailnet users get an admin account once, then use its session", async () => {
    const ctx = setup({ whois: { "100.64.1.2": "yubo@github" } });
    const tailnet = access({ proxied: true, clientAddress: "100.64.1.2" });
    const first = await ctx.authenticator.authenticate(
      new Request(`${ORIGIN}/`),
      tailnet,
    );
    expect(first.principal?.kind).toBe("user");
    if (first.principal?.kind !== "user") throw new Error("expected a user");
    expect(first.principal.user).toMatchObject({ name: "yubo", role: "admin" });
    expect(first.setCookie).toContain("Secure");
    expect(ctx.store.findIdentity("tailscale", "yubo@github")?.id).toBe(
      first.principal.user.id,
    );
    const cookie = first.setCookie!.split(";", 1)[0]!;
    const second = await ctx.authenticator.authenticate(
      new Request(`${ORIGIN}/`, { headers: { cookie } }),
      access({ proxied: true, clientAddress: "203.0.113.5" }),
    );
    expect(second.principal?.key).toBe(first.principal.key);
    expect(second.setCookie).toBeUndefined();
    expect(ctx.store.userCount()).toBe(1);

    // A demoted tailnet account stays demoted; a disabled one is refused.
    ctx.store.setRole(first.principal.user.id, "member", "cli");
    const again = await ctx.authenticator.authenticate(
      new Request(`${ORIGIN}/`),
      tailnet,
    );
    expect(again.principal?.kind === "user" && again.principal.user.role).toBe(
      "member",
    );
    ctx.store.setDisabled(first.principal.user.id, true, "cli");
    expect(
      (await ctx.authenticator.authenticate(new Request(`${ORIGIN}/`), tailnet))
        .principal,
    ).toBeNull();
  });

  test("tailnet login needs the proxy, a tailnet address and a whois user", async () => {
    const ctx = setup({ whois: { "100.64.1.2": "yubo@github" } });
    for (const context of [
      access({ proxied: false, clientAddress: "100.64.1.2" }),
      access({ proxied: true, clientAddress: "100.64.1.3" }),
      access({ proxied: true, clientAddress: "203.0.113.5" }),
    ])
      expect(
        (
          await ctx.authenticator.authenticate(
            new Request(`${ORIGIN}/`),
            context,
          )
        ).principal,
      ).toBeNull();
    const off = setup({
      tailnetMode: "off",
      whois: { "100.64.1.2": "yubo@github" },
    });
    expect(
      (
        await off.authenticator.authenticate(
          new Request(`${ORIGIN}/`),
          access({ proxied: true, clientAddress: "100.64.1.2" }),
        )
      ).principal,
    ).toBeNull();
    const member = setup({
      tailnetMode: "member",
      whois: { "100.64.1.2": "guest@github" },
    });
    const guest = await member.authenticator.authenticate(
      new Request(`${ORIGIN}/`),
      access({ proxied: true, clientAddress: "100.64.1.2" }),
    );
    expect(guest.principal?.kind === "user" && guest.principal.user.role).toBe(
      "member",
    );
    expect(parseTailnetAuthMode(undefined, true).mode).toBe("admin");
    expect(parseTailnetAuthMode("member", false).mode).toBe("off");
    expect(parseTailnetAuthMode("bogus", true).mode).toBe("off");
  });

  test("a privilege change rotates the session on its next request", async () => {
    const ctx = setup();
    const user = ctx.store.createUser({ name: "frank", role: "member" });
    const { token } = ctx.store.createSession({
      userId: user.id,
      authMethod: "passkey",
    });
    const cookie = `${SESSION_COOKIE}=${token}`;
    ctx.store.setRole(user.id, "admin", "cli");
    const rotated = await ctx.authenticator.authenticate(
      new Request(`${ORIGIN}/`, { headers: { cookie } }),
      access(),
    );
    expect(
      rotated.principal?.kind === "user" && rotated.principal.user.role,
    ).toBe("admin");
    expect(rotated.setCookie).toBeDefined();
    const next = rotated.setCookie!.split(";", 1)[0]!;
    expect(next).not.toBe(cookie);
    const settled = await ctx.authenticator.authenticate(
      new Request(`${ORIGIN}/`, { headers: { cookie: next } }),
      access(),
    );
    expect(settled.setCookie).toBeUndefined();
  });
});

describe("account routes", () => {
  async function userCookie(
    store: AccountStore,
    name: string,
    role: "admin" | "member" = "member",
  ) {
    const user = store.createUser({ name, role });
    const { token } = store.createSession({
      userId: user.id,
      authMethod: "passkey",
    });
    return { user, cookie: `${SESSION_COOKIE}=${token}` };
  }

  test("owners share workspaces; editors cannot; nobody edits their own grant", async () => {
    const ctx = setup();
    const owner = await userCookie(ctx.store, "olivia");
    const editor = await userCookie(ctx.store, "ed");
    ctx.store.createUser({ name: "vic", role: "member" });
    ctx.store.setGrant({
      connectionId: "c1",
      workspaceId: "w1",
      userId: owner.user.id,
      role: "owner",
      actor: null,
    });
    ctx.store.setGrant({
      connectionId: "c1",
      workspaceId: "w1",
      userId: editor.user.id,
      role: "editor",
      actor: null,
    });
    const grant = async (cookie: string, user: string, role: string) => {
      const principal = await principalFor(ctx, cookie);
      const url = new URL(
        `${ORIGIN}/api/workspace-grants?connection_id=c1&workspace_id=w1`,
      );
      return ctx.routes.handle(
        "grants.set",
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ user, role }),
        }),
        url,
        access(),
        principal,
      );
    };
    const shared = await grant(owner.cookie, "vic", "viewer");
    expect(shared?.status).toBe(200);
    expect(
      ((await shared!.json()) as any).grants.map((entry: any) => [
        entry.user.name,
        entry.role,
      ]),
    ).toEqual([
      ["ed", "editor"],
      ["olivia", "owner"],
      ["vic", "viewer"],
    ]);
    expect((await grant(editor.cookie, "vic", "owner"))?.status).toBe(403);
    expect((await grant(owner.cookie, "olivia", "none"))?.status).toBe(400);
    expect((await grant(owner.cookie, "nobody", "viewer"))?.status).toBe(404);
    expect((await grant(owner.cookie, "vic", "superuser"))?.status).toBe(400);
  });

  test("users list and revoke only their own sessions; logout ends the current one", async () => {
    const ctx = setup();
    const alice = await userCookie(ctx.store, "alice2");
    const bob = await userCookie(ctx.store, "bob2");
    const alicePrincipal = await principalFor(ctx, alice.cookie);
    const list = await ctx.routes.handle(
      "auth.sessions",
      new Request(`${ORIGIN}/api/auth/sessions`),
      new URL(`${ORIGIN}/api/auth/sessions?all=1`),
      access(),
      alicePrincipal,
    );
    const sessions = ((await list!.json()) as any).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].current).toBe(true);
    const bobSession = ctx.store.listSessions(bob.user.id)[0]!;
    const revoke = await ctx.routes.handle(
      "auth.sessions.revoke",
      post("/api/auth/sessions/revoke", { id: bobSession.publicId }),
      new URL(`${ORIGIN}/api/auth/sessions/revoke`),
      access(),
      alicePrincipal,
    );
    expect(revoke?.status).toBe(404);
    const logout = await ctx.routes.handle(
      "logout",
      new Request(`${ORIGIN}/api/logout`, {
        method: "POST",
        headers: { cookie: alice.cookie, "x-thyra-logout": "1" },
      }),
      new URL(`${ORIGIN}/api/logout`),
      access(),
      null,
    );
    expect(logout?.status).toBe(204);
    expect(logout?.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(ctx.ended).toHaveLength(1);
    expect(await principalFor(ctx, alice.cookie)).toBeNull();
    expect(await principalFor(ctx, bob.cookie)).not.toBeNull();
  });
});
