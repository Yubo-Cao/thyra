import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpAuditLog, type McpAuditEntry } from "./audit";
import { createMcpHttpService, MCP_TRANSPORT_HEADER } from "./server";
import { PLANTED_SECRET, toolContext } from "./test-fixtures";
import { createMcpTokenStore, parseScope } from "./tokens";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { rateLimitPerMinute?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "thyra-mcp-http-"));
  dirs.push(dir);
  const tokens = createMcpTokenStore({
    path: join(dir, "t", "mcp-tokens.json"),
  });
  const audited: McpAuditEntry[] = [];
  const service = createMcpHttpService({
    version: "0.0.0-test",
    tokens,
    audit: { record: (entry) => audited.push(entry) },
    context: (principal) => ({ ...toolContext(), principal }),
    rateLimitPerMinute: options.rateLimitPerMinute,
  });
  const all = tokens.create({ name: "all", scope: parseScope("all") }).token;
  const w1 = tokens.create({ name: "w1-only", scope: parseScope("w1") }).token;
  return { service, tokens, audited, all, w1 };
}

let nextId = 1;
function rpc(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return new Request("http://127.0.0.1:8831/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

async function payload(response: Response): Promise<any> {
  const text = await response.text();
  if ((response.headers.get("content-type") ?? "").includes("event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .at(-1);
    return JSON.parse(data?.slice(5) ?? "null");
  }
  return JSON.parse(text);
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("MCP HTTP endpoint", () => {
  test("requires a bearer token and ignores the login cookie", async () => {
    const { service, audited } = setup();
    const missing = await service.handle(rpc("tools/list"), "10.0.0.1");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    const cookie = await service.handle(
      rpc("tools/list", {}, { cookie: "herdr_auth=anything" }),
      "10.0.0.1",
    );
    expect(cookie.status).toBe(401);
    const wrong = await service.handle(
      rpc("tools/list", {}, bearer(`thyra_mcp_00000000_${"A".repeat(43)}`)),
      "10.0.0.1",
    );
    expect(wrong.status).toBe(401);
    expect(audited.map((entry) => entry.status)).toEqual([
      "unauthorized",
      "unauthorized",
      "unauthorized",
    ]);
    expect(JSON.stringify(audited)).not.toContain("A".repeat(43));
  });

  test("rejects cross-origin browser requests", async () => {
    const { service, all } = setup();
    const response = await service.handle(
      rpc("tools/list", {}, { ...bearer(all), origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
  });

  test("initializes and lists read-only tools", async () => {
    const { service, all } = setup();
    const init = await payload(
      await service.handle(
        rpc(
          "initialize",
          {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
          bearer(all),
        ),
      ),
    );
    expect(init.result.serverInfo.name).toBe("thyra");
    expect(init.result.instructions).toContain("Read-only");
    const list = await payload(
      await service.handle(rpc("tools/list", {}, bearer(all))),
    );
    const tools = list.result.tools as Array<{
      name: string;
      annotations: Record<string, boolean>;
    }>;
    expect(tools).toHaveLength(10);
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.name).not.toMatch(/send|write|input|exec|run|resize|focus/);
    }
  });

  test("calls tools with redaction and audits the call", async () => {
    const { service, all, audited } = setup();
    const response = await service.handle(
      rpc(
        "tools/call",
        { name: "get_pane_output", arguments: { pane_id: "w1:p1" } },
        { ...bearer(all), [MCP_TRANSPORT_HEADER]: "stdio" },
      ),
      "127.0.0.1",
    );
    expect(response.status).toBe(200);
    const result = (await payload(response)).result;
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toContain("ready");
    expect(text).not.toContain(PLANTED_SECRET);
    const entry = audited.at(-1);
    expect(entry).toMatchObject({
      token_name: "all",
      transport: "stdio",
      remote: "127.0.0.1",
      method: "tools/call",
      tool: "get_pane_output",
      status: "ok",
    });
    expect(entry?.args).toContain("w1:p1");
    expect(entry?.bytes).toBeGreaterThan(0);
  });

  test("a token scoped to one workspace cannot read another", async () => {
    const { service, w1, audited } = setup();
    const denied = (
      await payload(
        await service.handle(
          rpc(
            "tools/call",
            { name: "get_pane_output", arguments: { pane_id: "w2:p1" } },
            bearer(w1),
          ),
        ),
      )
    ).result;
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("not in this token's scope");
    expect(audited.at(-1)).toMatchObject({
      token_name: "w1-only",
      status: "error",
    });

    const listed = (
      await payload(
        await service.handle(
          rpc(
            "tools/call",
            { name: "list_workspaces", arguments: {} },
            bearer(w1),
          ),
        ),
      )
    ).result.content[0].text as string;
    expect(listed).toContain('"w1"');
    expect(listed).not.toContain('"w2"');
  });

  test("rate limits each token", async () => {
    const { service, all, w1 } = setup({ rateLimitPerMinute: 20 });
    const statuses: number[] = [];
    for (let index = 0; index < 12; index++) {
      statuses.push(
        (await service.handle(rpc("tools/list", {}, bearer(all)))).status,
      );
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    const limited = await service.handle(rpc("tools/list", {}, bearer(all)));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Buckets are per token.
    expect(
      (await service.handle(rpc("tools/list", {}, bearer(w1)))).status,
    ).toBe(200);
  });

  test("limits repeated failed authentication per address", async () => {
    const { service } = setup();
    const statuses: number[] = [];
    for (let index = 0; index < 12; index++) {
      statuses.push(
        (
          await service.handle(
            rpc("tools/list", {}, bearer("nope")),
            "10.9.9.9",
          )
        ).status,
      );
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  test("rejects oversized bodies", async () => {
    const { service, all } = setup();
    const response = await service.handle(
      new Request("http://127.0.0.1:8831/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer(all) },
        body: `{"x":"${"a".repeat(300 * 1024)}"}`,
      }),
    );
    expect(response.status).toBe(413);
  });
});

describe("MCP audit log", () => {
  test("appends redacted JSON lines and rotates", () => {
    const dir = mkdtempSync(join(tmpdir(), "thyra-mcp-audit-"));
    dirs.push(dir);
    const path = join(dir, "thyra", "mcp-audit.jsonl");
    const log = createMcpAuditLog({ path, maxBytes: 600 });
    const entry: McpAuditEntry = {
      ts: "2026-09-27T12:00:00.000Z",
      token_id: "abcd1234",
      token_name: "claude",
      transport: "http",
      remote: "127.0.0.1",
      method: "tools/call",
      tool: "read_file",
      args: '{"path":"README.md"}',
      status: "error",
      detail: `failed with ${PLANTED_SECRET}`,
      duration_ms: 3,
    };
    log.record(entry);
    const first = readFileSync(path, "utf8");
    expect(first).not.toContain(PLANTED_SECRET);
    expect(JSON.parse(first.trim())).toMatchObject({
      token_name: "claude",
      tool: "read_file",
    });
    for (let index = 0; index < 5; index++) log.record(entry);
    expect(readFileSync(`${path}.1`, "utf8").length).toBeGreaterThan(0);
    expect(readFileSync(path, "utf8").length).toBeLessThanOrEqual(600);
  });
});
