import { describe, expect, test } from "bun:test";
import type {
  AdminInviteResponse,
  AdminInvitesResponse,
  AdminUserDetail,
  AdminUsersResponse,
} from "../../../shared/admin";
import { openAccountDatabase } from "../accounts/database";
import { createAccountStore, type User } from "../accounts/store";
import { authorizeHttp, matchHttpRoute } from "../authz/http-policy";
import { guest, testDeps } from "../../test-support/authz/principals";
import type { RequestAccess } from "../http/request-access";
import { createAdminRoutes } from "./admin-routes";
import type { Mail } from "./email";
import { LOCAL_PRINCIPAL, type Principal, userPrincipal } from "./principal";
import {
  createInviteStore,
  INVITE_TTL_MS,
  resolveIdentity,
  signupSettings,
} from "./sign-in";

const ORIGIN = "https://thyra.example";

const access = {
  listener: "public",
  hostAllowed: true,
  host: "thyra.example",
  ownOrigin: ORIGIN,
  proxied: true,
  local: false,
  secure: true,
  clientAddress: "203.0.113.9",
  cloudflare: true,
} satisfies RequestAccess;

function setup(options: { email?: boolean } = {}) {
  let clock = 1_700_000_000_000;
  const store = createAccountStore(openAccountDatabase(":memory:"), {
    now: () => clock,
  });
  const invites = createInviteStore(store);
  const mail: Mail[] = [];
  let mailFails = false;
  let changes = 0;
  const routes = createAdminRoutes({
    store,
    invites,
    mailer:
      options.email === false
        ? null
        : {
            async send(message) {
              if (mailFails) throw new Error("smtp down");
              mail.push(message);
              return { id: null };
            },
          },
    inviteOrigin: () => ORIGIN,
    onChange: () => {
      changes += 1;
    },
  });

  /** An account that can sign in (a verified address), with a session. */
  function account(name: string, role: "admin" | "member") {
    const user = store.createUser({ name, role });
    store.linkIdentity({
      provider: "email",
      subject: `${name}@example.com`,
      userId: user.id,
      email: `${name}@example.com`,
      emailVerified: true,
    });
    const { session } = store.createSession({
      userId: user.id,
      authMethod: "email",
    });
    return { user, principal: userPrincipal(user, session) };
  }

  async function call(
    principal: Principal,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const route = matchHttpRoute(method, path.split("?")[0]!);
    if (!route) throw new Error(`no route ${method} ${path}`);
    const decision = await authorizeHttp({
      route,
      principal,
      connectionId: null,
      query: new URLSearchParams(),
      deps: testDeps(),
      editsConnection: () => false,
    });
    if (!decision.ok)
      return { status: decision.status, body: { error: decision.message } };
    const response = await routes.handle(
      route,
      new Request(`${ORIGIN}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
      access,
      principal,
    );
    if (!response) throw new Error(`unhandled ${method} ${path}`);
    return { status: response.status, body: await response.json() };
  }

  return {
    store,
    invites,
    mail,
    call,
    account,
    changes: () => changes,
    failMail: (fails: boolean) => {
      mailFails = fails;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

type Ctx = ReturnType<typeof setup>;

async function users(ctx: Ctx, principal: Principal) {
  const { body } = await ctx.call(principal, "GET", "/api/admin/users");
  return (body as AdminUsersResponse).users;
}

describe("admin routes", () => {
  test("only instance admins, local use included, reach them", async () => {
    const ctx = setup();
    const { principal: admin } = ctx.account("ada", "admin");
    const { principal: member } = ctx.account("max", "member");
    for (const path of [
      "/api/admin/users",
      "/api/admin/invites",
      "/api/admin/signup",
    ]) {
      expect((await ctx.call(admin, "GET", path)).status).toBe(200);
      expect((await ctx.call(LOCAL_PRINCIPAL, "GET", path)).status).toBe(200);
      expect((await ctx.call(member, "GET", path)).status).toBe(403);
      expect((await ctx.call(guest("g"), "GET", path)).status).toBe(403);
    }
    const refused = await ctx.call(member, "POST", "/api/admin/signup", {
      policy: "open",
      domains: [],
    });
    expect(refused.status).toBe(403);
    expect(signupSettings(ctx.store).policy).toBe("invite");
  });

  test("lists every account with its sign-in methods and sessions", async () => {
    const ctx = setup();
    const { user: ada, principal } = ctx.account("ada", "admin");
    ctx.store.addPasskey({
      credentialId: "cred-1",
      userId: ada.id,
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: [],
      rpId: "thyra.example",
      name: "Laptop",
    });
    ctx.advance(5_000);
    const { session } = ctx.store.createSession({
      userId: ada.id,
      authMethod: "passkey",
    });
    await ctx.call(principal, "POST", "/api/admin/invites", {
      email: "New@Example.com",
      role: "member",
    });
    const list = await users(ctx, principal);
    expect(list.map((user) => user.name)).toEqual(["ada", "new"]);
    expect(list[0]).toEqual({
      id: ada.id,
      name: "ada",
      displayName: "ada",
      emails: ["ada@example.com"],
      role: "admin",
      disabled: false,
      pending: false,
      invited: false,
      identities: [
        { provider: "email", label: "ada@example.com" },
        { provider: "passkey", label: "Laptop" },
      ],
      sessions: 2,
      lastSeenAt: session.lastSeenAt,
      createdAt: ada.createdAt,
      self: true,
    });
    expect(list[1]).toMatchObject({
      emails: ["new@example.com"],
      role: "member",
      pending: true,
      invited: true,
      identities: [],
      sessions: 0,
      lastSeenAt: null,
      self: false,
    });
    expect(
      (await users(ctx, LOCAL_PRINCIPAL)).some((user) => user.self),
    ).toBeFalse();
  });

  test("changes roles, disables, removes and revokes sessions, with audit", async () => {
    const ctx = setup();
    const { principal } = ctx.account("ada", "admin");
    const { user: max } = ctx.account("max", "member");
    const role = await ctx.call(principal, "POST", "/api/admin/users/role", {
      user: max.id,
      role: "admin",
    });
    expect(role).toEqual({ status: 200, body: { ok: true } });
    expect(ctx.store.getUser(max.id)?.role).toBe("admin");
    // A role change rotates the account's sessions and reconnects its pages.
    expect(ctx.store.getUser(max.id)!.privilegeEpoch).toBeGreaterThan(
      max.privilegeEpoch,
    );

    await ctx.call(principal, "POST", "/api/admin/users/disable", {
      user: max.id,
      disabled: true,
    });
    expect(ctx.store.getUser(max.id)?.disabled).toBeTrue();
    expect(ctx.store.listSessions(max.id)).toEqual([]);
    await ctx.call(principal, "POST", "/api/admin/users/disable", {
      user: max.id,
      disabled: false,
    });
    expect(ctx.store.getUser(max.id)?.disabled).toBeFalse();

    ctx.store.createSession({ userId: max.id, authMethod: "email" });
    await ctx.call(principal, "POST", "/api/admin/users/revoke-sessions", {
      user: max.id,
    });
    expect(ctx.store.listSessions(max.id)).toEqual([]);

    const removed = await ctx.call(
      principal,
      "POST",
      "/api/admin/users/remove",
      { user: max.id },
    );
    expect(removed.status).toBe(200);
    expect(ctx.store.getUser(max.id)).toBeNull();
    expect(ctx.changes()).toBe(5);
    const actions = ctx.store
      .listAudit(20)
      .filter((row) => row.actor === principal.key.slice(5))
      .map((row) => row.action);
    expect(actions).toEqual([
      "user.delete",
      "session.revoke_all",
      "user.enable",
      "user.disable",
      "user.role",
    ]);

    expect(
      (
        await ctx.call(principal, "POST", "/api/admin/users/role", {
          user: "u_missing",
          role: "member",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await ctx.call(principal, "POST", "/api/admin/users/role", {
          user: principal.key.slice(5),
          role: "owner",
        })
      ).status,
    ).toBe(400);
  });

  test("refuses changes to yourself and to the last admin", async () => {
    const ctx = setup();
    const { user: ada, principal } = ctx.account("ada", "admin");
    for (const [path, body] of [
      ["/api/admin/users/role", { user: ada.id, role: "member" }],
      ["/api/admin/users/disable", { user: ada.id, disabled: true }],
      ["/api/admin/users/remove", { user: ada.id }],
    ] as const) {
      const self = await ctx.call(principal, "POST", path, body);
      expect(self.status).toBe(409);
      expect(self.body.error).toContain("your own account");
      // Local use is an admin too, but would leave no admin account.
      const last = await ctx.call(LOCAL_PRINCIPAL, "POST", path, body);
      expect(last.status).toBe(409);
      expect(last.body.error).toContain("last admin");
    }
    // An invited admin who never signed in does not count.
    await ctx.call(principal, "POST", "/api/admin/invites", {
      email: "bea@example.com",
      role: "admin",
    });
    expect(
      (
        await ctx.call(LOCAL_PRINCIPAL, "POST", "/api/admin/users/remove", {
          user: ada.id,
        })
      ).status,
    ).toBe(409);
    // Another admin who can sign in does.
    ctx.account("cy", "admin");
    expect(
      (
        await ctx.call(LOCAL_PRINCIPAL, "POST", "/api/admin/users/role", {
          user: ada.id,
          role: "member",
        })
      ).status,
    ).toBe(200);
    expect(ctx.store.getUser(ada.id)?.role).toBe("member");
  });

  test("an invitation creates a pending account and its link signs in once", async () => {
    const ctx = setup();
    const { principal } = ctx.account("ada", "admin");
    const created = await ctx.call(principal, "POST", "/api/admin/invites", {
      email: " Bea@Example.com ",
      role: "admin",
    });
    expect(created.status).toBe(200);
    const answer = created.body as AdminInviteResponse;
    expect(answer.emailed).toBeTrue();
    expect(answer.link).toMatch(/^https:\/\/thyra\.example\/invite#[\w-]+$/);
    expect(answer.invite).toMatchObject({
      email: "bea@example.com",
      role: "admin",
      createdBy: "ada",
      expiresAt: answer.invite.createdAt + INVITE_TTL_MS,
    });
    expect(answer.invite.id).toMatch(/^i_/);
    expect(ctx.mail.at(-1)?.to).toBe("bea@example.com");
    expect(ctx.mail.at(-1)?.text).toContain(answer.link);
    const invited = ctx.store.getUser(answer.invite.userId)!;
    expect(invited.role).toBe("admin");

    const listed = (await ctx.call(principal, "GET", "/api/admin/invites"))
      .body as AdminInvitesResponse;
    expect(listed).toEqual({ invites: [answer.invite], emailAvailable: true });

    // Accepting it uses it up and the account is no longer pending.
    const token = answer.link.split("#")[1]!;
    expect(ctx.invites.consume(token)?.user.id).toBe(invited.id);
    ctx.store.linkIdentity({
      provider: "email",
      subject: "bea@example.com",
      userId: invited.id,
      email: "bea@example.com",
      emailVerified: true,
    });
    expect(
      (await users(ctx, principal)).find((user) => user.id === invited.id)
        ?.pending,
    ).toBeFalse();
    expect(
      (
        (await ctx.call(principal, "GET", "/api/admin/invites"))
          .body as AdminInvitesResponse
      ).invites,
    ).toEqual([]);

    // The address now belongs to an account.
    const again = await ctx.call(principal, "POST", "/api/admin/invites", {
      email: "bea@example.com",
      role: "member",
    });
    expect(again.status).toBe(409);
    expect(
      (
        await ctx.call(principal, "POST", "/api/admin/invites", {
          email: "nope",
          role: "member",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await ctx.call(principal, "POST", "/api/admin/invites", {
          email: "x@example.com",
          role: "owner",
        })
      ).status,
    ).toBe(400);
  });

  test("the link is returned when email is off or fails", async () => {
    const off = setup({ email: false });
    const offAnswer = await off.call(
      LOCAL_PRINCIPAL,
      "POST",
      "/api/admin/invites",
      { email: "pat@example.com", role: "member" },
    );
    expect(offAnswer.status).toBe(200);
    expect(offAnswer.body.emailed).toBeFalse();
    expect(offAnswer.body.invite.createdBy).toBeNull();
    expect(
      (await off.call(LOCAL_PRINCIPAL, "GET", "/api/admin/invites")).body
        .emailAvailable,
    ).toBeFalse();

    const ctx = setup();
    ctx.failMail(true);
    const failed = await ctx.call(
      LOCAL_PRINCIPAL,
      "POST",
      "/api/admin/invites",
      { email: "pat@example.com", role: "member" },
    );
    expect(failed.status).toBe(200);
    expect(failed.body.emailed).toBeFalse();
    expect(failed.body.link).toContain("/invite#");
  });

  test("resend rotates the token and revoke removes the pending account", async () => {
    const ctx = setup();
    const { principal } = ctx.account("ada", "admin");
    const first = (
      await ctx.call(principal, "POST", "/api/admin/invites", {
        email: "pat@example.com",
        role: "member",
      })
    ).body as AdminInviteResponse;
    ctx.advance(3 * 24 * 60 * 60 * 1000);
    const resent = await ctx.call(
      principal,
      "POST",
      "/api/admin/invites/resend",
      {
        id: first.invite.id,
      },
    );
    expect(resent.status).toBe(200);
    const second = resent.body as AdminInviteResponse;
    expect(second.invite.id).toBe(first.invite.id);
    expect(second.link).not.toBe(first.link);
    expect(second.invite.expiresAt).toBe(
      first.invite.expiresAt + 3 * 24 * 60 * 60 * 1000,
    );
    expect(ctx.mail).toHaveLength(2);
    expect(ctx.invites.peek(first.link.split("#")[1])).toBeNull();
    expect(ctx.invites.peek(second.link.split("#")[1])?.email).toBe(
      "pat@example.com",
    );

    // Inviting the same pending address again replaces the invitation.
    const replaced = (
      await ctx.call(principal, "POST", "/api/admin/invites", {
        email: "pat@example.com",
        role: "admin",
      })
    ).body as AdminInviteResponse;
    expect(replaced.invite.userId).toBe(first.invite.userId);
    expect(replaced.invite.role).toBe("admin");
    expect(ctx.invites.list().map((invite) => invite.id)).toEqual([
      replaced.invite.id,
    ]);

    const revoked = await ctx.call(
      principal,
      "POST",
      "/api/admin/invites/revoke",
      { id: replaced.invite.id },
    );
    expect(revoked.status).toBe(200);
    expect(ctx.invites.list()).toEqual([]);
    expect(ctx.store.getUser(first.invite.userId)).toBeNull();
    for (const path of [
      "/api/admin/invites/revoke",
      "/api/admin/invites/resend",
    ])
      expect(
        (await ctx.call(principal, "POST", path, { id: replaced.invite.id }))
          .status,
      ).toBe(404);
  });

  test("revoking an accepted account's invitation keeps the account", async () => {
    const ctx = setup();
    const { user } = ctx.account("max", "member");
    const { id } = ctx.invites.create({
      userId: user.id,
      email: "max@example.com",
      actor: null,
    });
    expect(
      (
        await ctx.call(LOCAL_PRINCIPAL, "POST", "/api/admin/invites/revoke", {
          id,
        })
      ).status,
    ).toBe(200);
    expect(ctx.store.getUser(user.id)).not.toBeNull();
  });

  test("expired invitations are not listed", async () => {
    const ctx = setup();
    await ctx.call(LOCAL_PRINCIPAL, "POST", "/api/admin/invites", {
      email: "pat@example.com",
      role: "member",
    });
    ctx.advance(INVITE_TTL_MS);
    expect(ctx.invites.list()).toEqual([]);
  });
});

describe("sign-in methods", () => {
  const google = (subject: string, email: string) => ({
    provider: "google" as const,
    subject,
    email,
    emailVerified: true,
    displayName: null,
    avatarUrl: null,
    label: email,
  });

  test("only instance admins reach them", async () => {
    const ctx = setup();
    const { user: max, principal: member } = ctx.account("max", "member");
    const calls = [
      ["GET", `/api/admin/users/detail?user=${max.id}`, undefined],
      ["POST", "/api/admin/users/emails", { user: max.id, emails: ["m@x.io"] }],
      ["POST", "/api/admin/users/tailscale", { user: max.id, login: "m@gh" }],
      [
        "POST",
        "/api/admin/users/methods/remove",
        { user: max.id, method: { kind: "identity", id: "email:x" } },
      ],
    ] as const;
    for (const [method, path, body] of calls) {
      expect((await ctx.call(member, method, path, body)).status).toBe(403);
      expect((await ctx.call(guest("g"), method, path, body)).status).toBe(403);
    }
    expect(ctx.store.identitiesOf(max.id)).toHaveLength(1);
    expect(
      (await ctx.call(LOCAL_PRINCIPAL, "GET", calls[0][1])).body.methods,
    ).toHaveLength(1);
  });

  test("the detail lists every method with the id that removes it", async () => {
    const ctx = setup();
    const { principal } = ctx.account("ada", "admin");
    const created = (
      await ctx.call(principal, "POST", "/api/admin/invites", {
        email: "pat@example.com",
        role: "member",
      })
    ).body as AdminInviteResponse;
    const pat = created.invite.userId;
    ctx.store.linkIdentity({
      provider: "github",
      subject: "42",
      userId: pat,
      displayName: "@pat",
      email: "pat@users.example",
      emailVerified: true,
    });
    ctx.store.linkTailscale(pat, "pat@github", null);
    ctx.store.addPasskey({
      credentialId: "cred-9",
      userId: pat,
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: [],
      rpId: "thyra.example",
      name: null,
    });
    const { status, body } = await ctx.call(
      principal,
      "GET",
      `/api/admin/users/detail?user=${pat}`,
    );
    expect(status).toBe(200);
    const detail = body as AdminUserDetail;
    expect(detail).toMatchObject({ id: pat, pending: false, invited: true });
    expect(
      detail.methods.map(({ kind, id, provider, label, verified }) => ({
        kind,
        id,
        provider,
        label,
        verified,
      })),
    ).toEqual([
      {
        kind: "identity",
        id: "email:pat@example.com",
        provider: "email",
        label: "pat@example.com",
        verified: false,
      },
      {
        kind: "identity",
        id: "github:42",
        provider: "github",
        label: "@pat",
        verified: true,
      },
      {
        kind: "identity",
        id: "tailscale:pat@github",
        provider: "tailscale",
        label: "pat@github",
        verified: true,
      },
      {
        kind: "passkey",
        id: "cred-9",
        provider: "passkey",
        label: "Passkey",
        verified: true,
      },
    ]);
    expect(
      (await ctx.call(principal, "GET", "/api/admin/users/detail?user=u_x"))
        .status,
    ).toBe(404);
  });

  test("binds several verified addresses at once, or none", async () => {
    const ctx = setup();
    const { principal } = ctx.account("ada", "admin");
    ctx.account("max", "member");
    // Made on the host without a way to sign in, never invited.
    const sam = ctx.store.createUser({ name: "sam", role: "member" });
    const listed = (await users(ctx, principal)).find(
      (user) => user.id === sam.id,
    );
    expect(listed).toMatchObject({ pending: true, invited: false });
    const bind = (emails: unknown) =>
      ctx.call(principal, "POST", "/api/admin/users/emails", {
        user: sam.id,
        emails,
      });

    const taken = await bind(["sam@work.example", "MAX@example.com"]);
    expect(taken.status).toBe(409);
    expect(taken.body.error).toContain("max@example.com");
    const invalid = await bind(["sam@work.example", "not an address"]);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain('"not an address"');
    expect((await bind([])).status).toBe(400);
    expect((await bind("sam@work.example")).status).toBe(400);
    expect(ctx.store.identitiesOf(sam.id)).toEqual([]);

    const bound = await bind([
      " Sam@Work.example ",
      "sam@home.example",
      "sam@work.example",
    ]);
    expect(bound.status).toBe(200);
    const detail = bound.body as AdminUserDetail;
    expect(detail.pending).toBeFalse();
    expect(detail.emails).toEqual(["sam@home.example", "sam@work.example"]);
    expect(
      detail.methods.map((method) => [method.id, method.verified]),
    ).toEqual([
      ["email:sam@home.example", true],
      ["email:sam@work.example", true],
    ]);
    // Already bound: nothing changes and nothing is audited twice.
    const audits = ctx.store.listAudit(50).length;
    expect((await bind(["sam@home.example"])).status).toBe(200);
    expect(ctx.store.listAudit(50)).toHaveLength(audits);
    expect(ctx.store.listAudit(1)[0]).toMatchObject({
      actor: principal.key.slice(5),
      action: "identity.link",
      target: sam.id,
    });

    // A Google account reporting the address as verified signs in here.
    const outcome = resolveIdentity(
      ctx.store,
      google("g-sam", "sam@home.example"),
      {},
    );
    expect(outcome).toMatchObject({ kind: "user", linked: true });
    expect(outcome.kind === "user" && outcome.user.id).toBe(sam.id);
    // So does an email code to it.
    expect(ctx.store.findIdentity("email", "sam@work.example")?.id).toBe(
      sam.id,
    );

    // An address another account has through its provider is taken too.
    resolveIdentity(ctx.store, google("g-sam2", "sam@corp.example"), {
      linkUserId: sam.id,
    });
    const other = await ctx.call(principal, "POST", "/api/admin/users/emails", {
      user: principal.key.slice(5),
      emails: ["sam@corp.example"],
    });
    expect(other.status).toBe(409);
    expect(other.body.error).toContain("sam@corp.example");
  });

  test("an invitation's address becomes verified when an admin binds it", async () => {
    const ctx = setup();
    const created = (
      await ctx.call(LOCAL_PRINCIPAL, "POST", "/api/admin/invites", {
        email: "pat@example.com",
        role: "member",
      })
    ).body as AdminInviteResponse;
    const bound = await ctx.call(
      LOCAL_PRINCIPAL,
      "POST",
      "/api/admin/users/emails",
      { user: created.invite.userId, emails: ["pat@example.com"] },
    );
    expect(bound.status).toBe(200);
    expect(bound.body).toMatchObject({ pending: false, invited: true });
  });

  test("binds a Tailscale login unless another account has it", async () => {
    const ctx = setup();
    const { user: max } = ctx.account("max", "member");
    const { user: bea } = ctx.account("bea", "member");
    const bind = (user: string, login: unknown) =>
      ctx.call(LOCAL_PRINCIPAL, "POST", "/api/admin/users/tailscale", {
        user,
        login,
      });
    const bound = await bind(max.id, " max@github ");
    expect(bound.status).toBe(200);
    expect(
      (bound.body as AdminUserDetail).methods.some(
        (method) => method.id === "tailscale:max@github",
      ),
    ).toBeTrue();
    expect((await bind(max.id, "max@github")).status).toBe(200);
    const taken = await bind(bea.id, "max@github");
    expect(taken.status).toBe(409);
    expect(taken.body.error).toContain("max@github");
    for (const login of ["", "two words", 7])
      expect((await bind(bea.id, login)).status).toBe(400);
    expect(ctx.store.findIdentity("tailscale", "max@github")?.id).toBe(max.id);
  });

  test("removes methods, the last only when confirmed", async () => {
    const ctx = setup();
    const { user: ada, principal } = ctx.account("ada", "admin");
    const { user: max } = ctx.account("max", "member");
    ctx.store.addPasskey({
      credentialId: "cred-max",
      userId: max.id,
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: [],
      rpId: "thyra.example",
      name: "Phone",
    });
    const remove = (
      who: Principal,
      user: string,
      method: { kind: string; id: string },
      allowLast?: boolean,
    ) =>
      ctx.call(who, "POST", "/api/admin/users/methods/remove", {
        user,
        method,
        ...(allowLast === undefined ? {} : { allowLast }),
      });
    const email = { kind: "identity", id: "email:max@example.com" };
    const passkey = { kind: "passkey", id: "cred-max" };

    expect((await remove(principal, max.id, passkey)).status).toBe(200);
    expect(ctx.store.passkeysOf(max.id)).toEqual([]);
    expect(
      (await remove(principal, max.id, { kind: "passkey", id: "cred-max" }))
        .status,
    ).toBe(404);
    expect(
      (await remove(principal, max.id, { kind: "identity", id: "cred-max" }))
        .status,
    ).toBe(404);
    const last = await remove(principal, max.id, email);
    expect(last.status).toBe(409);
    expect(last.body.error).toContain("last way to sign in");
    expect((await remove(principal, max.id, email, false)).status).toBe(409);
    const confirmed = await remove(principal, max.id, email, true);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      pending: true,
      invited: false,
      methods: [],
    });
    // Like removing your own method, signed-in sessions stay.
    expect(ctx.store.listSessions(max.id)).toHaveLength(1);
    expect(ctx.store.listAudit(1)[0]).toMatchObject({
      actor: ada.id,
      action: "identity.unlink",
      target: max.id,
    });

    // An admin never removes their own last method, even when confirming.
    const self = await remove(
      principal,
      ada.id,
      { kind: "identity", id: "email:ada@example.com" },
      true,
    );
    expect(self.status).toBe(409);
    expect(self.body.error).toContain("your last way");
    // Nor may anyone take the last admin's.
    const lastAdmin = await remove(
      LOCAL_PRINCIPAL,
      ada.id,
      { kind: "identity", id: "email:ada@example.com" },
      true,
    );
    expect(lastAdmin.status).toBe(409);
    expect(lastAdmin.body.error).toContain("last admin");
    // A method that is not the last goes without confirmation.
    ctx.store.linkTailscale(ada.id, "ada@github", null);
    expect(
      (
        await remove(principal, ada.id, {
          kind: "identity",
          id: "email:ada@example.com",
        })
      ).status,
    ).toBe(200);
    expect(ctx.store.signInMethodCount(ada.id)).toBe(1);
  });

  test("an invitation's unverified address is removed without confirmation", async () => {
    const ctx = setup();
    const created = (
      await ctx.call(LOCAL_PRINCIPAL, "POST", "/api/admin/invites", {
        email: "pat@example.com",
        role: "member",
      })
    ).body as AdminInviteResponse;
    const removed = await ctx.call(
      LOCAL_PRINCIPAL,
      "POST",
      "/api/admin/users/methods/remove",
      {
        user: created.invite.userId,
        method: { kind: "identity", id: "email:pat@example.com" },
      },
    );
    expect(removed.status).toBe(200);
    expect(removed.body.methods).toEqual([]);
  });
});

describe("sign-up settings", () => {
  test("default to invite-only and persist normalised domains", async () => {
    const ctx = setup();
    expect(
      (await ctx.call(LOCAL_PRINCIPAL, "GET", "/api/admin/signup")).body,
    ).toEqual({ policy: "invite", domains: [] });
    const saved = await ctx.call(LOCAL_PRINCIPAL, "POST", "/api/admin/signup", {
      policy: "open",
      domains: [" Example.com", "@corp.example", "example.com", ""],
    });
    expect(saved).toEqual({
      status: 200,
      body: { policy: "open", domains: ["example.com", "corp.example"] },
    });
    // Another store on the same database (a restart) reads the same.
    expect(signupSettings(createAccountStore(ctx.store.db))).toEqual(
      saved.body,
    );
    expect(ctx.store.listAudit(1)[0]).toMatchObject({
      actor: "local",
      action: "setting.set",
      target: "signup",
    });
  });

  test("refuse invalid values, naming the bad entry", async () => {
    const ctx = setup();
    for (const [body, message] of [
      [{ policy: "closed", domains: [] }, "policy must be invite or open"],
      [{ policy: "open" }, "domains must be a list"],
      [{ policy: "open", domains: "example.com" }, "domains must be a list"],
      [
        { policy: "invite", domains: ["example.com", "not a domain"] },
        '"not a domain" is not a domain name',
      ],
    ] as const) {
      const refused = await ctx.call(
        LOCAL_PRINCIPAL,
        "POST",
        "/api/admin/signup",
        body,
      );
      expect(refused.status).toBe(400);
      expect(refused.body.error).toContain(message);
    }
    expect(signupSettings(ctx.store)).toEqual({
      policy: "invite",
      domains: [],
    });
  });

  test("sign-in follows the stored settings without a restart", async () => {
    const ctx = setup();
    const identity = (subject: string, email: string) => ({
      provider: "google" as const,
      subject,
      email,
      emailVerified: true,
      displayName: null,
      avatarUrl: null,
      label: email,
    });
    const outcome = (subject: string, email: string): User | null => {
      const result = resolveIdentity(ctx.store, identity(subject, email), {});
      return result.kind === "user" ? result.user : null;
    };
    expect(outcome("g1", "pat@corp.example")).toBeNull();
    await ctx.call(LOCAL_PRINCIPAL, "POST", "/api/admin/signup", {
      policy: "invite",
      domains: ["corp.example"],
    });
    expect(outcome("g1", "pat@corp.example")?.role).toBe("member");
    expect(outcome("g2", "sam@else.example")).toBeNull();
    await ctx.call(LOCAL_PRINCIPAL, "POST", "/api/admin/signup", {
      policy: "open",
      domains: [],
    });
    expect(outcome("g2", "sam@else.example")?.role).toBe("member");
  });
});
