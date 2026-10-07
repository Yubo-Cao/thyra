import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { SessionFile } from "./session-types";

type AntigravitySessionSummary = {
  sessionId: string;
  cwd?: string;
};

type AntigravitySessionDescriptor = {
  session: AntigravitySessionSummary;
  file: SessionFile;
};

interface ProtoField {
  fieldNum: number;
  wireType: number;
  val: any;
}

function decodeVarint(
  buf: Uint8Array,
  pos: number,
): { val: number | bigint; pos: number } | null {
  let res = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    res |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if (!(b & 0x80)) {
      const num = Number(res);
      return { val: Number.isSafeInteger(num) ? num : res, pos };
    }
  }
  return null;
}

function decodeProto(buf: Uint8Array | null | undefined): ProtoField[] {
  if (!buf || buf.length === 0) return [];
  let pos = 0;
  const fields: ProtoField[] = [];
  try {
    while (pos < buf.length) {
      const keyRes = decodeVarint(buf, pos);
      if (!keyRes) break;
      pos = keyRes.pos;
      const key = Number(keyRes.val);
      const wireType = key & 7;
      const fieldNum = key >> 3;
      if (fieldNum === 0) break;

      let val: any;
      if (wireType === 0) {
        const vRes = decodeVarint(buf, pos);
        if (!vRes) break;
        pos = vRes.pos;
        val = vRes.val;
      } else if (wireType === 1) {
        val = buf.subarray(pos, pos + 8);
        pos += 8;
      } else if (wireType === 2) {
        const lenRes = decodeVarint(buf, pos);
        if (!lenRes) break;
        pos = lenRes.pos;
        const len = Number(lenRes.val);
        if (pos + len > buf.length) break;
        val = buf.subarray(pos, pos + len);
        pos += len;
      } else if (wireType === 5) {
        val = buf.subarray(pos, pos + 4);
        pos += 4;
      } else {
        break;
      }
      fields.push({ fieldNum, wireType, val });
    }
  } catch {
    // Incomplete or malformed protobuf blob
  }
  return fields;
}

function toUtf8String(val: unknown): string {
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
    return Buffer.from(val).toString("utf8");
  }
  if (typeof val === "string") return val;
  return "";
}

function withTempDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "thyra-agy-"));
  const tempDbPath = join(tempDir, basename(dbPath));
  try {
    copyFileSync(dbPath, tempDbPath);
    if (existsSync(`${dbPath}-wal`)) {
      copyFileSync(`${dbPath}-wal`, `${tempDbPath}-wal`);
    }
    if (existsSync(`${dbPath}-shm`)) {
      copyFileSync(`${dbPath}-shm`, `${tempDbPath}-shm`);
    }
    const db = new Database(tempDbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures
    }
  }
}

function safeSessionId(value: string) {
  return !!value && value !== "." && value !== ".." && !/[\\/\0]/.test(value);
}

function antigravityHome() {
  const configured =
    process.env.ANTIGRAVITY_HOME?.trim() || process.env.GEMINI_HOME?.trim();
  if (!configured) return join(homedir(), ".gemini", "antigravity-cli");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

function antigravityConversationsRoot() {
  const configured = process.env.ANTIGRAVITY_CONVERSATIONS_DIR?.trim();
  if (!configured) return join(antigravityHome(), "conversations");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

function sameDirectory(left: string, right: string) {
  return resolve(left) === resolve(right);
}

type AntigravityMetadata = {
  sessionId: string;
  cwd?: string;
  updatedAtMs?: number;
};

function inspectAntigravityDb(
  db: Database,
  fallbackSessionId: string,
): AntigravityMetadata {
  let sessionId = fallbackSessionId;
  try {
    const traj = db
      .query("SELECT cascade_id, trajectory_id FROM trajectory_meta LIMIT 1")
      .get() as { cascade_id?: string; trajectory_id?: string } | null;
    if (traj?.cascade_id) sessionId = traj.cascade_id;
    else if (traj?.trajectory_id) sessionId = traj.trajectory_id;
  } catch {}

  let cwd: string | undefined;
  try {
    const blobRow = db
      .query(
        'SELECT data FROM trajectory_metadata_blob WHERE id = "main" LIMIT 1',
      )
      .get() as { data?: Uint8Array } | null;
    if (blobRow?.data) {
      const fields = decodeProto(blobRow.data);
      const f7 = fields.find((f) => f.fieldNum === 7);
      const f1 = fields.find((f) => f.fieldNum === 1);
      const rawUri = f7 ? toUtf8String(f7.val) : f1 ? toUtf8String(f1.val) : "";
      if (rawUri.startsWith("file://")) {
        cwd = rawUri.replace(/^file:\/\//, "");
      } else if (rawUri) {
        cwd = rawUri;
      }
    }
  } catch {}

  let updatedAtMs: number | undefined;
  try {
    const last = db
      .query("SELECT metadata FROM steps ORDER BY idx DESC LIMIT 1")
      .get() as { metadata?: Uint8Array } | null;
    if (last?.metadata) {
      const meta = decodeProto(last.metadata);
      const ts = meta.find((f) => f.fieldNum === 1);
      if (ts) {
        const sub = decodeProto(ts.val);
        const sec = sub.find((f) => f.fieldNum === 1);
        if (sec) updatedAtMs = Number(sec.val) * 1000;
      }
    }
  } catch {}

  return { sessionId, cwd, updatedAtMs };
}

export async function describeAntigravitySessionPath(
  path: string,
): Promise<AntigravitySessionDescriptor | null> {
  let targetPath = resolve(path);
  let statInfo;
  try {
    statInfo = await stat(targetPath);
  } catch {
    if (!targetPath.endsWith(".db")) {
      try {
        targetPath = `${targetPath}.db`;
        statInfo = await stat(targetPath);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  if (!statInfo.isFile()) return null;

  let mtimeMs = statInfo.mtimeMs;
  try {
    const walStat = statSync(`${targetPath}-wal`);
    if (walStat.mtimeMs > mtimeMs) mtimeMs = walStat.mtimeMs;
  } catch {}

  const fallbackId = basename(targetPath, ".db");
  let metadata: AntigravityMetadata;
  try {
    metadata = withTempDb(targetPath, (db) =>
      inspectAntigravityDb(db, fallbackId),
    );
  } catch {
    return null;
  }

  return {
    session: { sessionId: metadata.sessionId, cwd: metadata.cwd },
    file: {
      path: targetPath,
      mtimeMs: metadata.updatedAtMs ?? mtimeMs,
      size: statInfo.size,
      sessionId: metadata.sessionId,
    },
  };
}

export async function findAntigravitySessionById(
  id: string,
  cwd = "",
  root = antigravityConversationsRoot(),
): Promise<AntigravitySessionDescriptor | null> {
  if (!safeSessionId(id)) return null;
  const filename = id.endsWith(".db") ? id : `${id}.db`;
  const direct = join(root, filename);
  if (existsSync(direct)) {
    const desc = await describeAntigravitySessionPath(direct);
    if (desc) return desc;
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches = entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".db") &&
        (e.name.startsWith(id) || basename(e.name, ".db").startsWith(id)),
    )
    .map((e) => join(root, e.name));

  if (matches.length === 0) return null;
  const descriptors = (
    await Promise.all(matches.map((p) => describeAntigravitySessionPath(p)))
  ).filter((d): d is AntigravitySessionDescriptor => !!d);

  return (
    descriptors
      .filter(
        (item) =>
          !cwd || (!!item.session.cwd && sameDirectory(item.session.cwd, cwd)),
      )
      .toSorted((a, b) => b.file.mtimeMs - a.file.mtimeMs)[0] ?? null
  );
}

export async function findAntigravitySessionForCwd(
  cwd: string,
  root = antigravityConversationsRoot(),
): Promise<AntigravitySessionDescriptor | null> {
  if (!cwd) return null;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const dbPaths = entries
    .filter((e) => e.isFile() && e.name.endsWith(".db"))
    .map((e) => join(root, e.name));

  const descriptors = (
    await Promise.all(dbPaths.map((p) => describeAntigravitySessionPath(p)))
  ).filter((d): d is AntigravitySessionDescriptor => !!d);

  return (
    descriptors
      .filter(
        (item) => !!item.session.cwd && sameDirectory(item.session.cwd, cwd),
      )
      .toSorted((a, b) => b.file.mtimeMs - a.file.mtimeMs)[0] ?? null
  );
}
