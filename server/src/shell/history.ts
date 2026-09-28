import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import type {
  ShellHistoryEntry,
  ShellHistoryParams,
  ShellName,
} from "../../../shared/shell";
import type { ShellRecord } from "./state";

export interface ImportedCommand {
  command: string;
  start_ts: number;
  end_ts: number | null;
}
/** zsh escapes raw bytes with Meta (0x83), followed by byte XOR 32. */
export function unmetafy(bytes: Uint8Array) {
  const result: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    result.push(
      byte === 0x83 && i + 1 < bytes.length ? bytes[++i]! ^ 32 : byte,
    );
  }
  return Buffer.from(result).toString("utf8");
}
export function parseHistory(
  shell: ShellName,
  bytes: Uint8Array,
): ImportedCommand[] {
  const text =
    shell === "zsh" ? unmetafy(bytes) : Buffer.from(bytes).toString("utf8");
  const entries: ImportedCommand[] = [];
  if (shell === "fish") {
    for (const line of text.split("\n")) {
      if (line.startsWith("- cmd: ")) {
        const command = line
          .slice(7)
          .replace(/\\(\\|n)/g, (_, c: string) => (c === "n" ? "\n" : "\\"));
        if (command && !command.startsWith(" "))
          entries.push({ command, start_ts: 0, end_ts: null });
      } else if (/^\s+when: \d+$/.test(line) && entries.length) {
        entries.at(-1)!.start_ts = Number(line.trim().slice(6)) * 1000;
      }
    }
    return entries;
  }
  if (shell === "zsh") {
    const lines = text.replace(/\\\n/g, "\0").split("\n");
    for (const line of lines) {
      const match = /^: (\d+):(\d+);([\s\S]*)$/.exec(line);
      const command = (match?.[3] ?? line).replaceAll("\0", "\n");
      if (command && !command.startsWith(" "))
        entries.push({
          command,
          start_ts: Number(match?.[1] ?? 0) * 1000,
          end_ts: match ? (Number(match[1]) + Number(match[2])) * 1000 : null,
        });
    }
    return entries;
  }
  const timestamped = /^#\d{9,}\r?$/m.test(text);
  let timestamp = 0;
  let command = "";
  const flush = () => {
    if (command && !command.startsWith(" "))
      entries.push({ command, start_ts: timestamp, end_ts: null });
    command = "";
  };
  for (const line of text.replace(/\n$/, "").split("\n")) {
    if (/^#\d{9,}$/.test(line)) {
      flush();
      timestamp = Number(line.slice(1)) * 1000;
    } else if (timestamped) command += `${command ? "\n" : ""}${line}`;
    else {
      command = line;
      flush();
    }
  }
  flush();
  return entries;
}
export function fuzzyMatch(command: string, query: string) {
  let index = 0;
  for (const c of command.toLowerCase())
    if (c === query.toLowerCase()[index]) index++;
  return index === query.length;
}
export function historyScore(
  entry: ShellHistoryEntry & { uses: number },
  cwd: string,
  now: number,
) {
  const ageDays = Math.max(0, now - entry.start_ts) / 86_400_000;
  return (
    Math.log2(entry.uses + 1) * 10 +
    30 / (1 + ageDays) +
    (entry.cwd === cwd ? 20 : 0)
  );
}

export class ShellHistoryStore {
  private db: Database;
  private ingestion: Promise<void> | undefined;
  constructor(
    path: string,
    private spool: string,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    // Rollback journal avoids persistent WAL files with broader permissions.
    this.db.exec(`PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY, command TEXT NOT NULL, cwd TEXT NOT NULL, exit INTEGER,
        start_ts REAL NOT NULL, end_ts REAL, pane TEXT NOT NULL, shell TEXT NOT NULL,
        host TEXT NOT NULL, pid INTEGER, seq INTEGER);
      CREATE INDEX IF NOT EXISTS history_end ON history(pid,seq,start_ts);
      CREATE TABLE IF NOT EXISTS imports (path TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS offsets (path TEXT PRIMARY KEY, identity TEXT, offset INTEGER);`);
  }
  async import(record: ShellRecord) {
    if (
      !record.histfile ||
      this.db
        .query("SELECT path FROM imports WHERE path=?")
        .get(record.histfile)
    )
      return;
    const file = await open(record.histfile, "r").catch(() => null);
    if (!file) return;
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== (process.getuid?.() ?? 0) ||
        stat.size > 32 * 1024 * 1024
      )
        return;
      const entries = parseHistory(record.shell, await file.readFile());
      this.db.transaction(() => {
        for (const [index, entry] of entries.entries()) {
          this.insert(
            `import:${record.histfile}:${index}`,
            {
              ...entry,
              cwd: "",
              exit: null,
              pane: record.pane,
              shell: record.shell,
              host: hostname(),
            },
            null,
            null,
          );
        }
        this.db
          .query("INSERT OR IGNORE INTO imports VALUES (?)")
          .run(record.histfile);
      })();
    } finally {
      await file.close();
    }
  }
  private insert(
    id: string,
    entry: ShellHistoryEntry,
    pid: number | null,
    seq: number | null,
  ) {
    this.db
      .query("INSERT OR IGNORE INTO history VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        entry.command,
        entry.cwd,
        entry.exit,
        entry.start_ts,
        entry.end_ts,
        entry.pane,
        entry.shell,
        entry.host,
        pid,
        seq,
      );
  }
  ingest() {
    if (this.ingestion) return this.ingestion;
    this.ingestion = this.ingestOnce().finally(() => {
      this.ingestion = undefined;
    });
    return this.ingestion;
  }
  private async ingestOnce() {
    const file = await open(this.spool, "r").catch(() => null);
    if (!file) return;
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== (process.getuid?.() ?? 0) ||
        stat.mode & 0o077
      )
        return;
      const identity = `${stat.dev}:${stat.ino}`;
      const saved = this.db
        .query("SELECT identity,offset FROM offsets WHERE path=?")
        .get(this.spool) as { identity: string; offset: number } | null;
      let offset =
        saved?.identity === identity && saved.offset <= stat.size
          ? saved.offset
          : 0;
      const bytes = Buffer.alloc(Math.min(stat.size - offset, 8 * 1024 * 1024));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      const last = bytes.subarray(0, bytesRead).lastIndexOf(10);
      if (last < 0) return; // Retain incomplete records for the next ingestion.
      this.db.transaction(() => {
        for (const line of bytes
          .subarray(0, last)
          .toString("utf8")
          .split("\n")) {
          try {
            const row = JSON.parse(line);
            if (
              !Number.isSafeInteger(row.pid) ||
              !Number.isSafeInteger(row.seq)
            )
              continue;
            if (
              typeof row.command === "string" &&
              row.command &&
              !row.command.startsWith(" ") &&
              typeof row.cwd === "string" &&
              typeof row.pane === "string" &&
              ["bash", "zsh", "fish"].includes(row.shell) &&
              Number.isFinite(row.start_ts)
            ) {
              this.insert(
                `spool:${row.pid}:${row.seq}:${row.start_ts}`,
                { ...row, exit: null, end_ts: null, host: hostname() },
                row.pid,
                row.seq,
              );
            } else if (
              Number.isInteger(row.exit) &&
              Number.isFinite(row.end_ts)
            ) {
              this.db
                .query(
                  "UPDATE history SET exit=?,end_ts=? WHERE id=(SELECT id FROM history WHERE pid=? AND seq=? AND start_ts<=? ORDER BY start_ts DESC LIMIT 1)",
                )
                .run(row.exit, row.end_ts, row.pid, row.seq, row.end_ts);
            }
          } catch {
            /* A partial/corrupt writer must not stop later records. */
          }
        }
        offset += last + 1;
        this.db
          .query("INSERT OR REPLACE INTO offsets VALUES (?,?,?)")
          .run(this.spool, identity, offset);
      })();
    } finally {
      await file.close();
    }
  }
  search(
    params: ShellHistoryParams,
    cwd: string,
    now = Date.now(),
  ): ShellHistoryEntry[] {
    const limit = Math.min(
      2000,
      Math.max(1, Math.trunc(params.limit ?? (params.latest ? 2000 : 100))),
    );
    const rows = this.db
      .query(`SELECT command,cwd,exit,start_ts,end_ts,pane,shell,host,
      COUNT(*) OVER (PARTITION BY command) AS uses FROM history ORDER BY start_ts DESC LIMIT 50000`)
      .all() as (ShellHistoryEntry & { uses: number })[];
    const seen = new Set<string>();
    const filtered = rows.filter((row) => {
      if (params.cwd && row.cwd !== params.cwd) return false;
      if (seen.has(row.command)) return false;
      seen.add(row.command);
      return (
        (!params.query || fuzzyMatch(row.command, params.query)) &&
        (!params.prefix || row.command.includes(params.prefix))
      );
    });
    if (!params.latest)
      filtered.sort(
        (a, b) =>
          Number(b.command.startsWith(params.prefix ?? "")) -
            Number(a.command.startsWith(params.prefix ?? "")) ||
          historyScore(b, cwd, now) - historyScore(a, cwd, now),
      );
    return filtered.slice(0, limit).map((entry) => ({
      command: entry.command,
      cwd: entry.cwd,
      exit: entry.exit,
      start_ts: entry.start_ts,
      end_ts: entry.end_ts,
      pane: entry.pane,
      shell: entry.shell,
      host: entry.host,
    }));
  }
  async close() {
    await this.ingestion;
    this.db.close();
  }
}
