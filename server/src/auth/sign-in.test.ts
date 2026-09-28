import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AVATAR_MAX_BYTES,
  createAvatarFiles,
  inspectAvatar,
} from "../accounts/avatars";
import { openAccountDatabase } from "../accounts/database";
import { createAccountStore, randomToken } from "../accounts/store";
import { matchHttpRoute } from "../authz/http-policy";
import { testDeps } from "../authz/test-principals";
import { createLoginRateLimiter } from "../http/login-rate-limit";
import type { RequestAccess } from "../http/request-access";
import { createAccountRoutes } from "./account-routes";
import {
  createEmailCodeStore,
  createResendMailer,
  EMAIL_CODE_TTL_MS,
  EMAIL_COOLDOWN_MS,
  normalizeEmail,
} from "./email";
import { createOAuthFlowStore } from "./oauth";
import { createPasskeyService } from "./passkeys";
import { createAuthenticator, type Principal } from "./principal";
import { loadAuthProviders } from "./providers";
import { createAuthRoutes } from "./routes";
import { createInviteStore } from "./sign-in";
import { createSignInRoutes } from "./sign-in-routes";
import { mailedSecrets, startStubProviders } from "./test-providers";

const ORIGIN = "https://thyra.example";
let stub: Awaited<ReturnType<typeof startStubProviders>>;
const dirs: string[] = [];

beforeAll(async () => {
  stub = await startStubProviders();
});
afterAll(() => {
  stub.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function access(overrides: Partial<RequestAccess> = {}): RequestAccess {
  return {
    listener: "public",
    hostAllowed: true,
    host: "thyra.example",
    ownOrigin: ORIGIN,
    proxied: true,
    local: false,
    secure: true,
    clientAddress: `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
    cloudflare: true,
    ...overrides,
  };
}

function setup(env: Record<string, string> = {}) {
  let clock = 1_700_000_000_000;
  const store = createAccountStore(openAccountDatabase(":memory:"), {
    now: () => clock,
  });
  const providers = loadAuthProviders({ ...stub.env(), ...env });
  const authenticator = createAuthenticator({
    store,
    authRequired: true,
    tailnetMode: "off",
    tailnetUser: async () => null,
    hostOnlyCookie: true,
  });
  const mailer = createResendMailer(providers.email!);
  const codes = createEmailCodeStore(store);
  const flows = createOAuthFlowStore(store);
  const invites = createInviteStore(store);
  const dir = mkdtempSync(join(tmpdir(), "thyra-avatars-"));
  dirs.push(dir);
  const ended: string[] = [];
  const profileChanges: string[] = [];
  const routes = createAuthRoutes({
    store,
    authenticator,
    passkeys: createPasskeyService({ store }),
    limiter: createLoginRateLimiter(),
    authzDeps: testDeps(),
    connectionExists: (id) => id === "c1",
    onChange: () => {},
    onSessionEnded: (hash) => ended.push(hash),
    signIn: createSignInRoutes({
      store,
      authenticator,
      providers,
      mailer,
      codes,
      flows,
      invites,
    }),
    account: createAccountRoutes({
      store,
      providers,
      mailer,
      codes,
      invites,
      avatars: createAvatarFiles(dir),
      inviteOrigin: () => ORIGIN,
      connectionExists: (id) => id === "c1",
      onChange: () => {},
      onSessionEnded: (hash) => ended.push(hash),
      onProfileChanged: (userId) => profileChanges.push(userId),
    }),
  });

  async function principalOf(cookie: string): Promise<Principal | null> {
    return (
      await authenticator.authenticate(
        new Request(`${ORIGIN}/`, { headers: { cookie } }),
        access(),
      )
    ).principal;
  }

  async function call(
    method: string,
    path: string,
    init: {
      body?: unknown;
      raw?: Uint8Array;
      type?: string;
      cookie?: string;
      client?: string;
    } = {},
  ): Promise<Response> {
    const url = new URL(`${ORIGIN}${path}`);
    const route = matchHttpRoute(method, url.pathname);
    if (!route) throw new Error(`no route ${method} ${path}`);
    const headers: Record<string, string> = {};
    if (init.cookie) headers.cookie = init.cookie;
    let body: BodyInit | undefined;
    if (init.raw) {
      body = init.raw as Uint8Array<ArrayBuffer>;
      headers["content-type"] = init.type ?? "image/webp";
    } else if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["content-type"] = "application/json";
    }
    const req = new Request(url, { method, headers, body });
    const principal = init.cookie ? await principalOf(init.cookie) : null;
    const response = await routes.handle(
      route,
      req,
      url,
      access(init.client ? { clientAddress: init.client } : {}),
      principal,
    );
    if (!response) throw new Error(`unhandled ${method} ${path}`);
    return response;
  }

  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-thyra_session="))
      ?.split(";")[0] ?? "";

  return {
    store,
    codes,
    flows,
    invites,
    routes,
    call,
    cookieOf,
    principalOf,
    ended,
    profileChanges,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

type Ctx = ReturnType<typeof setup>;

/** Request a code for an address; the mailed message. */
async function requestCode(ctx: Ctx, email: string, client?: string) {
  const before = stub.mail.length;
  const response = await ctx.call("POST", "/auth/email/start", {
    body: { email },
    ...(client ? { client } : {}),
  });
  return {
    response,
    body: (await response.json().catch(() => ({}))) as { flow: string },
    mail: stub.mail.length > before ? stub.mail.at(-1)! : null,
  };
}

/** A signed-in account: create it, link its email, sign in by code. */
async function signedIn(ctx: Ctx, email = "owner@example.com") {
  const user = ctx.store.createUser({ name: "owner", role: "admin" });
  ctx.store.linkIdentity({
    provider: "email",
    subject: email,
    userId: user.id,
    email,
    emailVerified: true,
  });
  const { mail } = await requestCode(ctx, email);
  const { code, flow } = mailedSecrets(mail!);
  const done = await ctx.call("POST", "/auth/email/verify", {
    body: { flow, code },
  });
  return { user, cookie: ctx.cookieOf(done) };
}

describe("email sign-in", () => {
  test("normalizes addresses", () => {
    expect(normalizeEmail(" Pat@Example.COM ")).toBe("pat@example.com");
    for (const bad of ["", "pat", "pat@", "@example.com", "a b@c.de", 7])
      expect(normalizeEmail(bad)).toBeNull();
  });

  test("mails a code and a link that sign in once, in both languages", async () => {
    const ctx = setup();
    const user = ctx.store.createUser({ name: "pat", role: "member" });
    ctx.store.linkIdentity({
      provider: "email",
      subject: "pat@example.com",
      userId: user.id,
      email: "pat@example.com",
      emailVerified: true,
    });
    const { response, body, mail } = await requestCode(ctx, "PAT@example.com");
    expect(response.status).toBe(200);
    expect(mail!.to).toEqual(["pat@example.com"]);
    expect(mail!.from).toBe("Thyra <login@example.com>");
    expect(mail!.html).toContain("登录验证码");
    expect(mail!.html).toContain("sign-in code");
    expect(mail!.text).toContain("10");
    const { code, flow, link } = mailedSecrets(mail!);
    expect(flow).toBe(body.flow);
    expect(code).toMatch(/^\d{6}$/);
    // Only digests are stored.
    const row = ctx.store.db
      .query<{ code_hash: string; link_hash: string }, []>(
        "SELECT code_hash, link_hash FROM email_codes",
      )
      .get()!;
    expect(JSON.stringify(row)).not.toContain(code);
    expect(JSON.stringify(row)).not.toContain(link);

    const done = await ctx.call("POST", "/auth/email/verify", {
      body: { flow, code },
    });
    expect(done.status).toBe(200);
    expect(((await done.json()) as any).status).toBe("signed_in");
    const principal = await ctx.principalOf(ctx.cookieOf(done));
    expect(principal?.kind === "user" && principal.user.id).toBe(user.id);
    // Replay of the code, and of the link, which shared the message.
    for (const again of [
      { flow, code },
      { flow, link },
    ]) {
      const replay = await ctx.call("POST", "/auth/email/verify", {
        body: again,
      });
      expect(replay.status).toBe(401);
      expect(((await replay.json()) as any).reason).toBe("used");
    }

    ctx.advance(EMAIL_COOLDOWN_MS + 1);
    const second = await requestCode(ctx, "pat@example.com");
    const secrets = mailedSecrets(second.mail!);
    const byLink = await ctx.call("POST", "/auth/email/verify", {
      body: { flow: secrets.flow, link: secrets.link },
    });
    expect(byLink.status).toBe(200);
    expect(ctx.store.listAudit(20).map((row) => row.action)).toContain(
      "session.create",
    );
  });

  test("expires, limits wrong codes, and cools each address down for a minute", async () => {
    const ctx = setup();
    const first = await requestCode(ctx, "late@example.com");
    // Within the cooldown: the same answer, nothing sent.
    const again = await requestCode(ctx, "late@example.com");
    expect(again.response.status).toBe(200);
    expect(again.mail).toBeNull();
    expect(again.body.flow).not.toBe(first.body.flow);
    const { code, flow } = mailedSecrets(first.mail!);
    ctx.advance(EMAIL_CODE_TTL_MS + 1);
    const late = await ctx.call("POST", "/auth/email/verify", {
      body: { flow, code },
    });
    expect(((await late.json()) as any).reason).toBe("expired");

    const fresh = await requestCode(ctx, "late@example.com");
    const secrets = mailedSecrets(fresh.mail!);
    const wrong = secrets.code === "000000" ? "111111" : "000000";
    for (let index = 0; index < 5; index += 1)
      await ctx.call("POST", "/auth/email/verify", {
        body: { flow: secrets.flow, code: wrong },
        client: `198.51.100.${index}`,
      });
    const locked = await ctx.call("POST", "/auth/email/verify", {
      body: { flow: secrets.flow, code: secrets.code },
    });
    expect(((await locked.json()) as any).reason).toBe("attempts");
  });

  test("never reveals whether an address has an account", async () => {
    const ctx = setup();
    const user = ctx.store.createUser({ name: "known", role: "member" });
    ctx.store.linkIdentity({
      provider: "email",
      subject: "known@example.com",
      userId: user.id,
      email: "known@example.com",
      emailVerified: true,
    });
    const known = await requestCode(ctx, "known@example.com");
    const unknown = await requestCode(ctx, "nobody@example.com");
    expect(known.response.status).toBe(unknown.response.status);
    expect(Object.keys(known.body)).toEqual(Object.keys(unknown.body));
    expect(known.mail!.subject.replace(/\d{6}/, "")).toBe(
      unknown.mail!.subject.replace(/\d{6}/, ""),
    );
    // Only after proving the address does it learn there is no access.
    const { code, flow } = mailedSecrets(unknown.mail!);
    const done = await ctx.call("POST", "/auth/email/verify", {
      body: { flow, code },
    });
    expect(await done.json()).toEqual({
      status: "unknown",
      label: "nobody@example.com",
    });
    expect(ctx.cookieOf(done)).toBe("");
    expect(ctx.store.userCount()).toBe(1);
  });

  test("open sign-up creates a member for a verified address", async () => {
    const ctx = setup({ THYRA_SIGNUP: "open" });
    const { mail } = await requestCode(ctx, "new@example.com");
    const { code, flow } = mailedSecrets(mail!);
    const done = await ctx.call("POST", "/auth/email/verify", {
      body: { flow, code },
    });
    const principal = await ctx.principalOf(ctx.cookieOf(done));
    expect(principal?.kind === "user" && principal.user.role).toBe("member");
  });

  test("limits emails per client address", async () => {
    const ctx = setup();
    let status = 200;
    for (let index = 0; index < 11 && status === 200; index += 1)
      status = (
        await requestCode(ctx, `flood${index}@example.com`, "192.0.2.77")
      ).response.status;
    expect(status).toBe(429);
  });

  test("a failed delivery gives the cooldown back", async () => {
    const ctx = setup();
    stub.state.resendStatus = 500;
    try {
      const failed = await requestCode(ctx, "retry@example.com");
      expect(failed.response.status).toBe(503);
    } finally {
      stub.state.resendStatus = 200;
    }
    const retried = await requestCode(ctx, "retry@example.com");
    expect(retried.mail).not.toBeNull();
  });
});

/** Start an OAuth flow and follow the stub provider back to the callback. */
async function oauthRoundTrip(
  ctx: Ctx,
  provider: "github" | "google",
  options: { intent?: "login" | "link"; cookie?: string; invite?: string } = {},
) {
  const started = await ctx.call("POST", `/auth/oauth/${provider}/start`, {
    body: {
      intent: options.intent ?? "login",
      ...(options.invite ? { invite: options.invite } : {}),
    },
    ...(options.cookie ? { cookie: options.cookie } : {}),
  });
  expect(started.status).toBe(200);
  const flowCookie = started.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-thyra_oauth="))!
    .split(";")[0]!;
  const start = (await started.json()) as {
    url: string;
    flow: string;
    poll: string;
    pairing: string;
  };
  const authorize = new URL(start.url);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    `${ORIGIN}/auth/oauth/${provider}/callback`,
  );
  const redirected = await fetch(authorize, { redirect: "manual" });
  const callback = new URL(redirected.headers.get("location")!);
  return { start, flowCookie, callback };
}

describe("GitHub and Google sign-in", () => {
  test("link by provider subject; the same browser is signed in at once", async () => {
    const ctx = setup();
    const { user, cookie } = await signedIn(ctx);
    // Linking needs a signed-in account.
    const refused = await ctx.call("POST", "/auth/oauth/github/start", {
      body: { intent: "link" },
    });
    expect(refused.status).toBe(401);
    const link = await oauthRoundTrip(ctx, "github", {
      intent: "link",
      cookie,
    });
    const linked = await ctx.call(
      "GET",
      `${link.callback.pathname}${link.callback.search}`,
      { cookie: `${cookie}; ${link.flowCookie}` },
    );
    expect(linked.status).toBe(303);
    expect(ctx.store.findIdentity("github", "101")?.id).toBe(user.id);

    // Later: signing in with GitHub finds the account by its subject, even
    // after GitHub's address changed.
    stub.state.github.emails = [
      { email: "changed@example.com", primary: true, verified: true },
    ];
    try {
      const login = await oauthRoundTrip(ctx, "github");
      const done = await ctx.call(
        "GET",
        `${login.callback.pathname}${login.callback.search}`,
        { cookie: login.flowCookie },
      );
      expect(done.status).toBe(303);
      const principal = await ctx.principalOf(ctx.cookieOf(done));
      expect(principal?.kind === "user" && principal.user.id).toBe(user.id);
      // The state is single-use.
      const replay = await ctx.call(
        "GET",
        `${login.callback.pathname}${login.callback.search}`,
        { cookie: login.flowCookie },
      );
      expect(await replay.text()).toContain("expired or was already used");
    } finally {
      stub.state.github.emails = [
        { email: "octo@example.com", primary: true, verified: true },
      ];
    }
    expect(stub.failures).toEqual([]);
  });

  test("an email match links only a verified primary or email_verified address", async () => {
    const ctx = setup();
    const { user } = await signedIn(ctx, "person@example.com");
    // Google says the address is not verified: no link, no account.
    stub.state.google.email_verified = false;
    try {
      const unverified = await oauthRoundTrip(ctx, "google");
      const page = await ctx.call(
        "GET",
        `${unverified.callback.pathname}${unverified.callback.search}`,
        { cookie: unverified.flowCookie },
      );
      expect(await page.text()).toContain("Ask the owner for access");
      expect(ctx.store.findIdentity("google", "google-sub-1")).toBeNull();
    } finally {
      stub.state.google.email_verified = true;
    }
    const verified = await oauthRoundTrip(ctx, "google");
    const done = await ctx.call(
      "GET",
      `${verified.callback.pathname}${verified.callback.search}`,
      { cookie: verified.flowCookie },
    );
    expect(done.status).toBe(303);
    expect(ctx.store.findIdentity("google", "google-sub-1")?.id).toBe(user.id);

    // GitHub: a verified address that is not the primary one never links.
    stub.state.github.emails = [
      { email: "other@example.com", primary: true, verified: true },
      { email: "person@example.com", primary: false, verified: true },
    ];
    try {
      const github = await oauthRoundTrip(ctx, "github");
      const page = await ctx.call(
        "GET",
        `${github.callback.pathname}${github.callback.search}`,
        { cookie: github.flowCookie },
      );
      expect(await page.text()).toContain("Signed in as @octocat");
      expect(ctx.store.findIdentity("github", "101")).toBeNull();
    } finally {
      stub.state.github.emails = [
        { email: "octo@example.com", primary: true, verified: true },
      ];
    }
  });

  test("an unverified invitation address never links by email alone", async () => {
    const ctx = setup();
    const invited = ctx.store.createUser({ name: "invited", role: "member" });
    ctx.store.linkIdentity({
      provider: "email",
      subject: "person@example.com",
      userId: invited.id,
      email: "person@example.com",
    });
    const flow = await oauthRoundTrip(ctx, "google");
    const page = await ctx.call(
      "GET",
      `${flow.callback.pathname}${flow.callback.search}`,
      { cookie: flow.flowCookie },
    );
    expect(page.status).toBe(200);
    expect(ctx.store.findIdentity("google", "google-sub-1")).toBeNull();
  });

  test("a Home Screen app picks up a sign-in that returned in another browser", async () => {
    const ctx = setup();
    const { user } = await signedIn(ctx, "person@example.com");
    const flow = await oauthRoundTrip(ctx, "google");
    // Safari has no flow cookie: it asks, showing the pairing number.
    const page = await ctx.call(
      "GET",
      `${flow.callback.pathname}${flow.callback.search}`,
    );
    const html = await page.text();
    expect(html).toContain(flow.start.pairing);
    expect(ctx.cookieOf(page)).toBe("");
    const confirm = JSON.parse(
      html.match(
        /<script type="application\/json" id="thyra-auth">(.*?)<\/script>/,
      )![1]!,
    ).confirm as string;

    const poll = (secret = flow.start.poll) =>
      ctx.call("POST", "/auth/oauth/poll", {
        body: { flow: flow.start.flow, poll: secret },
      });
    expect(await (await poll()).json()).toEqual({ status: "pending" });
    expect((await poll(randomToken(32))).status).toBe(404);
    // A wrong confirmation token does nothing.
    const forged = await ctx.call("POST", "/auth/oauth/confirm", {
      body: { flow: flow.start.flow, confirm: randomToken(24), accept: true },
    });
    expect(forged.status).toBe(410);
    const confirmed = await ctx.call("POST", "/auth/oauth/confirm", {
      body: { flow: flow.start.flow, confirm, accept: true },
    });
    expect(await confirmed.json()).toEqual({ status: "done" });

    const done = await poll();
    expect(await done.json()).toEqual({ status: "done" });
    const principal = await ctx.principalOf(ctx.cookieOf(done));
    expect(principal?.kind === "user" && principal.user.id).toBe(user.id);
    // Collected once.
    const again = await poll();
    expect(ctx.cookieOf(again)).toBe("");
  });

  test("declining the confirmation signs nobody in", async () => {
    const ctx = setup();
    await signedIn(ctx, "person@example.com");
    const flow = await oauthRoundTrip(ctx, "google");
    const html = await (
      await ctx.call("GET", `${flow.callback.pathname}${flow.callback.search}`)
    ).text();
    const confirm = JSON.parse(
      html.match(/id="thyra-auth">(.*?)<\/script>/)![1]!,
    ).confirm as string;
    await ctx.call("POST", "/auth/oauth/confirm", {
      body: { flow: flow.start.flow, confirm, accept: false },
    });
    const polled = await ctx.call("POST", "/auth/oauth/poll", {
      body: { flow: flow.start.flow, poll: flow.start.poll },
    });
    expect(((await polled.json()) as any).status).toBe("failed");
  });

  test("an identity linked to another account cannot be linked again", async () => {
    const ctx = setup();
    const other = ctx.store.createUser({ name: "other", role: "member" });
    ctx.store.linkIdentity({
      provider: "github",
      subject: "101",
      userId: other.id,
    });
    const { cookie } = await signedIn(ctx);
    const link = await oauthRoundTrip(ctx, "github", {
      intent: "link",
      cookie,
    });
    const page = await ctx.call(
      "GET",
      `${link.callback.pathname}${link.callback.search}`,
      { cookie: `${cookie}; ${link.flowCookie}` },
    );
    expect(await page.text()).toContain("already linked to another");
    expect(ctx.store.findIdentity("github", "101")?.id).toBe(other.id);
  });
});

describe("invitations", () => {
  test("invite by email creates a pending account with a grant and mails a link", async () => {
    const ctx = setup();
    const { cookie } = await signedIn(ctx);
    const invited = await ctx.call(
      "POST",
      "/api/invites?connection_id=c1&workspace_id=w1",
      { body: { email: "friend@example.com", role: "editor" }, cookie },
    );
    expect(invited.status).toBe(200);
    const body = (await invited.json()) as any;
    expect(body.invited).toBe(true);
    const user = ctx.store.getUser(body.user.id)!;
    expect(ctx.store.grantsOf(user.id).get("c1\u0000w1")).toBe("editor");
    const mail = stub.lastMailTo("friend@example.com")!;
    expect(mail.subject).toContain("Thyra");
    const token = mail.text.match(/\/invite#(\S+)/)![1]!;

    const check = await ctx.call("POST", "/auth/invite/check", {
      body: { token },
    });
    expect(((await check.json()) as any).email).toBe("friend@example.com");
    // Accepting with GitHub links GitHub to the invited account.
    const flow = await oauthRoundTrip(ctx, "github", { invite: token });
    const done = await ctx.call(
      "GET",
      `${flow.callback.pathname}${flow.callback.search}`,
      { cookie: flow.flowCookie },
    );
    expect(done.status).toBe(303);
    expect(ctx.store.findIdentity("github", "101")?.id).toBe(user.id);
    // The invitation was used.
    const replay = await ctx.call("POST", "/auth/invite/accept", {
      body: { token },
    });
    expect(replay.status).toBe(404);
  });

  test("accepting by the link signs in and verifies the address", async () => {
    const ctx = setup();
    const { cookie } = await signedIn(ctx);
    await ctx.call("POST", "/api/invites?connection_id=c1&workspace_id=w1", {
      body: { email: "mate@example.com" },
      cookie,
    });
    const token = stub
      .lastMailTo("mate@example.com")!
      .text.match(/\/invite#(\S+)/)![1]!;
    const accepted = await ctx.call("POST", "/auth/invite/accept", {
      body: { token },
    });
    const principal = await ctx.principalOf(ctx.cookieOf(accepted));
    expect(principal?.kind === "user" && principal.user.name).toBe("mate");
    const identity = ctx.store
      .identitiesOf((principal as any).user.id)
      .find((entry) => entry.provider === "email")!;
    expect(identity.emailVerified).toBe(true);
  });
});

describe("the account page", () => {
  test("never removes the last way to sign in", async () => {
    const ctx = setup();
    const { user, cookie } = await signedIn(ctx);
    const methods = (await (
      await ctx.call("GET", "/api/auth/methods", { cookie })
    ).json()) as any;
    expect(methods.method_count).toBe(1);
    expect(methods.providers).toEqual({
      email: true,
      github: true,
      google: true,
    });
    const last = await ctx.call("POST", "/api/auth/identities/remove", {
      body: { provider: "email", subject: "owner@example.com" },
      cookie,
    });
    expect(last.status).toBe(409);
    ctx.store.linkIdentity({
      provider: "github",
      subject: "9",
      userId: user.id,
    });
    const removed = await ctx.call("POST", "/api/auth/identities/remove", {
      body: { provider: "email", subject: "owner@example.com" },
      cookie,
    });
    expect(removed.status).toBe(200);
    expect(ctx.store.listAudit(5).map((row) => row.action)).toContain(
      "identity.unlink",
    );
  });

  test("hides the Tailscale identity from members off the tailnet", async () => {
    const ctx = setup();
    const member = ctx.store.createUser({ name: "m", role: "member" });
    ctx.store.linkIdentity({
      provider: "tailscale",
      subject: "m@github",
      userId: member.id,
    });
    ctx.store.linkIdentity({
      provider: "email",
      subject: "m@example.com",
      userId: member.id,
      email: "m@example.com",
      emailVerified: true,
    });
    const { mail } = await requestCode(ctx, "m@example.com");
    const { code, flow } = mailedSecrets(mail!);
    const cookie = ctx.cookieOf(
      await ctx.call("POST", "/auth/email/verify", { body: { flow, code } }),
    );
    const methods = await (
      await ctx.call("GET", "/api/auth/methods", { cookie })
    ).text();
    expect(methods).not.toContain("tailscale");
    const me = await (await ctx.call("GET", "/api/auth/me", { cookie })).text();
    expect(me).not.toContain("tailscale");
  });

  test("adds an email address by code", async () => {
    const ctx = setup();
    const { user, cookie } = await signedIn(ctx);
    const added = await ctx.call("POST", "/api/auth/email/add", {
      body: { email: "second@example.com" },
      cookie,
    });
    const { flow } = (await added.json()) as { flow: string };
    const mail = stub.lastMailTo("second@example.com")!;
    expect(mail.text).not.toContain("/auth/email#");
    const code = mailedSecrets(mail).code;
    const confirmed = await ctx.call("POST", "/api/auth/email/confirm", {
      body: { flow, code },
      cookie,
    });
    expect(confirmed.status).toBe(200);
    expect(ctx.store.findIdentity("email", "second@example.com")?.id).toBe(
      user.id,
    );
    expect(ctx.store.signInMethodCount(user.id)).toBe(2);
  });

  test("uploads, serves and replaces an avatar", async () => {
    const ctx = setup();
    const { user, cookie } = await signedIn(ctx);
    const image = webp(256, 256);
    const uploaded = await ctx.call("POST", "/api/auth/avatar", {
      raw: image,
      cookie,
    });
    expect(uploaded.status).toBe(200);
    const { avatar_url } = (await uploaded.json()) as { avatar_url: string };
    expect(avatar_url).toMatch(/^\/avatars\/[0-9a-f]{64}\.webp$/);
    expect(ctx.profileChanges).toContain(user.id);
    const served = await ctx.call("GET", avatar_url, { cookie });
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(served.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(image);

    const tooBig = await ctx.call("POST", "/api/auth/avatar", {
      raw: webp(512, 512),
      cookie,
    });
    expect(tooBig.status).toBe(415);
    const notImage = await ctx.call("POST", "/api/auth/avatar", {
      raw: new TextEncoder().encode("<svg onload=alert(1)>"),
      cookie,
    });
    expect(notImage.status).toBe(415);
  });

  test("imports a linked provider's picture through the server", async () => {
    const ctx = setup();
    const { cookie } = await signedIn(ctx, "person@example.com");
    const flow = await oauthRoundTrip(ctx, "google");
    await ctx.call("GET", `${flow.callback.pathname}${flow.callback.search}`, {
      cookie: flow.flowCookie,
    });
    const source = await ctx.call(
      "GET",
      "/api/auth/avatar/source?provider=google",
      { cookie },
    );
    expect(source.status).toBe(200);
    expect(source.headers.get("content-type")).toBe("image/png");
  });

  test("signs out every other session", async () => {
    const ctx = setup();
    const { user, cookie } = await signedIn(ctx);
    const other = ctx.store.createSession({
      userId: user.id,
      authMethod: "passkey",
    });
    const response = await ctx.call(
      "POST",
      "/api/auth/sessions/revoke-others",
      {
        body: {},
        cookie,
      },
    );
    expect(await response.json()).toEqual({ revoked: 1 });
    expect(ctx.ended).toEqual([other.session.idHash]);
    expect(await ctx.principalOf(cookie)).not.toBeNull();
  });
});

/** A minimal lossless WebP header of a given size. */
function webp(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 32, true);
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  view.setUint32(16, 20, true);
  bytes[20] = 0x2f;
  view.setUint32(21, ((height - 1) << 14) | (width - 1), true);
  return bytes;
}

describe("avatar validation", () => {
  test("accepts small WebP and JPEG, refuses everything else", () => {
    expect(inspectAvatar(webp(256, 256))).toEqual({
      ok: true,
      image: { type: "image/webp", width: 256, height: 256 },
    });
    expect(inspectAvatar(webp(257, 10)).ok).toBe(false);
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 64, 0, 48, 1,
      0, 0, 0,
    ]);
    expect(inspectAvatar(jpeg)).toEqual({
      ok: true,
      image: { type: "image/jpeg", width: 48, height: 64 },
    });
    expect(inspectAvatar(new Uint8Array(AVATAR_MAX_BYTES + 1)).ok).toBe(false);
    expect(inspectAvatar(new Uint8Array([0x89, 0x50, 0x4e, 0x47])).ok).toBe(
      false,
    );
    expect(inspectAvatar(new Uint8Array()).ok).toBe(false);
  });
});

describe("provider configuration", () => {
  test("turns each provider on only with its variables, and test URLs only for loopback", () => {
    const none = loadAuthProviders({});
    expect([none.email, none.github, none.google, none.signup]).toEqual([
      null,
      null,
      null,
      "invite",
    ]);
    const half = loadAuthProviders({ THYRA_GITHUB_CLIENT_ID: "x" });
    expect(half.github).toBeNull();
    expect(half.warnings.join()).toContain("THYRA_GITHUB_CLIENT_SECRET");
    const real = loadAuthProviders({
      THYRA_RESEND_API_KEY: "k",
      THYRA_EMAIL_FROM: "a@b.c",
      THYRA_TEST_RESEND_URL: "https://evil.example",
      THYRA_GOOGLE_CLIENT_ID: "g",
      THYRA_GOOGLE_CLIENT_SECRET: "s",
    });
    expect(real.email?.endpoint).toBe("https://api.resend.com/emails");
    expect(real.warnings.join()).toContain("THYRA_TEST_RESEND_URL");
    expect(real.google?.tokenUrl).toBe("https://oauth2.googleapis.com/token");
  });
});
