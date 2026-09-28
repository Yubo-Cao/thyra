import {
  type AccountStore,
  hashSecret,
  randomToken,
  type User,
} from "../accounts/store";
import type { SignupPolicy } from "./providers";

/**
 * From a verified external identity (a mailed code, GitHub, Google) to an
 * account. Identities are matched by provider subject, never by email
 * alone; an email match links a new identity only when both sides are
 * verified (a mailed code, Google's `email_verified`, or GitHub's primary
 * verified address) and exactly one account holds that address.
 */

export type ExternalIdentity = {
  provider: "email" | "github" | "google";
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
};

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
 */
export function resolveIdentity(
  store: AccountStore,
  identity: ExternalIdentity,
  options: {
    signup: SignupPolicy;
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
  if (options.signup === "open") {
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

/** Invitation links: the secret is mailed once and stored as SHA-256. */
export function createInviteStore(store: AccountStore) {
  const { db } = store;
  type Row = { user_id: string; email: string; expires_at: number };
  const byHash = (hash: string): Row | null =>
    db
      .query<Row, { hash: string }>(
        "SELECT user_id, email, expires_at FROM invites WHERE token_hash = $hash",
      )
      .get({ hash });
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
    create(args: {
      userId: string;
      email: string;
      actor: string | null;
    }): string {
      const token = randomToken(32);
      const at = store.now();
      db.query(
        `INSERT INTO invites (token_hash, user_id, email, created_by, created_at, expires_at)
         VALUES ($hash, $user, $email, $actor, $at, $expires)`,
      ).run({
        hash: hashSecret(token),
        user: args.userId,
        email: args.email,
        actor: args.actor,
        at,
        expires: at + INVITE_TTL_MS,
      });
      store.audit(args.actor, "invite.create", args.userId);
      store.markChanged();
      return token;
    },
    /** The invited account and address for a live token. */
    peek(token: unknown): { user: User; email: string } | null {
      return valid(token) ? peekHash(hashSecret(token)) : null;
    },
    /** Use a token up; the invited account, or null. */
    consume(token: unknown): { user: User; email: string } | null {
      return valid(token) ? consumeHash(hashSecret(token)) : null;
    },
    pruneExpired() {
      db.query("DELETE FROM invites WHERE expires_at <= $now").run({
        now: store.now(),
      });
    },
  };
}
