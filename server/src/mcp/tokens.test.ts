import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMcpTokenStore,
  formatScope,
  parseScope,
  scopeAllows,
} from "./tokens";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), "thyra-mcp-tokens-"));
  dirs.push(dir);
  return createMcpTokenStore({ path: join(dir, "thyra", "mcp-tokens.json") });
}

describe("MCP scopes", () => {
  test("parse and format", () => {
    expect(parseScope("all")).toEqual({ kind: "all" });
    const scope = parseScope("w1, box/w2");
    expect(scope).toEqual({
      kind: "workspaces",
      entries: [
        { connectionId: null, workspaceId: "w1" },
        { connectionId: "box", workspaceId: "w2" },
      ],
    });
    expect(formatScope(scope)).toBe("w1,box/w2");
    for (const bad of ["", "all,w1", "w1:p1", "../w1", "w 1"]) {
      expect(() => parseScope(bad)).toThrow();
    }
  });

  test("unqualified ids match only the default connection", () => {
    const scope = parseScope("w1,box/w2");
    expect(scopeAllows(scope, "legacy-default", "w1", "legacy-default")).toBe(
      true,
    );
    expect(scopeAllows(scope, "box", "w1", "legacy-default")).toBe(false);
    expect(scopeAllows(scope, "box", "w2", "legacy-default")).toBe(true);
    expect(scopeAllows(scope, "legacy-default", "w2", "legacy-default")).toBe(
      false,
    );
    expect(scopeAllows(parseScope("all"), "any", "w9", "legacy-default")).toBe(
      true,
    );
  });
});

describe("MCP token store", () => {
  test("stores only a digest and verifies the plaintext once issued", () => {
    const tokens = store();
    const { token, record } = tokens.create({
      name: "claude",
      scope: parseScope("w1"),
    });
    expect(token).toMatch(/^thyra_mcp_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    const file = readFileSync(tokens.path, "utf8");
    expect(file).not.toContain(token);
    expect(file).not.toContain(token.split("_").at(-1) ?? "");
    expect(statSync(tokens.path).mode & 0o777).toBe(0o600);
    expect(record.scope).toEqual(["w1"]);
    expect(tokens.verify(token)).toEqual({
      tokenId: record.id,
      name: "claude",
      scope: parseScope("w1"),
    });
  });

  test("rejects wrong, malformed, and revoked tokens", () => {
    const tokens = store();
    const { token, record } = tokens.create({
      name: "codex",
      scope: parseScope("all"),
    });
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(tokens.verify(tampered)).toBeNull();
    expect(tokens.verify("not-a-token")).toBeNull();
    expect(tokens.verify("")).toBeNull();
    expect(tokens.revoke("codex").map((item) => item.id)).toEqual([record.id]);
    expect(tokens.verify(token)).toBeNull();
    expect(tokens.list()).toEqual([]);
  });

  test("revocation by another process takes effect without a restart", () => {
    const tokens = store();
    const { token } = tokens.create({ name: "a", scope: parseScope("all") });
    expect(tokens.verify(token)).not.toBeNull();
    // Simulate `thyra mcp token revoke` rewriting the file.
    writeFileSync(
      tokens.path,
      `${JSON.stringify({ version: 1, tokens: [] })}\n`,
    );
    expect(tokens.verify(token)).toBeNull();
  });

  test("names are validated and unique", () => {
    const tokens = store();
    tokens.create({ name: "bot", scope: parseScope("all") });
    expect(() =>
      tokens.create({ name: "bot", scope: parseScope("all") }),
    ).toThrow("already exists");
    expect(() =>
      tokens.create({ name: "bad\nname", scope: parseScope("all") }),
    ).toThrow("token name");
  });

  test("ignores malformed records", () => {
    const tokens = store();
    tokens.create({ name: "ok", scope: parseScope("all") });
    const data = JSON.parse(readFileSync(tokens.path, "utf8"));
    data.tokens.push({ id: "zz", name: "x", sha256: "nope", scope: "all" });
    writeFileSync(tokens.path, JSON.stringify(data));
    expect(tokens.list().map((record) => record.name)).toEqual(["ok"]);
  });
});
