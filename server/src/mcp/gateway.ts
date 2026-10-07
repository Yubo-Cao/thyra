import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DENIED_RPC_METHODS, RPC_POLICY } from "../authz/policy";
import { sanitizeExplorerPath } from "../workspace/file-paths";
import type {
  FileListResult,
  FilePreviewResult,
} from "../workspace/file-types";

/**
 * The only operations MCP tools can reach. Each maps to one fixed read call on
 * a connection runtime with an explicit parameter set, so a tool can neither
 * name another method nor smuggle a write parameter (for example
 * `scope: "filesystem"`) through.
 *
 * Every entry is a read-class method in the WebSocket RPC policy table
 * (`server/src/authz/policy.ts`); `pane.read` and the Git status read are not
 * browser methods and are classified here. `assertMcpReadOperation` is the
 * single gate, and the policy table's class wins wherever it lists a method.
 */
export const MCP_READ_OPERATIONS = {
  "workspace.list": "read",
  "tab.list": "read",
  "pane.list": "read",
  "pane.read": "read",
  "agent.list": "read",
  "collaboration.list": "read",
  "file.list": "read",
  "file.read": "read",
  "git.status": "read",
  "git.diff_summary": "read",
  "git.diff_file": "read",
} as const;

export type McpReadOperation = keyof typeof MCP_READ_OPERATIONS;

/** Class of an operation, or undefined when the policy does not list it. */
export type OperationClassifier = (operation: string) => string | undefined;

const localClassifier: OperationClassifier = (operation) =>
  Object.hasOwn(MCP_READ_OPERATIONS, operation)
    ? MCP_READ_OPERATIONS[operation as McpReadOperation]
    : undefined;

/** Classification from the shared WebSocket RPC policy table. */
export const rpcPolicyClassifier: OperationClassifier = (operation) => {
  if (Object.hasOwn(DENIED_RPC_METHODS, operation)) return "denied";
  return Object.hasOwn(RPC_POLICY, operation)
    ? RPC_POLICY[operation]?.class
    : undefined;
};

export function assertMcpReadOperation(
  operation: string,
  classify: OperationClassifier = rpcPolicyClassifier,
): asserts operation is McpReadOperation {
  if (!Object.hasOwn(MCP_READ_OPERATIONS, operation)) {
    throw new Error(`MCP cannot call ${operation}`);
  }
  const operationClass = classify(operation) ?? localClassifier(operation);
  if (operationClass !== "read") {
    throw new Error(`MCP cannot call ${operation}: not a read operation`);
  }
}

export type PaneReadResult = { text: string; truncated: boolean };

/** Read-only view of one Herdr connection, as MCP tools see it. */
export type McpConnection = {
  id: string;
  label: string;
  isDefault: boolean;
  /** True when files live on another host (SSH connection). */
  remote: boolean;
  workspaceList(): Promise<unknown>;
  tabList(): Promise<unknown>;
  paneList(): Promise<unknown>;
  paneRead(paneId: string, lines: number): Promise<PaneReadResult>;
  agentList(): Promise<unknown>;
  collaborationList(): Promise<unknown>;
  fileList(workspaceId: string, path: string): Promise<FileListResult>;
  /** Reads a workspace-relative path that must stay inside the checkout. */
  fileRead(
    workspaceId: string,
    path: string,
  ): Promise<FilePreviewResult & { real_path: string }>;
  gitStatus(workspaceId: string): Promise<GitStatus>;
  gitDiffSummary(
    workspaceId: string,
    mode: "working" | "branch-main",
  ): Promise<GitDiffSummary>;
  gitDiffFile(
    workspaceId: string,
    entry: {
      path: string;
      old_path?: string;
      kind?: string;
      mode: "working" | "branch-main";
    },
  ): Promise<{ diff: string; truncated: boolean }>;
};

export type GitStatus = {
  root: string;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  error?: string;
};

export type GitDiffSummary = {
  root: string;
  mode: string;
  base?: string;
  entries: Array<{
    path: string;
    old_path?: string;
    kind: string;
    status?: string;
    additions?: number;
    deletions?: number;
    generated?: boolean;
  }>;
  counts: Record<string, number>;
};

/** The subset of a connection runtime the gateway is allowed to touch. */
export type ReadableRuntime = {
  identity: { id: string; label: string };
  sshHost: () => string | undefined;
  herdr: {
    call(
      method: string,
      params?: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<any>;
  };
  collaboration: {
    call(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  agentSessions: {
    listWithActivity(params: Record<string, unknown>): Promise<unknown>;
  };
  files: {
    listWorkspaceFiles(params: Record<string, unknown>): Promise<unknown>;
    readWorkspaceFile(params: Record<string, unknown>): Promise<unknown>;
    readGitDiffSummary(params: Record<string, unknown>): Promise<unknown>;
    readGitDiffFile(params: Record<string, unknown>): Promise<unknown>;
    resolveWorkspaceGitRoot(
      params: Record<string, unknown>,
    ): Promise<{ root: string }>;
  };
  status: {
    enrichWorkspacesWithGitStatus(result: unknown): Promise<unknown>;
  };
};

const HERDR_READ_TIMEOUT_MS = 5000;
const MAX_SYMLINK_CHECK_DEPTH = 32;

function inside(root: string, target: string) {
  const path = relative(root, target);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

/** Adapt a connection runtime to the read-only MCP surface. */
export function createMcpConnection(
  runtime: ReadableRuntime,
  args: {
    isDefault: boolean;
    classify?: OperationClassifier;
  },
): McpConnection {
  const gate = (operation: McpReadOperation) =>
    assertMcpReadOperation(operation, args.classify);
  const remote = Boolean(runtime.sshHost());

  async function assertNoSymlinkComponents(workspaceId: string, path: string) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length > MAX_SYMLINK_CHECK_DEPTH) {
      throw new Error("path is too deep");
    }
    for (let index = 0; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      const list = (await runtime.files.listWorkspaceFiles({
        workspace_id: workspaceId,
        path: parent,
        show_hidden: true,
      })) as FileListResult;
      const entry = list.entries.find((item) => item.name === parts[index]);
      if (entry?.type === "symlink") {
        throw new Error("symlinks are not followed on remote connections");
      }
    }
  }

  return {
    id: runtime.identity.id,
    label: runtime.identity.label,
    isDefault: args.isDefault,
    remote,
    async workspaceList() {
      gate("workspace.list");
      const result = await runtime.herdr.call(
        "workspace.list",
        {},
        HERDR_READ_TIMEOUT_MS,
      );
      return runtime.status.enrichWorkspacesWithGitStatus(result);
    },
    async tabList() {
      gate("tab.list");
      return runtime.herdr.call("tab.list", {}, HERDR_READ_TIMEOUT_MS);
    },
    async paneList() {
      gate("pane.list");
      return runtime.herdr.call("pane.list", {}, HERDR_READ_TIMEOUT_MS);
    },
    async paneRead(paneId, lines) {
      gate("pane.read");
      // ANSI format keeps Herdr on its passive snapshot path: a plain-text
      // read of an alternate-screen app may replay wheel input to harvest
      // history, which would be input on the owner's terminal.
      const result = await runtime.herdr.call(
        "pane.read",
        {
          pane_id: paneId,
          source: "recent_unwrapped",
          lines,
          format: "ansi",
        },
        HERDR_READ_TIMEOUT_MS,
      );
      const read = result?.read ?? result;
      return {
        text: Bun.stripANSI(typeof read?.text === "string" ? read.text : ""),
        truncated: read?.truncated === true,
      };
    },
    async agentList() {
      gate("agent.list");
      return runtime.agentSessions.listWithActivity({});
    },
    async collaborationList() {
      gate("collaboration.list");
      return runtime.collaboration.call("collaboration.list", {});
    },
    async fileList(workspaceId, path) {
      gate("file.list");
      const relativePath = sanitizeExplorerPath(path);
      if (remote) await assertNoSymlinkComponents(workspaceId, relativePath);
      const result = (await runtime.files.listWorkspaceFiles({
        workspace_id: workspaceId,
        path: relativePath,
        show_hidden: true,
      })) as FileListResult;
      if (!remote) {
        const rootReal = await realpath(result.root);
        const targetReal = await realpath(resolve(rootReal, relativePath));
        if (!inside(rootReal, targetReal)) {
          throw new Error("path resolves outside the workspace");
        }
      }
      return result;
    },
    async fileRead(workspaceId, path) {
      gate("file.read");
      const relativePath = sanitizeExplorerPath(path);
      if (!relativePath) throw new Error("read_file requires a file path");
      if (remote) await assertNoSymlinkComponents(workspaceId, relativePath);
      const result = (await runtime.files.readWorkspaceFile({
        workspace_id: workspaceId,
        path: relativePath,
      })) as FilePreviewResult;
      let realPath = relativePath;
      if (!remote) {
        // The shared preview reader follows symlinks; MCP stays in the root.
        const rootReal = await realpath(result.root);
        const targetReal = await realpath(resolve(rootReal, relativePath));
        if (!inside(rootReal, targetReal)) {
          throw new Error("path resolves outside the workspace");
        }
        realPath = relative(rootReal, targetReal).split(sep).join("/");
      }
      return { ...result, real_path: realPath };
    },
    async gitStatus(workspaceId) {
      gate("git.status");
      const { root } = await runtime.files.resolveWorkspaceGitRoot({
        workspace_id: workspaceId,
      });
      // Reuse the cached `git status --branch` reader behind workspace.list.
      const enriched = (await runtime.status.enrichWorkspacesWithGitStatus({
        workspaces: [{ worktree: { checkout_path: root } }],
      })) as { workspaces?: Array<{ worktree?: { git_status?: object } }> };
      return {
        root,
        ...(enriched.workspaces?.[0]?.worktree?.git_status ?? {}),
      };
    },
    async gitDiffSummary(workspaceId, mode) {
      gate("git.diff_summary");
      return (await runtime.files.readGitDiffSummary({
        workspace_id: workspaceId,
        mode,
      })) as GitDiffSummary;
    },
    async gitDiffFile(workspaceId, entry) {
      gate("git.diff_file");
      return (await runtime.files.readGitDiffFile({
        workspace_id: workspaceId,
        path: entry.path,
        ...(entry.old_path ? { old_path: entry.old_path } : {}),
        ...(entry.kind ? { kind: entry.kind } : {}),
        mode: entry.mode,
      })) as { diff: string; truncated: boolean };
    },
  };
}
