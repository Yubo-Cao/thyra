import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

/**
 * Accounts, identities, sessions, passkeys, enrollment links, workspace
 * grants and the audit log, over the account database. Secrets (session
 * cookies, enrollment secrets) are stored only as SHA-256 digests.
 */

export type InstanceRole = "admin" | "member";
export type WorkspaceRole = "owner" | "editor" | "viewer";

export const WORKSPACE_ROLES: readonly WorkspaceRole[] = [
  "viewer",
  "editor",
  "owner",
];

export function workspaceRoleAtLeast(
  role: WorkspaceRole | null | undefined,
  minimum: WorkspaceRole,
): boolean {
  return (
    !!role && WORKSPACE_ROLES.indexOf(role) >= WORKSPACE_ROLES.indexOf(minimum)
  );
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === "owner" || value === "editor" || value === "viewer";
}

export type User = {
  id: string;
  name: string;
  displayName: string;
  role: InstanceRole;
  disabled: boolean;
  privilegeEpoch: number;
  createdAt: number;
  updatedAt: number;
};

export type SessionRecord = {
  idHash: string;
  publicId: string;
  userId: string;
  authMethod: string;
  privilegeEpoch: number;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
};

export type PasskeyRecord = {
  credentialId: string;
  userId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
  rpId: string;
  name: string | null;
  createdAt: number;
  lastUsedAt: number | null;
};

export type GrantRecord = {
  connectionId: string;
  workspaceId: string;
  userId: string;
  userName: string;
  displayName: string;
  role: WorkspaceRole;
  grantedBy: string | null;
  updatedAt: number;
};

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60_000;
const SESSION_ROTATION_GRACE_MS = 60_000;
const USER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const MAX_DISPLAY_NAME = 80;
const MAX_USER_AGENT = 200;
const MAX_AUDIT_ROWS = 10_000;

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function validUserName(name: string): boolean {
  return USER_NAME_PATTERN.test(name);
}

function cleanText(value: string | null | undefined, max: number): string {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, max);
}

/** A handle for a new account from a login or display name. */
export function suggestUserName(source: string): string {
  const local = source.split("@")[0] ?? source;
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32);
  return cleaned || "user";
}

type UserRow = {
  id: string;
  name: string;
  display_name: string;
  role: InstanceRole;
  disabled: number;
  privilege_epoch: number;
  created_at: number;
  updated_at: number;
};

function toUser(row: UserRow | null | undefined): User | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    role: row.role,
    disabled: row.disabled !== 0,
    privilegeEpoch: row.privilege_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type SessionRow = {
  id_hash: string;
  public_id: string;
  user_id: string;
  auth_method: string;
  privilege_epoch: number;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
};

function toSession(row: SessionRow): SessionRecord {
  return {
    idHash: row.id_hash,
    publicId: row.public_id,
    userId: row.user_id,
    authMethod: row.auth_method,
    privilegeEpoch: row.privilege_epoch,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

type PasskeyRow = {
  credential_id: string;
  user_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  rp_id: string;
  name: string | null;
  created_at: number;
  last_used_at: number | null;
};

function toPasskey(row: PasskeyRow): PasskeyRecord {
  let transports: string[] = [];
  try {
    const parsed = JSON.parse(row.transports ?? "[]");
    if (Array.isArray(parsed))
      transports = parsed.filter((item) => typeof item === "string");
  } catch {}
  return {
    credentialId: row.credential_id,
    userId: row.user_id,
    publicKey: new Uint8Array(row.public_key),
    counter: row.counter,
    transports,
    rpId: row.rp_id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export type AccountStore = ReturnType<typeof createAccountStore>;

export function createAccountStore(
  db: Database,
  options: { now?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  /** In-process writes; `PRAGMA data_version` covers other processes. */
  let revision = 0;
  const changed = () => {
    revision += 1;
  };

  const q = {
    userById: db.query<UserRow, { id: string }>(
      "SELECT * FROM users WHERE id = $id",
    ),
    userByName: db.query<UserRow, { name: string }>(
      "SELECT * FROM users WHERE name = $name",
    ),
    users: db.query<UserRow, []>("SELECT * FROM users ORDER BY name"),
    userCount: db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM users",
    ),
    identity: db.query<
      { user_id: string },
      { provider: string; subject: string }
    >(
      "SELECT user_id FROM identities WHERE provider = $provider AND subject = $subject",
    ),
    identitiesForUser: db.query<
      { provider: string; subject: string; display_name: string | null },
      { user: string }
    >(
      "SELECT provider, subject, display_name FROM identities WHERE user_id = $user ORDER BY provider, subject",
    ),
    sessionByHash: db.query<SessionRow, { hash: string }>(
      "SELECT * FROM sessions WHERE id_hash = $hash",
    ),
    sessionsForUser: db.query<SessionRow, { user: string; now: number }>(
      "SELECT * FROM sessions WHERE user_id = $user AND expires_at > $now AND public_id NOT LIKE '%~%' ORDER BY last_seen_at DESC",
    ),
    allSessions: db.query<SessionRow, { now: number }>(
      "SELECT * FROM sessions WHERE expires_at > $now AND public_id NOT LIKE '%~%' ORDER BY last_seen_at DESC",
    ),
    passkey: db.query<PasskeyRow, { id: string }>(
      "SELECT * FROM passkeys WHERE credential_id = $id",
    ),
    passkeysForUser: db.query<PasskeyRow, { user: string }>(
      "SELECT * FROM passkeys WHERE user_id = $user ORDER BY created_at",
    ),
    grantsForUser: db.query<
      { connection_id: string; workspace_id: string; role: WorkspaceRole },
      { user: string }
    >(
      "SELECT connection_id, workspace_id, role FROM workspace_grants WHERE user_id = $user",
    ),
    grantsForWorkspace: db.query<
      {
        connection_id: string;
        workspace_id: string;
        user_id: string;
        name: string;
        display_name: string;
        role: WorkspaceRole;
        granted_by: string | null;
        updated_at: number;
      },
      { connection: string; workspace: string }
    >(
      `SELECT g.connection_id, g.workspace_id, g.user_id, u.name, u.display_name,
              g.role, g.granted_by, g.updated_at
         FROM workspace_grants g JOIN users u ON u.id = g.user_id
        WHERE g.connection_id = $connection AND g.workspace_id = $workspace
        ORDER BY u.name`,
    ),
    dataVersion: db.query<{ data_version: number }, []>("PRAGMA data_version"),
  };

  function audit(
    actor: string | null,
    action: string,
    target?: string | null,
    detail?: Record<string, unknown> | null,
  ) {
    db.query(
      "INSERT INTO audit_log (at, actor, action, target, detail) VALUES ($at, $actor, $action, $target, $detail)",
    ).run({
      at: now(),
      actor,
      action,
      target: target ?? null,
      detail: detail ? JSON.stringify(detail) : null,
    });
    // Bounded: keep the most recent rows.
    db.query(
      "DELETE FROM audit_log WHERE id <= (SELECT MAX(id) FROM audit_log) - $keep",
    ).run({ keep: MAX_AUDIT_ROWS });
  }

  function bumpEpoch(userId: string) {
    db.query(
      "UPDATE users SET privilege_epoch = privilege_epoch + 1, updated_at = $at WHERE id = $id",
    ).run({ id: userId, at: now() });
    changed();
  }

  function getUser(id: string): User | null {
    return toUser(q.userById.get({ id }));
  }

  function findUserByName(name: string): User | null {
    return toUser(q.userByName.get({ name }));
  }

  function findIdentity(provider: string, subject: string): User | null {
    const row = q.identity.get({ provider, subject });
    return row ? getUser(row.user_id) : null;
  }

  function uniqueName(base: string): string {
    const root = suggestUserName(base);
    if (!findUserByName(root)) return root;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${root.slice(0, 28)}-${index}`;
      if (!findUserByName(candidate)) return candidate;
    }
    return `${root.slice(0, 20)}-${randomBytes(4).toString("hex")}`;
  }

  function createUser(args: {
    name: string;
    displayName?: string;
    role: InstanceRole;
    actor?: string | null;
  }): User {
    const name = args.name.trim();
    if (!validUserName(name)) {
      throw new Error(
        "user names are 1-32 letters, digits, dots, dashes or underscores",
      );
    }
    if (findUserByName(name))
      throw new Error(`user ${JSON.stringify(name)} already exists`);
    const at = now();
    const id = `u_${randomBytes(9).toString("base64url")}`;
    db.query(
      `INSERT INTO users (id, name, display_name, role, created_at, updated_at)
       VALUES ($id, $name, $display, $role, $at, $at)`,
    ).run({
      id,
      name,
      display: cleanText(args.displayName, MAX_DISPLAY_NAME) || name,
      role: args.role,
      at,
    });
    audit(args.actor ?? null, "user.create", id, { name, role: args.role });
    changed();
    return getUser(id)!;
  }

  function linkIdentity(args: {
    provider: string;
    subject: string;
    userId: string;
    displayName?: string | null;
    email?: string | null;
    actor?: string | null;
  }) {
    const at = now();
    db.query(
      `INSERT INTO identities (provider, subject, user_id, email, display_name, created_at, last_used_at)
       VALUES ($provider, $subject, $user, $email, $display, $at, NULL)
       ON CONFLICT (provider, subject) DO UPDATE SET user_id = excluded.user_id,
         email = COALESCE(excluded.email, identities.email),
         display_name = COALESCE(excluded.display_name, identities.display_name)`,
    ).run({
      provider: args.provider,
      subject: args.subject,
      user: args.userId,
      email: args.email ?? null,
      display: args.displayName ?? null,
      at,
    });
    audit(args.actor ?? null, "identity.link", args.userId, {
      provider: args.provider,
      subject: args.subject,
    });
    changed();
  }

  function createSession(args: {
    userId: string;
    authMethod: string;
    userAgent?: string | null;
    ttlMs?: number;
  }): { token: string; session: SessionRecord } {
    const user = getUser(args.userId);
    if (!user) throw new Error("unknown user");
    const token = randomToken();
    const at = now();
    const row: SessionRow = {
      id_hash: hashSecret(token),
      public_id: randomBytes(6).toString("base64url"),
      user_id: user.id,
      auth_method: args.authMethod,
      privilege_epoch: user.privilegeEpoch,
      user_agent: cleanText(args.userAgent, MAX_USER_AGENT) || null,
      created_at: at,
      last_seen_at: at,
      expires_at: at + (args.ttlMs ?? SESSION_TTL_MS),
    };
    db.query(
      `INSERT INTO sessions (id_hash, public_id, user_id, auth_method, privilege_epoch, user_agent, created_at, last_seen_at, expires_at)
       VALUES ($id_hash, $public_id, $user_id, $auth_method, $privilege_epoch, $user_agent, $created_at, $last_seen_at, $expires_at)`,
    ).run(row);
    changed();
    return { token, session: toSession(row) };
  }

  /** The live session and enabled user for a cookie value, or null. */
  function resolveSession(
    token: string,
  ): { session: SessionRecord; user: User } | null {
    if (!token || token.length > 128) return null;
    const row = q.sessionByHash.get({ hash: hashSecret(token) });
    if (!row || row.expires_at <= now()) return null;
    const user = getUser(row.user_id);
    if (!user || user.disabled) return null;
    const session = toSession(row);
    if (now() - session.lastSeenAt > SESSION_TOUCH_INTERVAL_MS) {
      db.query(
        "UPDATE sessions SET last_seen_at = $at WHERE id_hash = $hash",
      ).run({ at: now(), hash: row.id_hash });
    }
    return { session, user };
  }

  /** Replace a session with a fresh id under the user's current epoch. */
  function rotateSession(
    idHash: string,
  ): { token: string; session: SessionRecord } | null {
    const row = q.sessionByHash.get({ hash: idHash });
    if (!row) return null;
    const user = getUser(row.user_id);
    if (!user || user.disabled) return null;
    const token = randomToken();
    const at = now();
    const next: SessionRow = {
      ...row,
      id_hash: hashSecret(token),
      privilege_epoch: user.privilegeEpoch,
      last_seen_at: at,
    };
    db.transaction(() => {
      // Requests racing the rotation (other tabs reconnecting) still carry
      // the old cookie: keep it for a minute, already at the new epoch.
      db.query(
        `UPDATE sessions SET public_id = $retired, privilege_epoch = $epoch,
           expires_at = MIN(expires_at, $until) WHERE id_hash = $hash`,
      ).run({
        hash: idHash,
        retired: `${row.public_id}~${randomBytes(3).toString("base64url")}`,
        epoch: user.privilegeEpoch,
        until: at + SESSION_ROTATION_GRACE_MS,
      });
      db.query(
        `INSERT INTO sessions (id_hash, public_id, user_id, auth_method, privilege_epoch, user_agent, created_at, last_seen_at, expires_at)
         VALUES ($id_hash, $public_id, $user_id, $auth_method, $privilege_epoch, $user_agent, $created_at, $last_seen_at, $expires_at)`,
      ).run(next);
    })();
    changed();
    return { token, session: toSession(next) };
  }

  function deleteSessionByHash(idHash: string, actor: string | null): boolean {
    const row = q.sessionByHash.get({ hash: idHash });
    if (!row) return false;
    db.query("DELETE FROM sessions WHERE id_hash = $hash").run({
      hash: idHash,
    });
    audit(actor, "session.revoke", row.user_id, { session: row.public_id });
    changed();
    return true;
  }

  return {
    db,

    /** Changes when this or another process commits account data. */
    changeStamp(): string {
      return `${q.dataVersion.get()?.data_version ?? 0}:${revision}`;
    },

    audit,

    // Users.
    getUser,
    findUserByName,
    /** A user by id, name, or linked identity subject (e.g. a Tailscale login). */
    findUser(query: string): User | null {
      const text = query.trim();
      if (!text) return null;
      const byId = getUser(text);
      if (byId) return byId;
      const byName = findUserByName(text);
      if (byName) return byName;
      const row = db
        .query<{ user_id: string }, { subject: string }>(
          "SELECT user_id FROM identities WHERE subject = $subject COLLATE NOCASE OR email = $subject COLLATE NOCASE LIMIT 2",
        )
        .all({ subject: text });
      return row.length === 1 ? getUser(row[0]!.user_id) : null;
    },
    listUsers(): User[] {
      return q.users.all().flatMap((row) => toUser(row) ?? []);
    },
    userCount(): number {
      return q.userCount.get()?.count ?? 0;
    },
    identitiesOf(userId: string) {
      return q.identitiesForUser.all({ user: userId }).map((row) => ({
        provider: row.provider,
        subject: row.subject,
        displayName: row.display_name,
      }));
    },
    createUser,
    uniqueName,
    setRole(userId: string, role: InstanceRole, actor: string | null) {
      const user = getUser(userId);
      if (!user) throw new Error("unknown user");
      if (user.role === role) return user;
      db.query(
        "UPDATE users SET role = $role, updated_at = $at WHERE id = $id",
      ).run({ id: userId, role, at: now() });
      bumpEpoch(userId);
      audit(actor, "user.role", userId, { role });
      return getUser(userId)!;
    },
    setDisabled(userId: string, disabled: boolean, actor: string | null) {
      const user = getUser(userId);
      if (!user) throw new Error("unknown user");
      db.query(
        "UPDATE users SET disabled = $disabled, updated_at = $at WHERE id = $id",
      ).run({ id: userId, disabled: disabled ? 1 : 0, at: now() });
      if (disabled)
        db.query("DELETE FROM sessions WHERE user_id = $id").run({
          id: userId,
        });
      bumpEpoch(userId);
      audit(actor, disabled ? "user.disable" : "user.enable", userId);
      return getUser(userId)!;
    },
    setDisplayName(userId: string, displayName: string, actor: string | null) {
      const name = cleanText(displayName, MAX_DISPLAY_NAME);
      if (!name) throw new Error("display name required");
      db.query(
        "UPDATE users SET display_name = $name, updated_at = $at WHERE id = $id",
      ).run({ id: userId, name, at: now() });
      audit(actor, "user.display_name", userId);
      changed();
    },
    deleteUser(userId: string, actor: string | null) {
      const user = getUser(userId);
      if (!user) return false;
      db.query("DELETE FROM users WHERE id = $id").run({ id: userId });
      audit(actor, "user.delete", userId, { name: user.name });
      changed();
      return true;
    },

    // Identities.
    findIdentity,
    linkIdentity,
    touchIdentity(provider: string, subject: string) {
      db.query(
        "UPDATE identities SET last_used_at = $at WHERE provider = $provider AND subject = $subject",
      ).run({ at: now(), provider, subject });
    },

    // Sessions.
    createSession,
    resolveSession,
    rotateSession,
    sessionByHash(idHash: string): SessionRecord | null {
      const row = q.sessionByHash.get({ hash: idHash });
      return row && row.expires_at > now() ? toSession(row) : null;
    },
    deleteSessionByToken(token: string, actor: string | null): boolean {
      return deleteSessionByHash(hashSecret(token), actor);
    },
    deleteSessionByHash,
    /** Revoke by public id; limited to one user's sessions when given. */
    revokeSession(
      publicId: string,
      options: { userId?: string; actor: string | null },
    ): SessionRecord | null {
      const row = db
        .query<SessionRow, { id: string }>(
          "SELECT * FROM sessions WHERE public_id = $id",
        )
        .get({ id: publicId });
      if (!row || (options.userId && row.user_id !== options.userId))
        return null;
      deleteSessionByHash(row.id_hash, options.actor);
      return toSession(row);
    },
    revokeUserSessions(userId: string, actor: string | null): number {
      const result = db
        .query("DELETE FROM sessions WHERE user_id = $id")
        .run({ id: userId });
      audit(actor, "session.revoke_all", userId, { count: result.changes });
      changed();
      return result.changes;
    },
    listSessions(userId?: string): SessionRecord[] {
      const rows = userId
        ? q.sessionsForUser.all({ user: userId, now: now() })
        : q.allSessions.all({ now: now() });
      return rows.map(toSession);
    },
    pruneExpired() {
      db.query("DELETE FROM sessions WHERE expires_at <= $now").run({
        now: now(),
      });
      db.query("DELETE FROM enrollments WHERE expires_at <= $now").run({
        now: now(),
      });
    },

    // Passkeys.
    addPasskey(record: Omit<PasskeyRecord, "createdAt" | "lastUsedAt">) {
      db.query(
        `INSERT INTO passkeys (credential_id, user_id, public_key, counter, transports, rp_id, name, created_at)
         VALUES ($id, $user, $key, $counter, $transports, $rp, $name, $at)`,
      ).run({
        id: record.credentialId,
        user: record.userId,
        key: record.publicKey,
        counter: record.counter,
        transports: JSON.stringify(record.transports),
        rp: record.rpId,
        name: cleanText(record.name, 80) || null,
        at: now(),
      });
      audit(record.userId, "passkey.add", record.userId, {
        rp_id: record.rpId,
      });
      changed();
    },
    getPasskey(credentialId: string): PasskeyRecord | null {
      const row = q.passkey.get({ id: credentialId });
      return row ? toPasskey(row) : null;
    },
    passkeysOf(userId: string): PasskeyRecord[] {
      return q.passkeysForUser.all({ user: userId }).map(toPasskey);
    },
    usePasskey(credentialId: string, counter: number) {
      db.query(
        "UPDATE passkeys SET counter = $counter, last_used_at = $at WHERE credential_id = $id",
      ).run({ id: credentialId, counter, at: now() });
    },
    removePasskey(
      credentialId: string,
      userId: string,
      actor: string | null,
    ): boolean {
      const result = db
        .query(
          "DELETE FROM passkeys WHERE credential_id = $id AND user_id = $user",
        )
        .run({ id: credentialId, user: userId });
      if (result.changes > 0) {
        audit(actor, "passkey.remove", userId);
        changed();
      }
      return result.changes > 0;
    },

    // Enrollment links.
    createEnrollment(
      userId: string,
      actor: string | null,
      ttlMs = ENROLLMENT_TTL_MS,
    ): { secret: string; expiresAt: number } {
      const secret = randomToken();
      const expiresAt = now() + ttlMs;
      db.query(
        "INSERT INTO enrollments (secret_hash, user_id, created_at, expires_at) VALUES ($hash, $user, $at, $expires)",
      ).run({
        hash: hashSecret(secret),
        user: userId,
        at: now(),
        expires: expiresAt,
      });
      audit(actor, "enrollment.create", userId);
      changed();
      return { secret, expiresAt };
    },
    /** The user an unexpired enrollment secret belongs to. */
    enrollmentUser(secret: string): User | null {
      if (!secret || secret.length > 128) return null;
      const row = db
        .query<{ user_id: string; expires_at: number }, { hash: string }>(
          "SELECT user_id, expires_at FROM enrollments WHERE secret_hash = $hash",
        )
        .get({ hash: hashSecret(secret) });
      if (!row || row.expires_at <= now()) return null;
      const user = getUser(row.user_id);
      return user && !user.disabled ? user : null;
    },
    consumeEnrollment(secret: string): boolean {
      const result = db
        .query(
          "DELETE FROM enrollments WHERE secret_hash = $hash AND expires_at > $now",
        )
        .run({ hash: hashSecret(secret), now: now() });
      changed();
      return result.changes > 0;
    },

    // Workspace grants.
    /**
     * Grant, change or (role null) remove a user's role on a workspace. Share
     * links and invitations call this too. Returns whether anything changed.
     */
    setGrant(args: {
      connectionId: string;
      workspaceId: string;
      userId: string;
      role: WorkspaceRole | null;
      actor: string | null;
    }): boolean {
      const at = now();
      const result = args.role
        ? db
            .query(
              `INSERT INTO workspace_grants (connection_id, workspace_id, user_id, role, granted_by, created_at, updated_at)
               VALUES ($connection, $workspace, $user, $role, $actor, $at, $at)
               ON CONFLICT (connection_id, workspace_id, user_id) DO UPDATE SET
                 role = excluded.role, granted_by = excluded.granted_by, updated_at = excluded.updated_at
               WHERE workspace_grants.role <> excluded.role`,
            )
            .run({
              connection: args.connectionId,
              workspace: args.workspaceId,
              user: args.userId,
              role: args.role,
              actor: args.actor,
              at,
            })
        : db
            .query(
              "DELETE FROM workspace_grants WHERE connection_id = $connection AND workspace_id = $workspace AND user_id = $user",
            )
            .run({
              connection: args.connectionId,
              workspace: args.workspaceId,
              user: args.userId,
            });
      if (result.changes === 0) return false;
      bumpEpoch(args.userId);
      audit(args.actor, args.role ? "grant.set" : "grant.remove", args.userId, {
        connection: args.connectionId,
        workspace: args.workspaceId,
        role: args.role,
      });
      return true;
    },
    /** Remove every grant on a workspace (it closed); returns affected users. */
    removeWorkspaceGrants(connectionId: string, workspaceId: string): string[] {
      const users = db
        .query<{ user_id: string }, { connection: string; workspace: string }>(
          "SELECT user_id FROM workspace_grants WHERE connection_id = $connection AND workspace_id = $workspace",
        )
        .all({ connection: connectionId, workspace: workspaceId })
        .map((row) => row.user_id);
      if (users.length === 0) return [];
      db.query(
        "DELETE FROM workspace_grants WHERE connection_id = $connection AND workspace_id = $workspace",
      ).run({ connection: connectionId, workspace: workspaceId });
      for (const user of users) bumpEpoch(user);
      audit(null, "grant.workspace_closed", null, {
        connection: connectionId,
        workspace: workspaceId,
        users: users.length,
      });
      return users;
    },
    grantsOf(userId: string): Map<string, WorkspaceRole> {
      const grants = new Map<string, WorkspaceRole>();
      for (const row of q.grantsForUser.all({ user: userId }))
        grants.set(grantKey(row.connection_id, row.workspace_id), row.role);
      return grants;
    },
    grantsOn(connectionId: string, workspaceId: string): GrantRecord[] {
      return q.grantsForWorkspace
        .all({ connection: connectionId, workspace: workspaceId })
        .map((row) => ({
          connectionId: row.connection_id,
          workspaceId: row.workspace_id,
          userId: row.user_id,
          userName: row.name,
          displayName: row.display_name,
          role: row.role,
          grantedBy: row.granted_by,
          updatedAt: row.updated_at,
        }));
    },
    listAudit(limit = 50) {
      return db
        .query<
          {
            id: number;
            at: number;
            actor: string | null;
            action: string;
            target: string | null;
            detail: string | null;
          },
          { limit: number }
        >("SELECT * FROM audit_log ORDER BY id DESC LIMIT $limit")
        .all({ limit });
    },
  };
}

export function grantKey(connectionId: string, workspaceId: string): string {
  return `${connectionId}\u0000${workspaceId}`;
}
