import { randomBytes } from "node:crypto";
import type {
  AdminInvite,
  AdminSignupSettings,
  InstanceRole,
  SignupPolicy,
} from "../../../shared/admin";
import {
  type AccountStore,
  hashSecret,
  randomToken,
  type User,
} from "../accounts/store";
import type { OAuthProviderId } from "./providers";

/**
 * From a verified external identity (a mailed code, GitHub, Google,
 * Microsoft, an OpenID Connect provider) to an account. Identities are
 * matched by provider subject, never by email alone; an email match links a
 * new identity only when both sides are verified (a mailed code,
 * `email_verified`, or GitHub's primary verified address) and exactly one
 * account holds that address.
 */

export type ExternalIdentity = {
  provider: "email" | OAuthProviderId;
  subject: string;
  email: string | null;
  /** The provider confirmed `email` (see above). */
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  /** What to call it on pages: the address or `@login`. */
  label: string;
};

export type SignInOutcome =
  | { kind: "user"; user: User; linked: boolean }
  | { kind: "unknown"; label: string }
  | { kind: "error"; code: SignInError; message: string };

/** Why a verified identity still cannot sign in. */
export type SignInError =
  | "linked_elsewhere"
  | "disabled"
  | "expired"
  | "cancelled"
  | "provider";

export const PROVIDER_LABELS: Record<ExternalIdentity["provider"], string> = {
  email: "Email",
  github: "GitHub",
  google: "Google",
  microsoft: "Microsoft",
  oidc: "SSO",
};

const SIGNUP_SETTING = "signup";
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Who may sign up without an invitation, from the account database so that
 * admins change it at runtime: `invite` (default; unknown identities get no
 * account) or `open` (they become members without grants), and email domains
 * whose verified addresses become members even when sign-up is `invite`.
 */
export function signupSettings(store: AccountStore): AdminSignupSettings {
  const saved = store.getSetting(SIGNUP_SETTING) as Partial<
    Record<keyof AdminSignupSettings, unknown>
  > | null;
  return {
    policy: saved?.policy === "open" ? "open" : "invite",
    domains: Array.isArray(saved?.domains)
      ? saved.domains.filter((domain) => typeof domain === "string")
      : [],
  };
}

/**
 * Validate and store sign-up settings: domains are lower-cased, lose a
 * leading `@` and are deduplicated. Returns the stored settings, or the
 * reason they were refused.
 */
export function saveSignupSettings(
  store: AccountStore,
  input: { policy?: unknown; domains?: unknown },
  actor: string | null,
): { ok: true; settings: AdminSignupSettings } | { ok: false; error: string } {
  if (input.policy !== "invite" && input.policy !== "open")
    return { ok: false, error: "policy must be invite or open" };
  if (
    !Array.isArray(input.domains) ||
    !input.domains.every((entry) => typeof entry === "string")
  )
    return { ok: false, error: "domains must be a list of domain names" };
  const domains: string[] = [];
  for (const entry of input.domains as string[]) {
    const domain = entry.trim().toLowerCase().replace(/^@/, "");
    if (!domain) continue;
    if (!DOMAIN_PATTERN.test(domain))
      return {
        ok: false,
        error: `${JSON.stringify(entry.trim())} is not a domain name`,
      };
    domains.push(domain);
  }
  const settings = {
    policy: input.policy as SignupPolicy,
    domains: [...new Set(domains)],
  };
  store.setSetting(SIGNUP_SETTING, settings, actor);
  return { ok: true, settings };
}

/** Whether a verified address is in one of the sign-up domains. */
export function inSignupDomain(
  identity: Pick<ExternalIdentity, "email" | "emailVerified">,
  domains: readonly string[],
): boolean {
  if (!identity.emailVerified || !identity.email) return false;
  const domain = identity.email.slice(identity.email.lastIndexOf("@") + 1);
  return domains.includes(domain.toLowerCase());
}

function link(
  store: AccountStore,
  identity: ExternalIdentity,
  userId: string,
  actor: string | null,
) {
  store.linkIdentity({
    provider: identity.provider,
    subject: identity.subject,
    userId,
    email: identity.email,
    emailVerified: identity.emailVerified,
    // What the account page shows for it: the address or @login.
    displayName: identity.label,
    avatarUrl: identity.avatarUrl,
    actor,
  });
  store.touchIdentity(identity.provider, identity.subject);
}

/**
 * The account an identity signs in to, linking it where the rules allow.
 *
 * - `linkUserId`: a signed-in account adds this identity (refused when
 *   another account already has it).
 * - `inviteUserId`: an invitation's holder chose this method; it is linked
 *   to the invited account.
 *
 * Otherwise an unknown identity gets a member account as `signupSettings`
 * allow, read at each sign-in.
 */
export function resolveIdentity(
  store: AccountStore,
  identity: ExternalIdentity,
  options: {
    linkUserId?: string | null;
    inviteUserId?: string | null;
  },
): SignInOutcome {
  const existing = store.findIdentity(identity.provider, identity.subject);
  if (options.linkUserId) {
    if (existing && existing.id !== options.linkUserId)
      return {
        kind: "error",
        code: "linked_elsewhere",
        message: `This ${PROVIDER_LABELS[identity.provider]} account is already linked to another Thyra account.`,
      };
    const user = store.getUser(options.linkUserId);
    if (!user || user.disabled)
      return {
        kind: "error",
        code: "disabled",
        message: "This account is disabled.",
      };
    link(store, identity, user.id, user.id);
    return { kind: "user", user, linked: !existing };
  }
  if (existing) {
    if (existing.disabled)
      return {
        kind: "error",
        code: "disabled",
        message: "This account is disabled.",
      };
    // Refresh what the provider says now (address, verification, picture).
    link(store, identity, existing.id, existing.id);
    return { kind: "user", user: existing, linked: false };
  }
  if (options.inviteUserId) {
    const user = store.getUser(options.inviteUserId);
    if (user && !user.disabled) {
      link(store, identity, user.id, "invite");
      return { kind: "user", user, linked: true };
    }
  }
  if (identity.emailVerified && identity.email) {
    const owners = store.usersWithVerifiedEmail(identity.email);
    if (owners.length === 1) {
      const user = store.getUser(owners[0]!);
      if (user && !user.disabled) {
        link(store, identity, user.id, "verified-email");
        return { kind: "user", user, linked: true };
      }
    }
  }
  const signup = signupSettings(store);
  if (signup.policy === "open" || inSignupDomain(identity, signup.domains)) {
    const user = store.db.transaction(() => {
      const created = store.createUser({
        name: store.uniqueName(
          identity.email ?? identity.label.replace(/^@/, ""),
        ),
        displayName:
          identity.displayName ??
          (identity.email?.split("@")[0] || identity.label.replace(/^@/, "")),
        role: "member",
        actor: `signup:${identity.provider}`,
      });
      link(store, identity, created.id, `signup:${identity.provider}`);
      return created;
    })();
    return { kind: "user", user, linked: true };
  }
  store.audit(null, "signin.unknown", null, {
    provider: identity.provider,
  });
  return { kind: "unknown", label: identity.label };
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InviteStore = ReturnType<typeof createInviteStore>;

/**
 * Invitation links: the secret is mailed once and stored as SHA-256. Each
 * invitation also has a public id, by which admins list, revoke and resend
 * it.
 */
export function createInviteStore(store: AccountStore) {
  const { db } = store;
  type Row = { user_id: string; email: string; expires_at: number };
  type ListRow = {
    id: string;
    email: string;
    user_id: string;
    role: InstanceRole;
    created_by: string | null;
    created_at: number;
    expires_at: number;
  };
  const byHash = (hash: string): Row | null =>
    db
      .query<Row, { hash: string }>(
        "SELECT user_id, email, expires_at FROM invites WHERE token_hash = $hash",
      )
      .get({ hash });
  const liveRows = (id?: string): ListRow[] =>
    db
      .query<ListRow, { now: number; id: string | null }>(
        `SELECT i.id, i.email, i.user_id, u.role, i.created_by, i.created_at, i.expires_at
           FROM invites i JOIN users u ON u.id = i.user_id
          WHERE i.expires_at > $now AND ($id IS NULL OR i.id = $id)
          ORDER BY i.created_at DESC`,
      )
      .all({ now: store.now(), id: id ?? null });
  const view = (row: ListRow): AdminInvite => ({
    id: row.id,
    email: row.email,
    userId: row.user_id,
    role: row.role,
    // Accounts invite by id; "local" and "cli" have no name to show.
    createdBy: row.created_by
      ? (store.getUser(row.created_by)?.displayName ?? null)
      : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  });
  const get = (id: string): AdminInvite | null => {
    const row = liveRows(id)[0];
    return row ? view(row) : null;
  };
  const valid = (token: unknown): token is string =>
    typeof token === "string" && token.length >= 20 && token.length <= 128;
  const peekHash = (hash: string) => {
    const row = byHash(hash);
    if (!row || row.expires_at <= store.now()) return null;
    const user = store.getUser(row.user_id);
    return user && !user.disabled ? { user, email: row.email } : null;
  };
  const consumeHash = (hash: string) => {
    const live = peekHash(hash);
    if (!live) return null;
    const result = db
      .query("DELETE FROM invites WHERE token_hash = $hash")
      .run({ hash });
    if (result.changes === 0) return null;
    store.audit(live.user.id, "invite.accept", live.user.id);
    store.markChanged();
    return live;
  };
  return {
    /** Invitations by the SHA-256 of their token (OAuth flows keep that). */
    peekHash,
    consumeHash,
    create(args: { userId: string; email: string; actor: string | null }): {
      id: string;
      token: string;
    } {
      const id = `i_${randomBytes(9).toString("base64url")}`;
      const token = randomToken(32);
      const at = store.now();
      db.query(
        `INSERT INTO invites (id, token_hash, user_id, email, created_by, created_at, expires_at)
         VALUES ($id, $hash, $user, $email, $actor, $at, $expires)`,
      ).run({
        id,
        hash: hashSecret(token),
        user: args.userId,
        email: args.email,
        actor: args.actor,
        at,
        expires: at + INVITE_TTL_MS,
      });
      store.audit(args.actor, "invite.create", args.userId, { invite: id });
      store.markChanged();
      return { id, token };
    },
    /** The invited account and address for a live token. */
    peek(token: unknown): { user: User; email: string } | null {
      return valid(token) ? peekHash(hashSecret(token)) : null;
    },
    /** Use a token up; the invited account, or null. */
    consume(token: unknown): { user: User; email: string } | null {
      return valid(token) ? consumeHash(hashSecret(token)) : null;
    },
    /** Unexpired invitations, newest first. */
    list(): AdminInvite[] {
      return liveRows().map(view);
    },
    get,
    /** Delete an invitation; the deleted one, or null. */
    remove(id: string, actor: string | null): AdminInvite | null {
      const invite = get(id);
      if (!invite) return null;
      db.query("DELETE FROM invites WHERE id = $id").run({ id });
      store.audit(actor, "invite.revoke", invite.userId, { invite: id });
      store.markChanged();
      return invite;
    },
    /** Delete every invitation to an account (it is invited afresh). */
    removeForUser(userId: string) {
      db.query("DELETE FROM invites WHERE user_id = $user").run({
        user: userId,
      });
      store.markChanged();
    },
    /**
     * A new token and a full validity period for a live invitation; the old
     * link stops working.
     */
    rotate(
      id: string,
      actor: string | null,
    ): { invite: AdminInvite; token: string } | null {
      if (!get(id)) return null;
      const token = randomToken(32);
      db.query(
        "UPDATE invites SET token_hash = $hash, expires_at = $expires WHERE id = $id",
      ).run({
        id,
        hash: hashSecret(token),
        expires: store.now() + INVITE_TTL_MS,
      });
      const invite = get(id)!;
      store.audit(actor, "invite.resend", invite.userId, { invite: id });
      store.markChanged();
      return { invite, token };
    },
    pruneExpired() {
      db.query("DELETE FROM invites WHERE expires_at <= $now").run({
        now: store.now(),
      });
    },
  };
}
