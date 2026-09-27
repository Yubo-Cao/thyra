import { describe, expect, test } from "bun:test";
import { fakeConnection, PLANTED_SECRET, toolContext } from "./test-fixtures";
import { MAX_TOOL_OUTPUT_CHARS, MCP_TOOLS, runMcpTool } from "./tools";

function json(text: string) {
  return JSON.parse(text.split("\n\n")[0] ?? "");
}

function body(text: string) {
  return text.split("\n\n").slice(1).join("\n\n");
}

describe("MCP tools", () => {
  test("every tool is listed once with an object input schema", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      "list_workspaces",
      "get_pane_output",
      "list_agent_sessions",
      "get_agent_session",
      "search_sessions",
      "get_git_status",
      "get_git_diff",
      "read_file",
      "list_files",
      "get_activity",
    ]);
  });

  test("list_workspaces reports panes, branch, and presence", async () => {
    const result = await runMcpTool("list_workspaces", {}, toolContext());
    expect(result.isError).toBe(false);
    const data = json(result.text);
    const [connection] = data.connections;
    expect(connection.connection_id).toBe("legacy-default");
    const alpha = connection.workspaces[0];
    expect(alpha).toMatchObject({
      workspace_id: "w1",
      label: "alpha",
      branch: "main",
      cwd: "/repo/alpha",
      git: { ahead: 1, dirty: true },
    });
    expect(alpha.tabs[0].panes[0]).toMatchObject({
      pane_id: "w1:p1",
      agent: "claude",
      agent_status: "working",
      viewers: ["Ada"],
      controlled_by: "Ada",
    });
    expect(connection.workspaces[1].viewers).toEqual(["Bo"]);
    // w2 has no Herdr Git metadata; its branch comes from a status read.
    expect(connection.workspaces[1].branch).toBe("main");
    // Herdr metadata tokens are not echoed.
    expect(result.text).not.toContain("12k");
  });

  test("list_workspaces hides workspaces outside the token scope", async () => {
    const result = await runMcpTool(
      "list_workspaces",
      {},
      toolContext({ scope: "w1" }),
    );
    const workspaces = json(result.text).connections[0].workspaces;
    expect(
      workspaces.map((w: { workspace_id: string }) => w.workspace_id),
    ).toEqual(["w1"]);
    expect(result.text).not.toContain("beta");
    expect(result.text).not.toContain("w2:p1");
  });

  test("a scope naming another connection sees nothing on the default", async () => {
    const result = await runMcpTool(
      "list_workspaces",
      {},
      toolContext({ scope: "remote-box/w1" }),
    );
    expect(json(result.text).connections).toEqual([]);
  });

  test("get_pane_output returns plain text with secrets redacted", async () => {
    const calls: string[] = [];
    const ctx = toolContext({ connections: [fakeConnection({ calls })] });
    const result = await runMcpTool(
      "get_pane_output",
      { pane_id: "w1:p1", lines: 50 },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(json(result.text)).toMatchObject({
      pane_id: "w1:p1",
      workspace_id: "w1",
      agent: "claude",
    });
    expect(body(result.text)).toContain("ready");
    expect(result.text).not.toContain(PLANTED_SECRET);
    expect(result.text).not.toContain("q".repeat(40));
    expect(result.text).toContain("OPENAI_API_KEY=[REDACTED");
    expect(calls).toContain("pane.read:w1:p1:50");
  });

  test("get_pane_output caps lines and rejects out-of-scope panes", async () => {
    const tooMany = await runMcpTool(
      "get_pane_output",
      { pane_id: "w1:p1", lines: 5000 },
      toolContext(),
    );
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toContain("invalid arguments");

    const calls: string[] = [];
    const denied = await runMcpTool(
      "get_pane_output",
      { pane_id: "w2:p1" },
      toolContext({ scope: "w1", connections: [fakeConnection({ calls })] }),
    );
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("not in this token's scope");
    expect(calls.some((call) => call.startsWith("pane.read"))).toBe(false);
  });

  test("list_agent_sessions sorts by activity and paginates", async () => {
    const result = await runMcpTool(
      "list_agent_sessions",
      { limit: 1 },
      toolContext(),
    );
    const data = json(result.text);
    expect(data.total).toBe(2);
    expect(data.sessions[0]).toMatchObject({
      pane_id: "w2:p1",
      agent: "codex",
    });
    expect(data.next_offset).toBe(1);

    const scoped = json(
      (
        await runMcpTool(
          "list_agent_sessions",
          {},
          toolContext({ scope: "w1" }),
        )
      ).text,
    );
    expect(scoped.sessions.map((s: { pane_id: string }) => s.pane_id)).toEqual([
      "w1:p1",
    ]);
  });

  test("get_agent_session returns clipped entries with paging", async () => {
    const result = await runMcpTool(
      "get_agent_session",
      { pane_id: "w1:p1", limit: 2, max_chars_per_entry: 100 },
      toolContext(),
    );
    const data = json(result.text);
    expect(data.total_entries).toBe(4);
    expect(data.entries.map((entry: { id: string }) => entry.id)).toEqual([
      "e3",
      "e4",
    ]);
    expect(data.next_before).toBe(2);
    expect(result.text).not.toContain(PLANTED_SECRET);

    const older = json(
      (
        await runMcpTool(
          "get_agent_session",
          { pane_id: "w1:p1", limit: 2, before: 2 },
          toolContext(),
        )
      ).text,
    );
    expect(older.entries.map((entry: { id: string }) => entry.id)).toEqual([
      "e1",
      "e2",
    ]);
    expect(older.next_before).toBeUndefined();

    const noTools = json(
      (
        await runMcpTool(
          "get_agent_session",
          { pane_id: "w1:p1", include_tools: false },
          toolContext(),
        )
      ).text,
    );
    expect(noTools.entries.map((entry: { id: string }) => entry.id)).toEqual([
      "e1",
      "e4",
    ]);
  });

  test("search_sessions finds matches within scope only", async () => {
    const all = json(
      (await runMcpTool("search_sessions", { query: "LOGIN" }, toolContext()))
        .text,
    );
    expect(all.total_matches).toBe(3);
    expect(all.matches[0]).toMatchObject({ pane_id: "w2:p1", entry_id: "x1" });

    const scoped = json(
      (
        await runMcpTool(
          "search_sessions",
          { query: "login" },
          toolContext({ scope: "w1" }),
        )
      ).text,
    );
    expect(scoped.matches.map((m: { pane_id: string }) => m.pane_id)).toEqual([
      "w1:p1",
      "w1:p1",
    ]);
    expect(JSON.stringify(scoped)).not.toContain("beta secret plan");
  });

  test("search_sessions only searches tool output when asked", async () => {
    const without = json(
      (await runMcpTool("search_sessions", { query: "12 pass" }, toolContext()))
        .text,
    );
    expect(without.total_matches).toBe(0);
    const withTools = await runMcpTool(
      "search_sessions",
      { query: "12 pass", include_tools: true },
      toolContext(),
    );
    expect(json(withTools.text).total_matches).toBe(1);
    expect(withTools.text).not.toContain(PLANTED_SECRET);
  });

  test("get_git_status lists branch and changed files", async () => {
    const data = json(
      (
        await runMcpTool(
          "get_git_status",
          { workspace_id: "w1" },
          toolContext(),
        )
      ).text,
    );
    expect(data).toMatchObject({
      branch: "main",
      ahead: 1,
      root: "/repo/alpha",
    });
    expect(data.files.map((file: { path: string }) => file.path)).toEqual([
      "src/app.ts",
      ".env",
      "notes.md",
    ]);
  });

  test("get_git_diff withholds denied files and honours the byte budget", async () => {
    const calls: string[] = [];
    const ctx = toolContext({ connections: [fakeConnection({ calls })] });
    const result = await runMcpTool(
      "get_git_diff",
      { workspace_id: "w1" },
      ctx,
    );
    const data = json(result.text);
    expect(data.withheld_by_policy).toEqual([".env"]);
    expect(data.files).toBe(2);
    expect(body(result.text)).toContain("+changed src/app.ts");
    expect(calls).not.toContain("git.diff_file:w1:.env");

    const denied = await runMcpTool(
      "get_git_diff",
      { workspace_id: "w1", path: ".env" },
      ctx,
    );
    expect(denied.isError).toBe(true);

    const small = await runMcpTool(
      "get_git_diff",
      { workspace_id: "w1", max_bytes: 1024 },
      toolContext({
        connections: [
          fakeConnection({
            async gitDiffFile() {
              return { diff: "x".repeat(4000), truncated: false };
            },
          }),
        ],
      }),
    );
    expect(json(small.text).truncated).toBe(true);
    expect(body(small.text).length).toBeLessThan(1200);
  });

  test("read_file pages lines and redacts secrets", async () => {
    const result = await runMcpTool(
      "read_file",
      { workspace_id: "w1", path: "src/app.ts", start_line: 2, max_lines: 2 },
      toolContext(),
    );
    const data = json(result.text);
    expect(data).toMatchObject({
      start_line: 2,
      end_line: 3,
      next_start_line: 4,
    });
    expect(body(result.text)).toStartWith("line 2\n");
    expect(result.text).not.toContain(PLANTED_SECRET);
  });

  test("read_file denies secret paths before touching the connection", async () => {
    for (const path of [
      ".env",
      ".env.local",
      "config/.env.production",
      "certs/server.pem",
      "deploy/tls.key",
      ".ssh/id_ed25519",
      "keys/id_rsa",
      ".aws/credentials",
      "secrets/credentials.json",
      ".git/config",
    ]) {
      const calls: string[] = [];
      const result = await runMcpTool(
        "read_file",
        { workspace_id: "w1", path },
        toolContext({ connections: [fakeConnection({ calls })] }),
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain("denied by the MCP file policy");
      expect(calls.filter((call) => call.startsWith("file.read"))).toEqual([]);
    }
  });

  test("read_file denies a symlink that resolves to a secret", async () => {
    const result = await runMcpTool(
      "read_file",
      { workspace_id: "w1", path: "notes.txt" },
      toolContext({
        connections: [
          fakeConnection({
            async fileRead() {
              return {
                root: "/repo/alpha",
                path: "notes.txt",
                real_path: ".env",
                size: 1,
                mtime_ms: 0,
                truncated: false,
                binary: false,
                text: `KEY=${PLANTED_SECRET}`,
              };
            },
          }),
        ],
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(PLANTED_SECRET);
  });

  test("configured deny patterns extend the defaults", async () => {
    const result = await runMcpTool(
      "read_file",
      { workspace_id: "w1", path: "data/app.sqlite" },
      toolContext({ denyFiles: ["*.sqlite"] }),
    );
    expect(result.isError).toBe(true);
  });

  test("file tools reject workspaces outside the scope", async () => {
    for (const [tool, args] of [
      ["read_file", { workspace_id: "w2", path: "README.md" }],
      ["list_files", { workspace_id: "w2" }],
      ["get_git_status", { workspace_id: "w2" }],
      ["get_git_diff", { workspace_id: "w2" }],
    ] as const) {
      const calls: string[] = [];
      const result = await runMcpTool(
        tool,
        args,
        toolContext({ scope: "w1", connections: [fakeConnection({ calls })] }),
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not in this token's scope");
      expect(calls).toEqual([]);
    }
  });

  test("list_files marks denied entries and refuses denied directories", async () => {
    const data = json(
      (await runMcpTool("list_files", { workspace_id: "w1" }, toolContext()))
        .text,
    );
    const denied = data.entries
      .filter((entry: { denied?: boolean }) => entry.denied)
      .map((entry: { name: string }) => entry.name);
    expect(denied).toEqual([".env", "server.pem"]);
    const page = json(
      (
        await runMcpTool(
          "list_files",
          { workspace_id: "w1", limit: 1, offset: 1 },
          toolContext(),
        )
      ).text,
    );
    expect(page.entries.map((entry: { name: string }) => entry.name)).toEqual([
      "src",
    ]);
    expect(page.next_offset).toBe(2);

    const sshDir = await runMcpTool(
      "list_files",
      { workspace_id: "w1", path: ".ssh" },
      toolContext(),
    );
    expect(sshDir.isError).toBe(true);
  });

  test("get_activity reports active agents, viewers, and scoped events", async () => {
    const ctx = toolContext({
      scope: "w1",
      activity: [
        {
          at: "2026-09-27T11:59:00.000Z",
          connection_id: "legacy-default",
          type: "agent_completed",
          workspace_id: "w1",
          pane_id: "w1:p1",
          agent: "claude",
        },
        {
          at: "2026-09-27T11:59:30.000Z",
          connection_id: "legacy-default",
          type: "pane_exited",
          pane_id: "w2:p1",
        },
        {
          at: "2026-09-27T11:59:40.000Z",
          connection_id: "legacy-default",
          type: "pane_created",
          pane_id: "w1:p9",
        },
      ],
    });
    const data = json((await runMcpTool("get_activity", {}, ctx)).text);
    expect(
      data.active_agents.map((a: { pane_id: string }) => a.pane_id),
    ).toEqual(["w1:p1"]);
    expect(data.viewers.map((v: { name: string }) => v.name)).toEqual(["Ada"]);
    expect(data.recent_events.map((e: { type: string }) => e.type)).toEqual([
      "pane_created",
      "agent_completed",
    ]);
  });

  test("unknown tools and invalid arguments are errors", async () => {
    expect(
      (await runMcpTool("pane_send_input", {}, toolContext())).isError,
    ).toBe(true);
    const invalid = await runMcpTool("read_file", { path: 3 }, toolContext());
    expect(invalid.isError).toBe(true);
  });

  test("output is capped", async () => {
    const result = await runMcpTool(
      "get_pane_output",
      { pane_id: "w1:p1" },
      toolContext({
        connections: [
          fakeConnection({
            async paneRead() {
              return {
                text: "y".repeat(MAX_TOOL_OUTPUT_CHARS * 2),
                truncated: false,
              };
            },
          }),
        ],
      }),
    );
    expect(result.text.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 200);
    expect(result.text).toContain("[output truncated");
  });

  test("errors are redacted", async () => {
    const result = await runMcpTool(
      "list_workspaces",
      {},
      toolContext({
        connections: [
          fakeConnection({
            async workspaceList() {
              throw new Error(`boom ${PLANTED_SECRET}`);
            },
          }),
        ],
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(PLANTED_SECRET);
  });
});
