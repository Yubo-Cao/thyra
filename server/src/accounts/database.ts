import { Database } from "bun:sqlite";
import { chmodSync, closeSync, constants, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertSafeDataPath, dataRoot } from "../config/data-paths";
import { thyraEnv } from "../config/environment";

/**
 * The account database: users, their identities and passkeys, login
 * sessions, workspace grants, share links and their guest sessions, and the
 * audit log. One SQLite file in the data
 * directory (`THYRA_DB_PATH` overrides), mode 0600, WAL so the CLI can write
 * while the server runs. Schema changes are appended to `MIGRATIONS`; the
 * index of the last applied one is stored in `PRAGMA user_version`.
 *
 * Every step tolerates objects that already exist (`IF NOT EXISTS`, and
 * `addColumn` for `ALTER TABLE ... ADD COLUMN`, which has no such clause),
 * so an object left by an aborted or unreleased migration never stops the
 * server from starting.
 */

/** `ALTER TABLE table ADD COLUMN column definition`, unless it exists. */
type AddColumn = { table: string; column: string; definition: string };
type Migration = string | readonly (string | AddColumn)[];

function addColumn(
  table: string,
  column: string,
  definition: string,
): AddColumn {
  return { table, column, definition };
}

const MIGRATIONS: readonly Migration[] = [
  `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    disabled INTEGER NOT NULL DEFAULT 0,
    -- Bumped on every change of role, grants or status. Sessions issued
    -- under an older epoch are rotated and live sockets are reconnected.
    privilege_epoch INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- External identities linked to an account. provider is 'tailscale' today;
  -- OIDC providers use 'oidc:<issuer>' with the token's sub as subject.
  CREATE TABLE IF NOT EXISTS identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT,
    display_name TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    PRIMARY KEY (provider, subject)
  );
  CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);
  CREATE TABLE IF NOT EXISTS sessions (
    -- SHA-256 of the random cookie value; the value itself is never stored.
    id_hash TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    auth_method TEXT NOT NULL,
    privilege_epoch INTEGER NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS passkeys (
    credential_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT,
    rp_id TEXT NOT NULL,
    name TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
  -- One-time passkey enrollment links; the secret lives in the URL fragment.
  CREATE TABLE IF NOT EXISTS enrollments (
    secret_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  -- Herdr keeps workspace ids across restarts and live handoff, so a grant
  -- names the connection and the workspace id. Grants are removed when the
  -- workspace closes.
  CREATE TABLE IF NOT EXISTS workspace_grants (
    connection_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    granted_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (connection_id, workspace_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS workspace_grants_user ON workspace_grants(user_id);
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT
  );
  `,
  `
  -- Anonymous read-only share links. The secret lives in the URL fragment;
  -- only its SHA-256 is stored. A link shares one workspace, optionally
  -- narrowed to one pane, and always with the viewer role.
  CREATE TABLE IF NOT EXISTS share_links (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    pane_id TEXT,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK (role = 'viewer'),
    label TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS share_links_workspace ON share_links(connection_id, workspace_id);
  -- A redeemed link: a guest principal without an account. Revoking or
  -- expiring the link ends its guest sessions.
  CREATE TABLE IF NOT EXISTS guest_sessions (
    id_hash TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS guest_sessions_link ON guest_sessions(link_id);
  `,
  `
  -- Single-use tailnet sign-in codes: the tailnet listener issues one to a
  -- Tailscale-identified account, bound to a PKCE challenge and the public
  -- origin that may redeem it. Only the code's SHA-256 is stored.
  CREATE TABLE IF NOT EXISTS tailnet_sso_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    challenge TEXT NOT NULL,
    return_origin TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  [
    // Profile pictures: the file name of an uploaded avatar (content hash).
    addColumn("users", "avatar", "TEXT"),
    // Sign-in providers: identities 'email' (subject: the address), 'github'
    // and 'google' (subject: the provider's user id). email_verified is 1
    // when the provider (or a mailed code) confirmed the address.
    addColumn("identities", "email_verified", "INTEGER NOT NULL DEFAULT 0"),
    addColumn("identities", "avatar_url", "TEXT"),
    `
  CREATE INDEX IF NOT EXISTS identities_email ON identities(email COLLATE NOCASE);
  -- Mailed sign-in and verification codes: a 6-digit code and a link
  -- secret, both stored only as SHA-256 digests, single use.
  CREATE TABLE IF NOT EXISTS email_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    purpose TEXT NOT NULL CHECK (purpose IN ('login', 'verify')),
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    link_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS email_codes_email ON email_codes(email, created_at);
  -- OAuth sign-ins in progress. The page that started one holds the poll
  -- secret and picks up the session, even when the provider returned to
  -- another browser (an iOS Home Screen app opens it in Safari).
  CREATE TABLE IF NOT EXISTS oauth_flows (
    id TEXT PRIMARY KEY,
    state_hash TEXT NOT NULL UNIQUE,
    poll_hash TEXT NOT NULL,
    provider TEXT NOT NULL,
    intent TEXT NOT NULL CHECK (intent IN ('login', 'link')),
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    invite_hash TEXT,
    verifier TEXT NOT NULL,
    pairing TEXT NOT NULL,
    origin TEXT NOT NULL,
    user_agent TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    confirm_hash TEXT,
    result TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  -- Invitations by email: a pending account with a grant; the mailed link's
  -- secret (SHA-256 only) signs its holder in to that account once.
  CREATE TABLE IF NOT EXISTS invites (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  ],
];

export function defaultDatabasePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = thyraEnv("DB_PATH", env)?.trim();
  const path = override || join(dataRoot(), "thyra.db");
  assertSafeDataPath(path);
  return path;
}

export function migrate(db: Database): void {
  const current = (
    db.query("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `account database schema ${current} is newer than this Thyra (${MIGRATIONS.length}); upgrade Thyra`,
    );
  }
  for (let index = current; index < MIGRATIONS.length; index += 1) {
    const migration = MIGRATIONS[index]!;
    try {
      db.transaction(() => {
        for (const step of typeof migration === "string"
          ? [migration]
          : migration) {
          if (typeof step === "string") db.run(step);
          else if (!hasColumn(db, step.table, step.column))
            db.run(
              `ALTER TABLE ${step.table} ADD COLUMN ${step.column} ${step.definition}`,
            );
        }
        db.run(`PRAGMA user_version = ${index + 1}`);
      })();
    } catch (error) {
      throw new Error(
        `account database migration ${index + 1} of ${MIGRATIONS.length} failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

/** Open (creating if needed) and migrate the account database. */
export function openAccountDatabase(path: string | ":memory:"): Database {
  if (path !== ":memory:") {
    assertSafeDataPath(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Create the file private before SQLite opens it; SQLite gives the WAL
    // and shared-memory files the same permissions.
    closeSync(
      openSync(
        path,
        constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
        0o600,
      ),
    );
    chmodSync(path, 0o600);
  }
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
}
