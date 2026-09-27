import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteToolCaller, runMcpCommand } from "./cli";
import { createMcpHttpService, type ToolCaller } from "./server";
import { PLANTED_SECRET, toolContext } from "./test-fixtures";
import { createMcpTokenStore } from "./tokens";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "thyra-mcp-cli-"));
  dirs.push(dir);
  return createMcpTokenStore({ path: join(dir, "thyra", "mcp-tokens.json") });
}

function output() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    deps: {
      log: (message: string) => lines.push(message),
      error: (message: string) => errors.push(message),
    },
  };
}

describe("thyra mcp command", () => {
  test("ignores other commands", async () => {
    expect(await runMcpCommand(["service", "status"], "1")).toBeNull();
    expect(await runMcpCommand([], "1")).toBeNull();
  });

  test("creates, lists, and revokes tokens", async () => {
    const store = tempStore();
    const out = output();
    const deps = { ...out.deps, store: () => store };
    expect(
      await runMcpCommand(
        ["mcp", "token", "create", "--name", "claude", "--scope", "w1,box/w2"],
        "1",
        deps,
      ),
    ).toBe(0);
    const token = out.lines.at(-1) ?? "";
    expect(token).toStartWith("thyra_mcp_");
    expect(store.verify(token)?.name).toBe("claude");

    expect(await runMcpCommand(["mcp", "token", "list"], "1", deps)).toBe(0);
    expect(out.lines.at(-1)).toContain("claude  scope=w1,box/w2");
    expect(out.lines.at(-1)).not.toContain(token);

    expect(
      await runMcpCommand(["mcp", "token", "revoke", "claude"], "1", deps),
    ).toBe(0);
    expect(store.verify(token)).toBeNull();
    expect(
      await runMcpCommand(["mcp", "token", "revoke", "claude"], "1", deps),
    ).toBe(1);
  });

  test("validates token arguments", async () => {
    const store = tempStore();
    const out = output();
    const deps = { ...out.deps, store: () => store };
    expect(
      await runMcpCommand(["mcp", "token", "create", "--name", "x"], "1", deps),
    ).toBe(2);
    expect(
      await runMcpCommand(
        ["mcp", "token", "create", "--name", "x", "--scope", "all,w1"],
        "1",
        deps,
      ),
    ).toBe(1);
    expect(
      await runMcpCommand(["mcp", "token", "create", "--bogus"], "1", deps),
    ).toBe(1);
    expect(store.list()).toEqual([]);
  });

  test("stdio mode requires a token and forwards to the configured URL", async () => {
    const out = output();
    expect(await runMcpCommand(["mcp"], "1", { ...out.deps, env: {} })).toBe(2);
    expect(out.errors.at(-1)).toContain("THYRA_MCP_TOKEN");

    let served: ToolCaller | null = null;
    const requests: Request[] = [];
    const code = await runMcpCommand(["mcp"], "1", {
      ...out.deps,
      env: { THYRA_MCP_TOKEN: "thyra_mcp_x", PORT: "8831" },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "ok" }] },
        });
      }) as typeof fetch,
      serveStdio: async (callTool) => {
        served = callTool;
      },
    });
    expect(code).toBe(0);
    expect(served).not.toBeNull();
    const result = await (served as unknown as ToolCaller)(
      "list_workspaces",
      {},
    );
    expect(result).toEqual({ text: "ok", isError: false });
    expect(requests[0]?.url).toBe("http://127.0.0.1:8831/mcp");
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer thyra_mcp_x",
    );
  });
});

describe("remote tool caller", () => {
  test("round-trips through the HTTP endpoint with auth and redaction", async () => {
    const store = tempStore();
    const { token } = store.create({
      name: "stdio",
      scope: { kind: "all" },
    });
    const service = createMcpHttpService({
      version: "1",
      tokens: store,
      audit: { record() {} },
      context: (principal) => ({ ...toolContext(), principal }),
    });
    const localFetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      service.handle(new Request(input, init), "127.0.0.1")) as typeof fetch;
    const call = createRemoteToolCaller({
      url: "http://127.0.0.1:8831/mcp",
      token,
      fetch: localFetch,
    });
    const result = await call("get_pane_output", { pane_id: "w1:p1" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("ready");
    expect(result.text).not.toContain(PLANTED_SECRET);

    const denied = await createRemoteToolCaller({
      url: "http://127.0.0.1:8831/mcp",
      token: "wrong",
      fetch: localFetch,
    })("list_workspaces", {});
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("HTTP 401");
  });

  test("reports an unreachable server as a tool error", async () => {
    const call = createRemoteToolCaller({
      url: "http://127.0.0.1:1/mcp",
      token: "t",
      fetch: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
    });
    const result = await call("list_workspaces", {});
    expect(result).toEqual({
      text: "Thyra is not reachable at http://127.0.0.1:1/mcp: connection refused",
      isError: true,
    });
  });
});
