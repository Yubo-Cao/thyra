import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assertSafeDataPath, dataRoot } from "../config/data-paths";
import { thyraEnv } from "../config/environment";

/**
 * MCP bearer tokens. Only a SHA-256 digest of each token is stored; the
 * plaintext is printed once at creation. Tokens are 256-bit random secrets,
 * so a fast digest is sufficient (there is nothing to brute-force).
 */

const TOKEN_PREFIX = "thyra_mcp_";
const TOKEN_PATTERN = /^thyra_mcp_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TOKENS = 256;
const MAX_SCOPE_ENTRIES = 256;

/**
 * `all`, or workspace ids. An unqualified id (`w1`) names a workspace on the
 * default connection; `connection/w1` names one on another connection.
 */
export type McpScope =
  | { kind: "all" }
  | { kind: "workspaces"; entries: McpScopeEntry[] };

export type McpScopeEntry = {
  connectionId: string | null;
  workspaceId: string;
};

export type McpTokenRecord = {
  id: string;
  name: string;
  sha256: string;
  scope: "all" | string[];
  created_at: string;
};

export type McpPrincipal = {
  tokenId: string;
  name: string;
  scope: McpScope;
};

export function defaultMcpTokensPath(): string {
  const override = thyraEnv("MCP_TOKENS_PATH")?.trim();
  const path = override || join(dataRoot(), "mcp-tokens.json");
  assertSafeDataPath(path);
  return path;
}

export function parseScope(value: string | readonly string[]): McpScope {
  const raw = (typeof value === "string" ? value.split(",") : [...value])
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (raw.length === 0) throw new Error("scope must be `all` or workspace ids");
  if (raw.length === 1 && raw[0] === "all") return { kind: "all" };
  if (raw.includes("all")) {
    throw new Error("scope `all` cannot be combined with workspace ids");
  }
  if (raw.length > MAX_SCOPE_ENTRIES) {
    throw new Error(`scope allows at most ${MAX_SCOPE_ENTRIES} workspaces`);
  }
  const entries = raw.map((entry): McpScopeEntry => {
    const slash = entry.lastIndexOf("/");
    const connectionId = slash >= 0 ? entry.slice(0, slash) : null;
    const workspaceId = slash >= 0 ? entry.slice(slash + 1) : entry;
    if (
      !WORKSPACE_ID_PATTERN.test(workspaceId) ||
      (connectionId !== null && !CONNECTION_ID_PATTERN.test(connectionId))
    ) {
      throw new Error(`invalid workspace scope entry: ${entry}`);
    }
    return { connectionId, workspaceId };
  });
  return { kind: "workspaces", entries };
}

export function formatScope(scope: McpScope): string {
  if (scope.kind === "all") return "all";
  return scope.entries
    .map((entry) =>
      entry.connectionId
        ? `${entry.connectionId}/${entry.workspaceId}`
        : entry.workspaceId,
    )
    .join(",");
}

export function scopeAllows(
  scope: McpScope,
  connectionId: string,
  workspaceId: string,
  defaultConnectionId: string,
): boolean {
  if (scope.kind === "all") return true;
  return scope.entries.some(
    (entry) =>
      entry.workspaceId === workspaceId &&
      (entry.connectionId ?? defaultConnectionId) === connectionId,
  );
}

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeRecords(raw: unknown): McpTokenRecord[] {
  const tokens =
    raw && typeof raw === "object" && Array.isArray((raw as any).tokens)
      ? ((raw as any).tokens as unknown[])
      : [];
  const records: McpTokenRecord[] = [];
  for (const value of tokens.slice(0, MAX_TOKENS)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      !/^[0-9a-f]{8}$/.test(record.id) ||
      typeof record.name !== "string" ||
      typeof record.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.sha256)
    ) {
      continue;
    }
    const scope =
      record.scope === "all"
        ? "all"
        : Array.isArray(record.scope) &&
            record.scope.every((entry) => typeof entry === "string")
          ? (record.scope as string[])
          : null;
    if (!scope) continue;
    try {
      parseScope(scope);
    } catch {
      continue;
    }
    records.push({
      id: record.id,
      name: record.name,
      sha256: record.sha256,
      scope,
      created_at:
        typeof record.created_at === "string" ? record.created_at : "",
    });
  }
  return records;
}

export type McpTokenStore = ReturnType<typeof createMcpTokenStore>;

export function createMcpTokenStore(
  args: { path?: string; now?: () => Date } = {},
) {
  const path = args.path ?? defaultMcpTokensPath();
  const now = args.now ?? (() => new Date());
  // Revocation takes effect without a restart: reread when the file changes.
  let cache: { key: string; records: McpTokenRecord[] } | null = null;

  function load(): McpTokenRecord[] {
    assertSafeDataPath(path);
    let key: string;
    try {
      const info = statSync(path);
      key = `${info.mtimeMs}:${info.size}:${info.ino}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (cache?.key === key) return cache.records;
    const records = normalizeRecords(JSON.parse(readFileSync(path, "utf8")));
    cache = { key, records };
    return records;
  }

  function save(records: McpTokenRecord[]) {
    assertSafeDataPath(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(
      dirname(path),
      `.mcp-tokens-${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      writeFileSync(
        temporary,
        `${JSON.stringify({ version: 1, tokens: records }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    cache = null;
  }

  return {
    path,
    list(): McpTokenRecord[] {
      return [...load()];
    },
    create(input: { name: string; scope: McpScope }) {
      const name = input.name.trim();
      if (!NAME_PATTERN.test(name)) {
        throw new Error(
          "token name must be 1-64 letters, digits, spaces, dots, dashes, or underscores",
        );
      }
      const records = load();
      if (records.some((record) => record.name === name)) {
        throw new Error(`a token named "${name}" already exists`);
      }
      if (records.length >= MAX_TOKENS) {
        throw new Error(`at most ${MAX_TOKENS} MCP tokens can exist`);
      }
      let id: string;
      do {
        id = randomBytes(4).toString("hex");
      } while (records.some((record) => record.id === id));
      const token = `${TOKEN_PREFIX}${id}_${randomBytes(32).toString("base64url")}`;
      const scope = formatScope(input.scope);
      const record: McpTokenRecord = {
        id,
        name,
        sha256: digest(token),
        scope: scope === "all" ? "all" : scope.split(","),
        created_at: now().toISOString(),
      };
      save([...records, record]);
      return { token, record };
    },
    /** Revoke by id or name. Returns the removed records. */
    revoke(idOrName: string): McpTokenRecord[] {
      const records = load();
      const removed = records.filter(
        (record) => record.id === idOrName || record.name === idOrName,
      );
      if (removed.length) {
        save(records.filter((record) => !removed.includes(record)));
      }
      return removed;
    },
    verify(token: string): McpPrincipal | null {
      const match = TOKEN_PATTERN.exec(token);
      if (!match) return null;
      const record = load().find((candidate) => candidate.id === match[1]);
      if (!record) return null;
      const expected = Buffer.from(record.sha256, "hex");
      const actual = Buffer.from(digest(token), "hex");
      if (!timingSafeEqual(expected, actual)) return null;
      return {
        tokenId: record.id,
        name: record.name,
        scope: parseScope(record.scope),
      };
    },
  };
}
