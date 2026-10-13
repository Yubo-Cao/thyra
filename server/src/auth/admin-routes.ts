import type {
  AdminIdentity,
  AdminInviteResponse,
  AdminInvitesResponse,
  AdminSignupSettings,
  AdminUser,
  AdminUsersResponse,
  InstanceRole,
} from "../../../shared/admin";
import type { AccountStore, User } from "../accounts/store";
import type { HttpRouteId } from "../authz/http-policy";
import type { RequestAccess } from "../http/request-access";
import { type Logger, silentLogger } from "../utils/logger";
import { RequestError, readJsonObject } from "../utils/request";
import { inviteEmail, type Mailer, normalizeEmail } from "./email";
import type { Principal } from "./principal";
import {
  INVITE_TTL_MS,
  type InviteStore,
  saveSignupSettings,
  signupSettings,
} from "./sign-in";

/**
 * The instance admin panel's routes (`/api/admin/*`, wire types in
 * `shared/admin.ts`): accounts, invitations to the instance, and who may
 * sign up. `HTTP_POLICY` admits only instance admins (local use counts).
 *
 * An admin cannot demote, disable or remove their own account, and no
 * change may leave the instance without an enabled admin who can sign in:
 * local use stays an admin, but only on the host. `thyra user` on the host
 * is the way out of either.
 */

const MAX_BODY_BYTES = 8 * 1024;
const NO_STORE = { "cache-control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export type AdminRoutes = ReturnType<typeof createAdminRoutes>;

export function createAdminRoutes(args: {
  store: AccountStore;
  invites: InviteStore;
  mailer: Mailer | null;
  /** Where invitation links point (the public listener when there is one). */
  inviteOrigin: (access: RequestAccess) => string | null;
  /** Account data changed: refresh access and close ended sockets. */
  onChange: () => void;
  logger?: Logger;
}) {
  const { store, invites } = args;
  const logger = args.logger ?? silentLogger;

  const actorOf = (principal: Principal) =>
    principal.kind === "user" ? principal.user.id : principal.key;
  const isSelf = (principal: Principal, user: User) =>
    principal.kind === "user" && principal.user.id === user.id;
  /** Invited and never signed in: no way to sign in yet. */
  const pending = (userId: string) => store.signInMethodCount(userId) === 0;

  function adminUser(user: User, principal: Principal): AdminUser {
    const identities = store.identitiesOf(user.id);
    const sessions = store.listSessions(user.id);
    const methods: AdminIdentity[] = [
      ...identities
        // An unverified address (an invitation's) is not a way in yet.
        .filter((entry) => entry.provider !== "email" || entry.emailVerified)
        .map((entry) => ({
          provider: entry.provider,
          label:
            entry.provider === "email"
              ? entry.subject
              : (entry.displayName ?? entry.email ?? entry.subject),
        })),
      ...store.passkeysOf(user.id).map((passkey) => ({
        provider: "passkey",
        label: passkey.name ?? "Passkey",
      })),
    ];
    return {
      id: user.id,
      name: user.name,
      displayName: user.displayName,
      emails: [
        ...new Set(
          identities.flatMap((entry) =>
            entry.email ? [entry.email.toLowerCase()] : [],
          ),
        ),
      ],
      role: user.role,
      disabled: user.disabled,
      pending: methods.length === 0,
      identities: methods,
      sessions: sessions.length,
      lastSeenAt: sessions.length
        ? Math.max(...sessions.map((session) => session.lastSeenAt))
        : null,
      createdAt: user.createdAt,
      self: isSelf(principal, user),
    };
  }

  function target(body: Record<string, unknown>): User {
    const user =
      typeof body.user === "string" ? store.getUser(body.user) : null;
    if (!user) throw new RequestError("no such user", 404);
    return user;
  }

  /** Refuse a change that takes away the last admin who can sign in. */
  function keepAdmin(user: User) {
    if (
      user.role === "admin" &&
      !user.disabled &&
      !pending(user.id) &&
      store.activeAdminCount() <= 1
    )
      throw new RequestError(
        "this is the last admin who can sign in; make someone else an admin first",
        409,
      );
  }

  function refuseSelf(principal: Principal, user: User, what: string) {
    if (isSelf(principal, user))
      throw new RequestError(`you cannot ${what} your own account`, 409);
  }

  async function sendInvite(
    principal: Principal,
    email: string,
    link: string,
  ): Promise<boolean> {
    if (!args.mailer) return false;
    try {
      await args.mailer.send({
        to: email,
        ...inviteEmail({
          inviter:
            principal.kind === "user"
              ? principal.user.displayName
              : "The owner",
          link,
          days: INVITE_TTL_MS / 86_400_000,
        }),
      });
      return true;
    } catch (error) {
      logger.error("invitation email failed", {
        error: (error as Error).message,
      });
      return false;
    }
  }

  function origin(access: RequestAccess): string {
    const value = args.inviteOrigin(access);
    if (!value) throw new RequestError("no address to invite to", 400);
    return value;
  }

  async function createInvite(
    principal: Principal,
    access: RequestAccess,
    body: Record<string, unknown>,
  ): Promise<AdminInviteResponse> {
    const email = normalizeEmail(body.email);
    if (!email) throw new RequestError("enter a valid email address");
    const role = body.role;
    if (role !== "admin" && role !== "member")
      throw new RequestError("role must be admin or member");
    const base = origin(access);
    const actor = actorOf(principal);
    if (store.usersWithVerifiedEmail(email).length > 0)
      throw new RequestError("an account already uses this address", 409);
    // An account invited before (to a workspace, or here) is invited afresh.
    const known = store.findIdentity("email", email);
    if (known && !pending(known.id))
      throw new RequestError("an account already uses this address", 409);
    const { id, token } = store.db.transaction(() => {
      let user = known;
      if (user) {
        store.setRole(user.id, role, actor);
        invites.removeForUser(user.id);
      } else {
        user = store.createUser({
          name: store.uniqueName(email),
          displayName: email.split("@")[0] || email,
          role,
          actor,
        });
        store.linkIdentity({
          provider: "email",
          subject: email,
          userId: user.id,
          email,
          displayName: email,
          actor,
        });
      }
      return invites.create({ userId: user.id, email, actor });
    })();
    const link = `${base}/invite#${token}`;
    const emailed = await sendInvite(principal, email, link);
    args.onChange();
    return { invite: invites.get(id)!, link, emailed };
  }

  async function resendInvite(
    principal: Principal,
    access: RequestAccess,
    body: Record<string, unknown>,
  ): Promise<AdminInviteResponse> {
    const base = origin(access);
    const rotated =
      typeof body.id === "string"
        ? invites.rotate(body.id, actorOf(principal))
        : null;
    if (!rotated) throw new RequestError("no such invitation", 404);
    const link = `${base}/invite#${rotated.token}`;
    const emailed = await sendInvite(principal, rotated.invite.email, link);
    args.onChange();
    return { invite: rotated.invite, link, emailed };
  }

  function revokeInvite(principal: Principal, body: Record<string, unknown>) {
    const actor = actorOf(principal);
    const invite =
      typeof body.id === "string" ? invites.remove(body.id, actor) : null;
    if (!invite) throw new RequestError("no such invitation", 404);
    // The account existed only for the invitation.
    if (pending(invite.userId)) store.deleteUser(invite.userId, actor);
    args.onChange();
  }

  function userAction(
    route: HttpRouteId,
    principal: Principal,
    body: Record<string, unknown>,
  ) {
    const user = target(body);
    const actor = actorOf(principal);
    switch (route) {
      case "admin.users.role": {
        const role = body.role as InstanceRole;
        if (role !== "admin" && role !== "member")
          throw new RequestError("role must be admin or member");
        if (role === "member") {
          refuseSelf(principal, user, "demote");
          keepAdmin(user);
        }
        store.setRole(user.id, role, actor);
        break;
      }
      case "admin.users.disable": {
        if (typeof body.disabled !== "boolean")
          throw new RequestError("disabled must be true or false");
        if (body.disabled) {
          refuseSelf(principal, user, "disable");
          keepAdmin(user);
        }
        // Disabling ends the account's sessions.
        if (body.disabled !== user.disabled)
          store.setDisabled(user.id, body.disabled, actor);
        break;
      }
      case "admin.users.remove":
        refuseSelf(principal, user, "remove");
        keepAdmin(user);
        // Its sessions, passkeys, identities, grants and invitations go too.
        store.deleteUser(user.id, actor);
        break;
      case "admin.users.revoke-sessions":
        store.revokeUserSessions(user.id, actor);
        break;
      default:
        return null;
    }
    // Live pages of ended sessions close; others reconnect with new rights.
    args.onChange();
    return { ok: true };
  }

  async function route(
    id: HttpRouteId,
    req: Request,
    access: RequestAccess,
    principal: Principal,
  ): Promise<unknown> {
    switch (id) {
      case "admin.users":
        return {
          users: store.listUsers().map((user) => adminUser(user, principal)),
        } satisfies AdminUsersResponse;
      case "admin.invites":
        return {
          invites: invites.list(),
          emailAvailable: Boolean(args.mailer),
        } satisfies AdminInvitesResponse;
      case "admin.signup":
        return signupSettings(store) satisfies AdminSignupSettings;
      default:
        break;
    }
    const body = await readJsonObject(req, MAX_BODY_BYTES);
    switch (id) {
      case "admin.invites.create":
        return await createInvite(principal, access, body);
      case "admin.invites.resend":
        return await resendInvite(principal, access, body);
      case "admin.invites.revoke":
        revokeInvite(principal, body);
        return { ok: true };
      case "admin.signup.set": {
        const saved = saveSignupSettings(store, body, actorOf(principal));
        if (!saved.ok) throw new RequestError(saved.error);
        return saved.settings;
      }
      default:
        return userAction(id, principal, body);
    }
  }

  return {
    async handle(
      id: HttpRouteId,
      req: Request,
      access: RequestAccess,
      principal: Principal,
    ): Promise<Response | null> {
      if (!id.startsWith("admin.")) return null;
      try {
        const result = await route(id, req, access, principal);
        return result === null ? null : json(result);
      } catch (error) {
        if (error instanceof RequestError)
          return json({ error: error.message }, error.status);
        logger.warn("admin request failed", {
          route: id,
          error: (error as Error).message,
        });
        return json({ error: "request failed" }, 500);
      }
    },
  };
}
