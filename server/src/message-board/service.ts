import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  BoardMessage,
  MessageBoardList,
} from "../../../shared/messageBoard";

export class BoardError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const fail = (message: string): never => {
  throw new BoardError("invalid_params", message);
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("expected an object");
  return value as Record<string, unknown>;
}
function string(
  value: unknown,
  name: string,
  max: number,
  required = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    return fail(`invalid ${name}`);
  return value;
}
function fields(p: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(p).some((k) => !allowed.includes(k)))
    fail("unknown parameter");
}
const hash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
type Row = Omit<BoardMessage, "pinned" | "source" | "attachments"> & {
  pinned: number;
  source: string | null;
  attachments: string;
};
function decode(r: Row): BoardMessage {
  return {
    id: r.id,
    owner_id: r.owner_id,
    title: r.title,
    body: r.body,
    author_label: r.author_label,
    created_at: r.created_at,
    updated_at: r.updated_at,
    read_at: r.read_at,
    archived_at: r.archived_at,
    pinned: !!r.pinned,
    source: r.source ? JSON.parse(r.source) : undefined,
    attachments: JSON.parse(r.attachments),
  };
}
export function createMessageBoard(
  db: Database,
  onCreated: (
    owner: string,
    id: string,
    event: "created" | "updated",
  ) => void = () => {},
) {
  function get(owner: string, id: unknown) {
    string(id, "id", 200, true);
    const row = db
      .query<Row, [string, string]>(
        "SELECT * FROM board_messages WHERE owner_id=? AND id=?",
      )
      .get(owner, id as string);
    if (!row) throw new BoardError("not_found", "message not found", 404);
    return decode(row);
  }
  function execute(
    owner: string,
    credential: string,
    method: string,
    input: unknown,
  ): unknown {
    const p = object(input ?? {});
    if (method === "get") {
      fields(p, ["id"]);
      return get(owner, p.id);
    }
    if (method === "list") {
      fields(p, ["archived", "limit", "cursor"]);
      if (p.archived !== undefined && typeof p.archived !== "boolean")
        fail("invalid archived");
      const limit = p.limit ?? 50;
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100)
        fail("invalid limit");
      let cursor: { pinned: number; created_at: number; id: string } | null =
        null;
      if (p.cursor !== undefined) {
        try {
          cursor = JSON.parse(
            Buffer.from(
              string(p.cursor, "cursor", 1024),
              "base64url",
            ).toString(),
          );
        } catch {
          fail("invalid cursor");
        }
        if (
          !cursor ||
          ![0, 1].includes(cursor.pinned) ||
          !Number.isSafeInteger(cursor.created_at) ||
          typeof cursor.id !== "string"
        )
          fail("invalid cursor");
      }
      const rows = db
        .query<
          Row,
          [string, number, number, number, number, number, string, number]
        >(
          "SELECT * FROM board_messages WHERE owner_id=? AND (archived_at IS NOT NULL)=? AND (pinned < ? OR (pinned = ? AND (created_at < ? OR (created_at = ? AND id < ?)))) ORDER BY pinned DESC, created_at DESC, id DESC LIMIT ?",
        )
        .all(
          owner,
          p.archived ? 1 : 0,
          cursor?.pinned ?? 2,
          cursor?.pinned ?? 2,
          cursor?.created_at ?? Number.MAX_SAFE_INTEGER,
          cursor?.created_at ?? Number.MAX_SAFE_INTEGER,
          cursor?.id ?? "",
          Number(limit) + 1,
        );
      const page = rows.slice(0, Number(limit));
      const last = page.at(-1);
      return {
        messages: page.map(decode),
        unread_count: (
          db
            .query(
              "SELECT COUNT(*) AS n FROM board_messages WHERE owner_id=? AND archived_at IS NULL AND read_at IS NULL",
            )
            .get(owner) as { n: number }
        ).n,
        next_cursor:
          rows.length > Number(limit) && last
            ? Buffer.from(
                JSON.stringify({
                  pinned: last.pinned,
                  created_at: last.created_at,
                  id: last.id,
                }),
              ).toString("base64url")
            : null,
      } satisfies MessageBoardList;
    }
    if (method === "create") {
      fields(p, [
        "title",
        "body",
        "author_label",
        "source",
        "attachments",
        "idempotency_key",
      ]);
      const title = string(p.title, "title", 200, true),
        body = string(p.body, "body", 32768),
        author = string(p.author_label ?? "Agent", "author_label", 100, true);
      if (Buffer.byteLength(body) > 32768) fail("body exceeds 32 KiB");
      const key =
        p.idempotency_key === undefined
          ? null
          : string(p.idempotency_key, "idempotency_key", 200, true);
      let source = null;
      if (p.source !== undefined) {
        const s = object(p.source);
        fields(s, ["connection_id", "workspace_id", "pane_id"]);
        for (const [k, v] of Object.entries(s)) string(v, k, 200, true);
        source = JSON.stringify(s);
      }
      const attachments = p.attachments ?? [];
      if (!Array.isArray(attachments) || attachments.length > 20)
        fail("invalid attachments");
      for (const a of attachments as unknown[]) {
        const item = object(a);
        fields(item, [
          "label",
          "kind",
          "url",
          "path",
          "preview_url",
          "download_url",
        ]);
        string(item.label, "attachment label", 200, true);
        if (item.kind !== "url" && item.kind !== "file")
          fail("invalid attachment kind");
        if (item.kind === "file") {
          if (string(item.path, "path", 4096, true).includes("\0"))
            fail("invalid path");
        } else if (item.path !== undefined)
          fail("URL attachments cannot contain paths");
        else if (!item.url) fail("missing url");
        for (const name of ["url", "preview_url", "download_url"])
          if (item[name] !== undefined) {
            let u: URL;
            try {
              u = new URL(string(item[name], name, 8192, true));
            } catch {
              return fail("invalid URL");
            }
            if (
              !["http:", "https:"].includes(u.protocol) ||
              u.username ||
              u.password
            )
              fail("unsafe URL");
          }
        if (
          item.kind === "file" &&
          (item.url || item.preview_url || item.download_url)
        )
          fail("file attachments use authorized workspace paths only");
      }
      const result = db.transaction(() => {
        if (key) {
          const row = db
            .query<{ id: string }, [string, string, string]>(
              "SELECT id FROM board_messages WHERE owner_id=? AND credential_id=? AND idempotency_key=?",
            )
            .get(owner, credential, key);
          if (row) return { message: get(owner, row.id), created: false };
        }
        const id = randomUUID(),
          now = Date.now();
        db.run(
          "INSERT INTO board_messages (id,owner_id,credential_id,idempotency_key,title,body,author_label,created_at,updated_at,source,attachments) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          [
            id,
            owner,
            credential,
            key,
            title,
            body,
            author,
            now,
            now,
            source,
            JSON.stringify(attachments),
          ],
        );
        return { message: get(owner, id), created: true };
      })();
      if (result.created) onCreated(owner, result.message.id, "created");
      return result.message;
    }
    if (method === "update") {
      fields(p, ["id", "pinned", "read", "archived"]);
      const m = get(owner, p.id);
      const now = Date.now();
      for (const k of ["pinned", "read", "archived"])
        if (p[k] !== undefined && typeof p[k] !== "boolean")
          fail(`invalid ${k}`);
      db.run(
        "UPDATE board_messages SET pinned=?,read_at=?,archived_at=?,updated_at=? WHERE id=? AND owner_id=?",
        [
          p.pinned === undefined ? Number(m.pinned) : Number(p.pinned),
          p.read === undefined ? m.read_at : p.read ? (m.read_at ?? now) : null,
          p.archived === undefined
            ? m.archived_at
            : p.archived
              ? (m.archived_at ?? now)
              : null,
          now,
          m.id,
          owner,
        ],
      );
      onCreated(owner, m.id, "updated");
      return get(owner, m.id);
    }
    throw new BoardError("method_not_found", "unknown board method", 404);
  }
  function issue(owner: string, input: unknown) {
    const p = object(input);
    fields(p, ["label", "scopes", "expires_at"]);
    const label = string(p.label, "label", 100, true);
    if (
      !Array.isArray(p.scopes) ||
      !p.scopes.length ||
      p.scopes.some((v) => !["create", "list", "get", "update"].includes(v))
    )
      fail("invalid scopes");
    if (
      !Number.isSafeInteger(p.expires_at) ||
      Number(p.expires_at) <= Date.now() ||
      Number(p.expires_at) > Date.now() + 366 * 86400000
    )
      fail("expiry must be within one year");
    const secret = `thyra_board_${randomBytes(32).toString("base64url")}`,
      id = randomUUID();
    db.run("INSERT INTO board_credentials VALUES (?,?,?,?,?,?,?,NULL)", [
      id,
      owner,
      hash(secret),
      label,
      JSON.stringify(p.scopes),
      Date.now(),
      Number(p.expires_at),
    ]);
    return { id, token: secret };
  }
  function authenticate(secret: string, method?: string) {
    const r = db
      .query<
        { id: string; owner_id: string; scopes: string },
        [string, number]
      >(
        "SELECT id,owner_id,scopes FROM board_credentials WHERE secret_hash=? AND revoked_at IS NULL AND expires_at>?",
      )
      .get(hash(secret), Date.now());
    if (!r || (method !== undefined && !JSON.parse(r.scopes).includes(method)))
      throw new BoardError(
        "unauthorized",
        "invalid or insufficient agent credential",
        401,
      );
    if (r.owner_id.startsWith("user:")) {
      const user = db
        .query<{ disabled: number }, [string]>(
          "SELECT disabled FROM users WHERE id=?",
        )
        .get(r.owner_id.slice(5));
      if (!user || user.disabled)
        throw new BoardError("unauthorized", "account unavailable", 401);
    }
    return r;
  }
  function credentials(owner: string) {
    return db
      .query<Record<string, unknown>, [string]>(
        "SELECT id,label,scopes,created_at,expires_at,revoked_at FROM board_credentials WHERE owner_id=? ORDER BY created_at DESC",
      )
      .all(owner)
      .map((r) => ({
        ...r,
        scopes: JSON.parse((r as { scopes: string }).scopes),
      }));
  }
  function revoke(owner: string, id: unknown) {
    string(id, "id", 200, true);
    const r = db.run(
      "UPDATE board_credentials SET revoked_at=? WHERE owner_id=? AND id=?",
      [Date.now(), owner, id as string],
    );
    if (!r.changes)
      throw new BoardError("not_found", "credential not found", 404);
    return { ok: true };
  }
  return { execute, issue, authenticate, credentials, revoke };
}
