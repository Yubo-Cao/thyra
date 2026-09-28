import { randomBytes, timingSafeEqual } from "node:crypto";
import { type AccountStore, cleanText, hashSecret, randomToken } from "./store";

/**
 * Anonymous read-only share links and the guest sessions they create.
 *
 * A link names one workspace of one connection, optionally narrowed to one
 * pane, and always grants the viewer role. Its URL is
 * `<base>/s/<id>#<secret>`: the 256-bit secret travels in the fragment
 * (never sent to servers, logs or Referer) and only its SHA-256 is stored.
 * Redeeming the secret creates a guest session (no account) whose cookie
 * holds another random 256-bit value, also stored only as a digest. Guest
 * sessions end when the link expires or is revoked.
 */

export type ShareLink = {
  id: string;
  connectionId: string;
  workspaceId: string;
  /** Narrows the link to one pane (and the tab holding it). */
  paneId: string | null;
  role: "viewer";
  label: string | null;
  /** Account id of the creator, `local` or `cli`. */
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
  maxUses: number | null;
  uses: number;
  revokedAt: number | null;
};

export type GuestSession = {
  idHash: string;
  publicId: string;
  linkId: string;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
};

export type ShareLinkState = "active" | "expired" | "revoked" | "used";

export type RedeemFailure = "invalid" | "expired" | "revoked" | "used";

export const SHARE_LINK_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const SHARE_LINK_MIN_TTL_MS = 5 * 60 * 1000;
export const SHARE_LINK_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SHARE_LINK_MAX_USES = 10_000;
export const SHARE_LINK_MAX_LABEL = 40;
/** Ended links stay listed (and auditable) this long, then are pruned. */
const ENDED_LINK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const GUEST_TOUCH_INTERVAL_MS = 60_000;
const MAX_USER_AGENT = 200;
const LINK_ID_PATTERN = /^[A-Za-z0-9_-]{8,32}$/;
const DUMMY_HASH = Buffer.alloc(32);

/** `30m`, `1h`, `24h`, `7d` (or plain milliseconds) to milliseconds. */
export function parseShareDuration(text: string): number | null {
  const match = /^(\d{1,6})\s*(m|min|h|d)?$/i.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  const ms =
    unit === "d"
      ? value * 86_400_000
      : unit === "h"
        ? value * 3_600_000
        : unit === "m" || unit === "min"
          ? value * 60_000
          : value;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

export function isShareLinkId(value: unknown): value is string {
  return typeof value === "string" && LINK_ID_PATTERN.test(value);
}

/** The URL path and fragment of a link: `/s/<id>#<secret>`. */
export function shareLinkPath(id: string, secret: string): string {
  return `/s/${id}#${secret}`;
}

type LinkRow = {
  id: string;
  secret_hash: string;
  connection_id: string;
  workspace_id: string;
  pane_id: string | null;
  role: "viewer";
  label: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  max_uses: number | null;
  uses: number;
  revoked_at: number | null;
};

type GuestRow = {
  id_hash: string;
  public_id: string;
  link_id: string;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
};

function toLink(row: LinkRow): ShareLink {
  return {
    id: row.id,
    connectionId: row.connection_id,
    workspaceId: row.workspace_id,
    paneId: row.pane_id,
    role: "viewer",
    label: row.label,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    uses: row.uses,
    revokedAt: row.revoked_at,
  };
}

function toGuest(row: GuestRow): GuestSession {
  return {
    idHash: row.id_hash,
    publicId: row.public_id,
    linkId: row.link_id,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

/** Constant-time comparison of two hex SHA-256 digests. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== 32 || right.length !== 32) {
    timingSafeEqual(DUMMY_HASH, DUMMY_HASH);
    return false;
  }
  return timingSafeEqual(left, right);
}

export type ShareLinkStore = ReturnType<typeof createShareLinkStore>;

export function createShareLinkStore(store: AccountStore) {
  const { db } = store;
  const now = store.now;

  const q = {
    link: db.query<LinkRow, { id: string }>(
      "SELECT * FROM share_links WHERE id = $id",
    ),
    guest: db.query<GuestRow, { hash: string }>(
      "SELECT * FROM guest_sessions WHERE id_hash = $hash",
    ),
  };

  function stateOf(link: ShareLink, at = now()): ShareLinkState {
    if (link.revokedAt !== null) return "revoked";
    if (link.expiresAt <= at) return "expired";
    if (link.maxUses !== null && link.uses >= link.maxUses) return "used";
    return "active";
  }

  function getLink(id: string): ShareLink | null {
    const row = q.link.get({ id });
    return row ? toLink(row) : null;
  }

  /**
   * The link whose secret this is, compared in constant time; unknown ids
   * cost the same as wrong secrets.
   */
  function matchSecret(id: unknown, secret: unknown): LinkRow | null {
    const valid =
      isShareLinkId(id) &&
      typeof secret === "string" &&
      secret.length > 0 &&
      secret.length <= 128;
    const row = valid ? q.link.get({ id }) : null;
    const presented = hashSecret(
      typeof secret === "string" ? secret.slice(0, 128) : "",
    );
    const matches = sameDigest(
      presented,
      row?.secret_hash ?? DUMMY_HASH.toString("hex"),
    );
    return row && matches ? row : null;
  }

  function deleteGuestsOf(linkId: string): number {
    return db
      .query("DELETE FROM guest_sessions WHERE link_id = $id")
      .run({ id: linkId }).changes;
  }

  return {
    stateOf,
    getLink,
    /** Whether a secret opens a link, without redeeming it. */
    verifySecret(id: string, secret: string): boolean {
      return matchSecret(id, secret) !== null;
    },

    /**
     * Create a link; returns the secret once. The caller authorizes the
     * actor (workspace owner or instance admin).
     */
    createLink(args: {
      connectionId: string;
      workspaceId: string;
      paneId?: string | null;
      label?: string | null;
      ttlMs?: number;
      maxUses?: number | null;
      actor: string | null;
    }): { link: ShareLink; secret: string } {
      const ttl = args.ttlMs ?? SHARE_LINK_DEFAULT_TTL_MS;
      if (
        !Number.isSafeInteger(ttl) ||
        ttl < SHARE_LINK_MIN_TTL_MS ||
        ttl > SHARE_LINK_MAX_TTL_MS
      )
        throw new Error("links expire after 5 minutes to 30 days");
      const maxUses = args.maxUses ?? null;
      if (
        maxUses !== null &&
        (!Number.isSafeInteger(maxUses) ||
          maxUses < 1 ||
          maxUses > SHARE_LINK_MAX_USES)
      )
        throw new Error(`max uses must be 1 to ${SHARE_LINK_MAX_USES}`);
      if (!args.connectionId || !args.workspaceId)
        throw new Error("a link needs a connection and a workspace");
      const secret = randomToken(32);
      const at = now();
      const row: LinkRow = {
        id: randomToken(9),
        secret_hash: hashSecret(secret),
        connection_id: args.connectionId,
        workspace_id: args.workspaceId,
        pane_id: args.paneId || null,
        role: "viewer",
        label: cleanText(args.label, SHARE_LINK_MAX_LABEL) || null,
        created_by: args.actor,
        created_at: at,
        expires_at: at + ttl,
        max_uses: maxUses,
        uses: 0,
        revoked_at: null,
      };
      db.query(
        `INSERT INTO share_links (id, secret_hash, connection_id, workspace_id, pane_id, role, label, created_by, created_at, expires_at, max_uses, uses, revoked_at)
         VALUES ($id, $secret_hash, $connection_id, $workspace_id, $pane_id, $role, $label, $created_by, $created_at, $expires_at, $max_uses, $uses, $revoked_at)`,
      ).run(row);
      store.audit(args.actor, "share.create", row.id, {
        connection: row.connection_id,
        workspace: row.workspace_id,
        pane: row.pane_id,
        role: row.role,
        label: row.label,
        expires_at: row.expires_at,
        max_uses: row.max_uses,
      });
      store.markChanged();
      return { link: toLink(row), secret };
    },

    /** Links of one workspace (or all), newest first, with live guest counts. */
    listLinks(
      filter: { connectionId?: string; workspaceId?: string } = {},
    ): (ShareLink & { guests: number })[] {
      const rows = db
        .query<
          LinkRow & { guests: number },
          { connection: string | null; workspace: string | null; now: number }
        >(
          `SELECT l.*, (SELECT COUNT(*) FROM guest_sessions g
                         WHERE g.link_id = l.id AND g.expires_at > $now) AS guests
             FROM share_links l
            WHERE ($connection IS NULL OR l.connection_id = $connection)
              AND ($workspace IS NULL OR l.workspace_id = $workspace)
            ORDER BY l.created_at DESC, l.id`,
        )
        .all({
          connection: filter.connectionId ?? null,
          workspace: filter.workspaceId ?? null,
          now: now(),
        });
      return rows.map((row) => ({ ...toLink(row), guests: row.guests }));
    },

    /**
     * Revoke a link and end its guest sessions. Limited to one workspace
     * when `scope` is given. Returns the link and the ended sessions' digests.
     */
    revokeLink(
      id: string,
      options: {
        actor: string | null;
        scope?: { connectionId: string; workspaceId: string };
      },
    ): { link: ShareLink; ended: string[] } | null {
      const link = getLink(id);
      if (
        !link ||
        (options.scope &&
          (link.connectionId !== options.scope.connectionId ||
            link.workspaceId !== options.scope.workspaceId))
      )
        return null;
      const ended = db
        .query<{ id_hash: string }, { id: string }>(
          "SELECT id_hash FROM guest_sessions WHERE link_id = $id",
        )
        .all({ id })
        .map((row) => row.id_hash);
      db.transaction(() => {
        if (link.revokedAt === null)
          db.query(
            "UPDATE share_links SET revoked_at = $at WHERE id = $id",
          ).run({ id, at: now() });
        deleteGuestsOf(id);
      })();
      store.audit(options.actor, "share.revoke", id, {
        workspace: link.workspaceId,
        sessions: ended.length,
      });
      store.markChanged();
      return { link: getLink(id)!, ended };
    },

    /** Revoke every link of a closed workspace (Herdr may reuse its id). */
    revokeWorkspaceLinks(connectionId: string, workspaceId: string): number {
      const ids = db
        .query<{ id: string }, { connection: string; workspace: string }>(
          "SELECT id FROM share_links WHERE connection_id = $connection AND workspace_id = $workspace AND revoked_at IS NULL",
        )
        .all({ connection: connectionId, workspace: workspaceId })
        .map((row) => row.id);
      if (ids.length === 0) return 0;
      db.transaction(() => {
        for (const id of ids) {
          db.query(
            "UPDATE share_links SET revoked_at = $at WHERE id = $id",
          ).run({ id, at: now() });
          deleteGuestsOf(id);
        }
      })();
      store.audit(null, "share.workspace_closed", null, {
        connection: connectionId,
        workspace: workspaceId,
        links: ids.length,
      });
      store.markChanged();
      return ids.length;
    },

    /**
     * Redeem a link's secret for a new guest session. Unknown ids and wrong
     * secrets are indistinguishable (`invalid`) and cost the same time.
     */
    redeem(args: { id: string; secret: string; userAgent?: string | null }):
      | {
          ok: true;
          token: string;
          session: GuestSession;
          link: ShareLink;
        }
      | { ok: false; reason: RedeemFailure } {
      const row = matchSecret(args.id, args.secret);
      if (!row) return { ok: false, reason: "invalid" };
      const link = toLink(row);
      const state = stateOf(link);
      if (state !== "active") return { ok: false, reason: state };
      const token = randomToken(32);
      const at = now();
      const guest: GuestRow = {
        id_hash: hashSecret(token),
        public_id: `g${randomBytes(6).toString("base64url")}`,
        link_id: link.id,
        user_agent: cleanText(args.userAgent, MAX_USER_AGENT) || null,
        created_at: at,
        last_seen_at: at,
        expires_at: link.expiresAt,
      };
      const counted = db.transaction(() => {
        // Counted atomically: concurrent redemptions never exceed max uses.
        const used = db
          .query(
            `UPDATE share_links SET uses = uses + 1
              WHERE id = $id AND revoked_at IS NULL AND expires_at > $now
                AND (max_uses IS NULL OR uses < max_uses)`,
          )
          .run({ id: link.id, now: at });
        if (used.changes !== 1) return false;
        db.query(
          `INSERT INTO guest_sessions (id_hash, public_id, link_id, user_agent, created_at, last_seen_at, expires_at)
           VALUES ($id_hash, $public_id, $link_id, $user_agent, $created_at, $last_seen_at, $expires_at)`,
        ).run(guest);
        return true;
      })();
      if (!counted) return { ok: false, reason: "used" };
      store.audit(`guest:${guest.public_id}`, "share.redeem", link.id, {
        session: guest.public_id,
      });
      store.markChanged();
      return {
        ok: true,
        token,
        session: toGuest(guest),
        link: { ...link, uses: link.uses + 1 },
      };
    },

    /** The live guest session and its active link for a cookie value. */
    resolveGuest(
      token: string,
    ): { session: GuestSession; link: ShareLink } | null {
      if (!token || token.length > 128) return null;
      const row = q.guest.get({ hash: hashSecret(token) });
      const at = now();
      if (!row || row.expires_at <= at) return null;
      const link = getLink(row.link_id);
      if (!link || link.revokedAt !== null || link.expiresAt <= at) return null;
      if (at - row.last_seen_at > GUEST_TOUCH_INTERVAL_MS)
        db.query(
          "UPDATE guest_sessions SET last_seen_at = $at WHERE id_hash = $hash",
        ).run({ at, hash: row.id_hash });
      return { session: toGuest(row), link };
    },

    /** A live guest session by digest (for live-socket checks). */
    guestByHash(idHash: string): GuestSession | null {
      const row = q.guest.get({ hash: idHash });
      return row && row.expires_at > now() ? toGuest(row) : null;
    },

    /** End one guest session (the guest left). */
    endGuest(idHash: string): boolean {
      const row = q.guest.get({ hash: idHash });
      if (!row) return false;
      db.query("DELETE FROM guest_sessions WHERE id_hash = $hash").run({
        hash: idHash,
      });
      store.audit(`guest:${row.public_id}`, "share.leave", row.link_id, {
        session: row.public_id,
      });
      store.markChanged();
      return true;
    },

    pruneExpired() {
      const at = now();
      db.query("DELETE FROM guest_sessions WHERE expires_at <= $now").run({
        now: at,
      });
      db.query(
        "DELETE FROM share_links WHERE COALESCE(MIN(revoked_at, expires_at), expires_at) <= $before",
      ).run({ before: at - ENDED_LINK_RETENTION_MS });
    },
  };
}
