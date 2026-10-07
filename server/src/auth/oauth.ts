import { randomInt } from "node:crypto";
import { sameDigest } from "../utils/digest";
import {
  CodeChallengeMethod,
  generateCodeVerifier,
  OAuth2Client,
} from "arctic";

import { type AccountStore, hashSecret, randomToken } from "../accounts/store";
import type { OAuthProviderConfig } from "./providers";
import type { ExternalIdentity } from "./sign-in";

/**
 * GitHub and Google sign-in (authorization code with PKCE and state, through
 * arctic's generic `OAuth2Client`, so tests can point the endpoints at stub
 * servers) and the flows in progress.
 *
 * A flow is a database row keyed by its state. The page that starts it
 * holds a poll secret and a 4-digit pairing number. When the provider
 * returns to the browser that started it (its flow cookie matches), that
 * browser is signed in directly. When it returns elsewhere (an iOS Home
 * Screen app opens the provider in Safari), the landing page shows the
 * pairing number and asks before finishing; the starting page, polling with
 * its secret, then receives the session.
 */

export const OAUTH_FLOW_TTL_MS = 10 * 60_000;

export type OAuthIntent = "login" | "link";
export type OAuthStatus =
  | "pending"
  | "confirm"
  | "done"
  | "collected"
  | "unknown"
  | "failed";

/** What the provider said, kept until the starting page collects it. */
export type OAuthResult = {
  userId?: string;
  label?: string;
  error?: string;
  linked?: boolean;
  /** The provider returned to the starting browser, which is signed in. */
  here?: boolean;
  /** The identity awaiting confirmation in another browser. */
  identity?: ExternalIdentity;
};

export type OAuthFlow = {
  id: string;
  provider: string;
  intent: OAuthIntent;
  userId: string | null;
  inviteHash: string | null;
  verifier: string;
  pairing: string;
  origin: string;
  userAgent: string | null;
  status: OAuthStatus;
  result: OAuthResult | null;
  createdAt: number;
  expiresAt: number;
};

type Row = {
  id: string;
  state_hash: string;
  poll_hash: string;
  provider: string;
  intent: OAuthIntent;
  user_id: string | null;
  invite_hash: string | null;
  verifier: string;
  pairing: string;
  origin: string;
  user_agent: string | null;
  status: OAuthStatus;
  confirm_hash: string | null;
  result: string | null;
  created_at: number;
  expires_at: number;
};

function toFlow(row: Row): OAuthFlow {
  let result: OAuthResult | null = null;
  try {
    result = row.result ? (JSON.parse(row.result) as OAuthResult) : null;
  } catch {}
  return {
    id: row.id,
    provider: row.provider,
    intent: row.intent,
    userId: row.user_id,
    inviteHash: row.invite_hash,
    verifier: row.verifier,
    pairing: row.pairing,
    origin: row.origin,
    userAgent: row.user_agent,
    status: row.status,
    result,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export type OAuthFlowStore = ReturnType<typeof createOAuthFlowStore>;

export function createOAuthFlowStore(store: AccountStore) {
  const { db } = store;
  const byId = (id: string) =>
    db
      .query<Row, { id: string }>("SELECT * FROM oauth_flows WHERE id = $id")
      .get({ id });
  const live = (row: Row | null): row is Row =>
    Boolean(row && row.expires_at > store.now());

  return {
    create(args: {
      provider: string;
      intent: OAuthIntent;
      userId: string | null;
      invite: string | null;
      origin: string;
      userAgent: string | null;
    }) {
      const id = randomToken(12);
      const state = randomToken(32);
      const poll = randomToken(32);
      const verifier = generateCodeVerifier();
      const pairing = String(randomInt(0, 10_000)).padStart(4, "0");
      const at = store.now();
      db.query(
        `INSERT INTO oauth_flows (id, state_hash, poll_hash, provider, intent, user_id, invite_hash, verifier, pairing, origin, user_agent, created_at, expires_at)
         VALUES ($id, $state, $poll, $provider, $intent, $user, $invite, $verifier, $pairing, $origin, $agent, $at, $expires)`,
      ).run({
        id,
        state: hashSecret(state),
        poll: hashSecret(poll),
        provider: args.provider,
        intent: args.intent,
        user: args.userId,
        invite: args.invite ? hashSecret(args.invite) : null,
        verifier,
        pairing,
        origin: args.origin,
        agent: args.userAgent?.slice(0, 200) ?? null,
        at,
        expires: at + OAUTH_FLOW_TTL_MS,
      });
      return { id, state, poll, verifier, pairing };
    },

    /**
     * The pending flow a provider returned `state` for, marked as in
     * progress so the same state never completes twice.
     */
    takeByState(state: string): OAuthFlow | null {
      if (typeof state !== "string" || state.length > 128) return null;
      const row = db
        .query<Row, { hash: string; now: number }>(
          "UPDATE oauth_flows SET status = 'failed' WHERE state_hash = $hash AND status = 'pending' AND expires_at > $now RETURNING *",
        )
        .get({ hash: hashSecret(state), now: store.now() });
      return row ? { ...toFlow(row), status: "pending" } : null;
    },

    get(id: string): OAuthFlow | null {
      const row = typeof id === "string" && id.length <= 64 ? byId(id) : null;
      return live(row) ? toFlow(row) : null;
    },

    finish(id: string, status: OAuthStatus, result: OAuthResult) {
      db.query(
        "UPDATE oauth_flows SET status = $status, result = $result WHERE id = $id",
      ).run({ id, status, result: JSON.stringify(result) });
      store.markChanged();
    },

    /** Park a result for confirmation in this browser; returns its token. */
    awaitConfirm(id: string, result: OAuthResult): string {
      const token = randomToken(24);
      db.query(
        "UPDATE oauth_flows SET status = 'confirm', result = $result, confirm_hash = $hash WHERE id = $id",
      ).run({ id, result: JSON.stringify(result), hash: hashSecret(token) });
      store.markChanged();
      return token;
    },

    /** The flow waiting for this confirmation token, taken once. */
    takeConfirm(id: string, token: string): OAuthFlow | null {
      const row = typeof id === "string" && id.length <= 64 ? byId(id) : null;
      if (!live(row) || row.status !== "confirm") return null;
      if (
        typeof token !== "string" ||
        !sameDigest(row.confirm_hash, hashSecret(token))
      )
        return null;
      db.query(
        "UPDATE oauth_flows SET status = 'failed', confirm_hash = NULL WHERE id = $id AND status = 'confirm'",
      ).run({ id: row.id });
      return toFlow(row);
    },

    /**
     * The starting page's poll: the flow when `poll` is its secret. A `done`
     * flow is collected at most once.
     */
    poll(id: string, poll: string): OAuthFlow | null {
      const row = typeof id === "string" && id.length <= 64 ? byId(id) : null;
      if (!live(row) || typeof poll !== "string") return null;
      if (!sameDigest(row.poll_hash, hashSecret(poll))) return null;
      if (row.status === "done") {
        const taken = db
          .query(
            "UPDATE oauth_flows SET status = 'collected' WHERE id = $id AND status = 'done'",
          )
          .run({ id: row.id });
        if (taken.changes === 0) return { ...toFlow(row), status: "collected" };
      }
      return toFlow(row);
    },

    inviteMatches(flow: OAuthFlow, invite: string): boolean {
      return sameDigest(flow.inviteHash, hashSecret(invite));
    },

    pruneExpired() {
      db.query("DELETE FROM oauth_flows WHERE expires_at <= $now").run({
        now: store.now(),
      });
    },
  };
}

/** The provider's authorization URL for a flow. */
export function authorizationUrl(
  provider: OAuthProviderConfig,
  redirectUri: string,
  state: string,
  verifier: string,
): string {
  const client = new OAuth2Client(
    provider.clientId,
    provider.clientSecret,
    redirectUri,
  );
  const url = client.createAuthorizationURLWithPKCE(
    provider.authorizeUrl,
    state,
    CodeChallengeMethod.S256,
    verifier,
    provider.scopes,
  );
  if (provider.id === "google")
    url.searchParams.set("prompt", "select_account");
  return url.href;
}

async function getJson(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "user-agent": "Thyra",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`profile request failed (${response.status})`);
  return response.json();
}

const text = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/**
 * Exchange the code (with the PKCE verifier) and read who signed in.
 * GitHub's address counts as verified only when it is the account's primary
 * address and GitHub marks it verified; Google's only with `email_verified`.
 */
export async function fetchIdentity(
  provider: OAuthProviderConfig,
  redirectUri: string,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExternalIdentity> {
  const client = new OAuth2Client(
    provider.clientId,
    provider.clientSecret,
    redirectUri,
  );
  const tokens = await client.validateAuthorizationCode(
    provider.tokenUrl,
    code,
    verifier,
  );
  const token = tokens.accessToken();
  if (provider.id === "github") {
    const user = (await getJson(provider.userUrl, token, fetchImpl)) as Record<
      string,
      unknown
    >;
    const id = user.id;
    if (typeof id !== "number" && typeof id !== "string")
      throw new Error("GitHub returned no user id");
    const emails = (await getJson(provider.emailsUrl!, token, fetchImpl).catch(
      () => [],
    )) as unknown;
    const primary = Array.isArray(emails)
      ? (emails as Record<string, unknown>[]).find(
          (entry) => entry.primary === true && entry.verified === true,
        )
      : undefined;
    const login = text(user.login, 80) ?? String(id);
    const email = text(primary?.email, 254)?.toLowerCase() ?? null;
    return {
      provider: "github",
      subject: String(id),
      email,
      emailVerified: Boolean(email),
      displayName: text(user.name, 80) ?? login,
      avatarUrl: text(user.avatar_url, 500),
      label: `@${login}`,
    };
  }
  const info = (await getJson(provider.userUrl, token, fetchImpl)) as Record<
    string,
    unknown
  >;
  const sub = text(info.sub, 255);
  if (!sub) throw new Error("Google returned no subject");
  const email = text(info.email, 254)?.toLowerCase() ?? null;
  return {
    provider: "google",
    subject: sub,
    email,
    emailVerified: Boolean(email) && info.email_verified === true,
    displayName: text(info.name, 80),
    avatarUrl: text(info.picture, 500),
    label: email ?? "Google",
  };
}
