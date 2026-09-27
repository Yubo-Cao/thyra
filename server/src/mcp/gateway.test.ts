import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMcpReadOperation,
  createMcpConnection,
  MCP_READ_OPERATIONS,
  type ReadableRuntime,
  rpcPolicyClassifier,
} from "./gateway";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fakeRuntime(args: { root?: string; sshHost?: string } = {}) {
  const herdrCalls: Array<{
    method: string;
    params?: Record<string, unknown>;
  }> = [];
  const fileCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const runtime: ReadableRuntime = {
    identity: { id: "legacy-default", label: "Default" },
    sshHost: () => args.sshHost,
    herdr: {
      async call(method, params) {
        herdrCalls.push({ method, params });
        if (method === "pane.read") {
          return {
            read: { text: "\u001b[31mred\u001b[0m done\n", truncated: false },
          };
        }
        return { workspaces: [] };
      },
    },
    collaboration: { call: async () => ({ snapshot: {} }) },
    agentSessions: {
      listWithActivity: async () => ({ agents: [] }),
      readEntries: async (params) => ({ ...params, entries: [] }),
    },
    files: {
      async listWorkspaceFiles(params) {
        fileCalls.push({ fn: "list", params });
        return {
          root: args.root ?? "/repo",
          path: params.path,
          truncated: false,
          entries: [
            {
              name: "link",
              path: "link",
              type: "symlink",
              size: 0,
              mtime_ms: 0,
              hidden: false,
            },
          ],
        };
      },
      async readWorkspaceFile(params) {
        fileCalls.push({ fn: "read", params });
        return {
          root: args.root ?? "/repo",
          path: params.path,
          size: 1,
          mtime_ms: 0,
          truncated: false,
          binary: false,
          text: "x",
        };
      },
      async readGitDiffSummary(params) {
        fileCalls.push({ fn: "diff_summary", params });
        return { entries: [], counts: {} };
      },
      async resolveWorkspaceGitRoot(params) {
        fileCalls.push({ fn: "git_root", params });
        return { root: args.root ?? "/repo" };
      },
      async readGitDiffFile(params) {
        fileCalls.push({ fn: "diff_file", params });
        return { diff: "", truncated: false };
      },
    },
    status: {
      enrichWorkspacesWithGitStatus: async (result) => ({
        ...(result as object),
        enriched: true,
      }),
    },
  };
  return { runtime, herdrCalls, fileCalls };
}

describe("assertMcpReadOperation", () => {
  test("allows only listed read operations", () => {
    for (const operation of Object.keys(MCP_READ_OPERATIONS)) {
      expect(() => assertMcpReadOperation(operation)).not.toThrow();
    }
    for (const operation of [
      "pane.send_input",
      "pane.send_keys",
      "terminal.input",
      "terminal.resize",
      "terminal.focus",
      "file.write",
      "git.pull",
      "launcher.launch",
      "agent.prompt",
      "pane.close",
    ]) {
      expect(() => assertMcpReadOperation(operation)).toThrow(
        "MCP cannot call",
      );
    }
  });

  test("every MCP operation is read-class in the shared RPC policy table", () => {
    for (const operation of Object.keys(MCP_READ_OPERATIONS)) {
      expect(["read", undefined]).toContain(rpcPolicyClassifier(operation));
    }
    // Methods outside the browser table are the documented exceptions.
    expect(
      Object.keys(MCP_READ_OPERATIONS).filter(
        (operation) => rpcPolicyClassifier(operation) === undefined,
      ),
    ).toEqual(["pane.read", "git.status"]);
    expect(rpcPolicyClassifier("pane.send_input")).toBe("write");
    expect(rpcPolicyClassifier("agent.prompt")).toBe("denied");
  });

  test("defers to the shared policy table classification", () => {
    expect(() => assertMcpReadOperation("file.read", () => "write")).toThrow(
      "not a read operation",
    );
    // Methods the browser table does not list keep the MCP classification.
    expect(() =>
      assertMcpReadOperation("pane.read", () => undefined),
    ).not.toThrow();
  });

  test("a connection refuses to run when the policy reclassifies an operation", async () => {
    const { runtime, herdrCalls } = fakeRuntime();
    const connection = createMcpConnection(runtime, {
      isDefault: true,
      classify: (operation) => (operation === "pane.list" ? "admin" : "read"),
    });
    await expect(connection.paneList()).rejects.toThrow("not a read operation");
    expect(herdrCalls).toEqual([]);
  });
});

describe("createMcpConnection", () => {
  test("Herdr calls are fixed read methods", async () => {
    const { runtime, herdrCalls } = fakeRuntime();
    const connection = createMcpConnection(runtime, { isDefault: true });
    expect(await connection.workspaceList()).toMatchObject({ enriched: true });
    await connection.tabList();
    await connection.paneList();
    const read = await connection.paneRead("w1:p1", 25);
    expect(read.text).toBe("red done\n");
    expect(herdrCalls.map((call) => call.method)).toEqual([
      "workspace.list",
      "tab.list",
      "pane.list",
      "pane.read",
    ]);
    // ANSI format avoids Herdr's interactive alternate-screen harvest.
    expect(herdrCalls[3]?.params).toEqual({
      pane_id: "w1:p1",
      source: "recent_unwrapped",
      lines: 25,
      format: "ansi",
    });
  });

  test("file calls never pass filesystem scope or absolute paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "thyra-mcp-gw-"));
    dirs.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x");
    const { runtime, fileCalls } = fakeRuntime({ root });
    const connection = createMcpConnection(runtime, { isDefault: true });
    await connection.fileList("w1", "src");
    await connection.fileRead("w1", "src/a.ts");
    await connection.gitDiffSummary("w1", "working");
    await connection.gitDiffFile("w1", { path: "src/a.ts", mode: "working" });
    for (const call of fileCalls) {
      expect(call.params.scope).toBeUndefined();
      expect(call.params.workspace_id).toBe("w1");
    }
    await expect(connection.fileRead("w1", "../etc/passwd")).rejects.toThrow();
    expect(fileCalls.find((call) => call.fn === "read")?.params.path).toBe(
      "src/a.ts",
    );
    // Leading slashes are stripped to a workspace-relative path.
    const absolute = await connection.fileRead("w1", "/src/a.ts");
    expect(absolute.path).toBe("src/a.ts");
  });

  test("git status reuses the cached status reader for the Git root", async () => {
    const { runtime } = fakeRuntime({ root: "/repo/x" });
    runtime.status.enrichWorkspacesWithGitStatus = async (result: any) => {
      result.workspaces[0].worktree.git_status = { branch: "dev", ahead: 2 };
      return result;
    };
    const connection = createMcpConnection(runtime, { isDefault: true });
    expect(await connection.gitStatus("w1")).toEqual({
      root: "/repo/x",
      branch: "dev",
      ahead: 2,
    });
  });

  test("local symlinks may not escape the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "thyra-mcp-gw-"));
    const outside = mkdtempSync(join(tmpdir(), "thyra-mcp-out-"));
    dirs.push(root, outside);
    writeFileSync(join(outside, "secret.txt"), "s");
    writeFileSync(join(root, ".env"), "KEY=1");
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
    symlinkSync(outside, join(root, "outdir"));
    symlinkSync(join(root, ".env"), join(root, "innocent.txt"));
    const { runtime } = fakeRuntime({ root });
    const connection = createMcpConnection(runtime, { isDefault: true });
    await expect(connection.fileRead("w1", "escape.txt")).rejects.toThrow(
      "outside the workspace",
    );
    await expect(connection.fileList("w1", "outdir")).rejects.toThrow(
      "outside the workspace",
    );
    // An internal link reports its real target for the deny-list check.
    expect((await connection.fileRead("w1", "innocent.txt")).real_path).toBe(
      ".env",
    );
  });

  test("remote connections refuse symlinked path components", async () => {
    const { runtime } = fakeRuntime({ sshHost: "box" });
    const connection = createMcpConnection(runtime, { isDefault: false });
    expect(connection.remote).toBe(true);
    await expect(connection.fileRead("w1", "link/file")).rejects.toThrow(
      "symlinks are not followed",
    );
    await expect(connection.fileList("w1", "link")).rejects.toThrow(
      "symlinks are not followed",
    );
  });
});
