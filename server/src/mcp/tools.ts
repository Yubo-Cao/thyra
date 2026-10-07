import * as z from "zod/v4";
import type { McpActivityEvent } from "./activity";
import type { FilePolicy } from "./file-policy";
import type { McpConnection } from "./gateway";
import { redactDeep, redactText } from "./redact";
import { type McpPrincipal, scopeAllows } from "./tokens";

/**
 * Read-only MCP tools over Thyra's live workspace state. Handlers receive a
 * `McpToolContext` whose connections expose only read operations (see
 * `gateway.ts`); every result is redacted and capped by `runMcpTool`.
 */

export const MAX_TOOL_OUTPUT_CHARS = 100_000;

export type McpToolContext = {
  principal: McpPrincipal;
  connections(): McpConnection[];
  defaultConnectionId(): string;
  activity(): McpActivityEvent[];
  filePolicy: FilePolicy;
  now?: () => number;
};

/** A handler result: compact JSON metadata plus an optional raw text body. */
export type ToolOutput = { data: unknown; body?: string };

type ToolDefinition<Schema extends z.ZodObject> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  handler(ctx: McpToolContext, args: z.infer<Schema>): Promise<ToolOutput>;
};

function defineTool<Schema extends z.ZodObject>(
  definition: ToolDefinition<Schema>,
) {
  return definition;
}

export class McpToolError extends Error {}

const notFound = (kind: string, id: string) =>
  new McpToolError(`${kind} not found or not in this token's scope: ${id}`);

// ---------------------------------------------------------------------------
// Shared helpers

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function list(value: unknown, key: string): Rec[] {
  const items = isRecord(value) ? value[key] : undefined;
  return Array.isArray(items) ? items.filter(isRecord) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Workspace owning a Herdr id such as `w1`, `w1:t2`, or `w1:p3`. */
function workspaceOfId(id: string | undefined): string | undefined {
  return id?.split(":")[0] || undefined;
}

function connectionsFor(ctx: McpToolContext, connectionId?: string) {
  const all = ctx.connections();
  if (!connectionId) return all;
  const match = all.find((connection) => connection.id === connectionId);
  if (!match) throw notFound("connection", connectionId);
  return [match];
}

function singleConnection(ctx: McpToolContext, connectionId?: string) {
  const id = connectionId ?? ctx.defaultConnectionId();
  const match = ctx.connections().find((connection) => connection.id === id);
  if (!match) {
    throw new McpToolError(
      connectionId
        ? `connection not found or not ready: ${connectionId}`
        : "the default Herdr connection is not ready",
    );
  }
  return match;
}

function inScope(
  ctx: McpToolContext,
  connection: McpConnection,
  workspaceId: string | undefined,
) {
  return (
    workspaceId !== undefined &&
    scopeAllows(
      ctx.principal.scope,
      connection.id,
      workspaceId,
      ctx.defaultConnectionId(),
    )
  );
}

function assertWorkspace(
  ctx: McpToolContext,
  connection: McpConnection,
  workspaceId: string,
) {
  if (!inScope(ctx, connection, workspaceId)) {
    throw notFound("workspace", workspaceId);
  }
}

async function findPane(
  ctx: McpToolContext,
  connection: McpConnection,
  paneId: string,
) {
  const pane = list(await connection.paneList(), "panes").find(
    (candidate) => candidate.pane_id === paneId,
  );
  if (!pane || !inScope(ctx, connection, str(pane.workspace_id))) {
    throw notFound("pane", paneId);
  }
  return pane;
}

function deny(ctx: McpToolContext, path: string) {
  const pattern = ctx.filePolicy.deniedBy(path);
  if (pattern) {
    throw new McpToolError(
      `access to ${path} is denied by the MCP file policy (${pattern})`,
    );
  }
}

const connectionIdField = z
  .string()
  .max(128)
  .optional()
  .describe(
    "Connection id from list_workspaces; defaults to the default connection.",
  );
const workspaceIdField = z
  .string()
  .min(1)
  .max(128)
  .describe("Workspace id from list_workspaces, for example w1.");
const paneIdField = z
  .string()
  .min(1)
  .max(160)
  .describe("Pane id from list_workspaces, for example w1:p2.");

function agentSummary(agent: Rec) {
  const session = isRecord(agent.agent_session) ? agent.agent_session : null;
  const lastActivity = num(agent.last_activity_at);
  return {
    pane_id: str(agent.pane_id),
    workspace_id: str(agent.workspace_id),
    tab_id: str(agent.tab_id),
    agent: str(agent.display_agent) ?? str(agent.agent) ?? str(agent.name),
    status: str(agent.agent_status),
    title: str(agent.terminal_title_stripped) ?? str(agent.title),
    focused: agent.focused === true || undefined,
    session: session
      ? {
          source: str(session.source),
          kind: str(session.kind),
          id: str(session.value),
        }
      : undefined,
    last_activity_at: lastActivity
      ? new Date(lastActivity).toISOString()
      : undefined,
  };
}

async function scopedAgents(
  ctx: McpToolContext,
  connection: McpConnection,
  workspaceId?: string,
) {
  const agents = list(await connection.agentList(), "agents").filter(
    (agent) =>
      inScope(ctx, connection, str(agent.workspace_id)) &&
      (!workspaceId || agent.workspace_id === workspaceId),
  );
  return agents
    .map((agent) => ({ connection_id: connection.id, ...agentSummary(agent) }))
    .sort(
      (a, b) =>
        (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "") ||
        String(a.pane_id).localeCompare(String(b.pane_id)),
    );
}

// ---------------------------------------------------------------------------
// Tools

const MAX_WORKSPACES = 100;
const MAX_PANES_PER_WORKSPACE = 50;
const MAX_GIT_FALLBACKS = 20;

const listWorkspaces = defineTool({
  name: "list_workspaces",
  title: "List workspaces",
  description:
    "List Herdr workspaces with their tabs and panes: agent kind and status, working directory, Git branch, and which Thyra participants are viewing or controlling each pane. Start here to find workspace and pane ids.",
  inputSchema: z.object({
    connection_id: connectionIdField,
    include_panes: z
      .boolean()
      .default(true)
      .describe("Include tabs and panes (default true)."),
  }),
  async handler(ctx, args) {
    const connections = [];
    let truncated = false;
    for (const connection of connectionsFor(ctx, args.connection_id)) {
      const [workspaces, tabs, panes, presence] = await Promise.all([
        connection.workspaceList(),
        args.include_panes ? connection.tabList() : null,
        args.include_panes ? connection.paneList() : null,
        args.include_panes
          ? connection.collaborationList().catch(() => null)
          : null,
      ]);
      const snapshot = isRecord(presence)
        ? isRecord(presence.snapshot)
          ? presence.snapshot
          : presence
        : null;
      const participants = list(snapshot, "participants");
      const names = new Map(
        participants.map((participant) => [
          str(participant.participant_id),
          str(participant.display_name) ?? "participant",
        ]),
      );
      const controllers = new Map(
        list(snapshot, "pane_claims").map((claim) => [
          str(claim.pane_id),
          names.get(str(claim.participant_id)) ?? "participant",
        ]),
      );
      const scoped = list(workspaces, "workspaces").filter((workspace) =>
        inScope(ctx, connection, str(workspace.workspace_id)),
      );
      if (scoped.length > MAX_WORKSPACES) truncated = true;
      const allPanes = list(panes, "panes");
      const allTabs = list(tabs, "tabs");
      // Herdr only attaches Git metadata to some workspaces; read the rest.
      const fallbackGit = new Map<string, Rec>();
      await Promise.all(
        scoped
          .slice(0, MAX_WORKSPACES)
          .filter(
            (workspace) =>
              !isRecord(
                isRecord(workspace.worktree)
                  ? workspace.worktree.git_status
                  : null,
              ),
          )
          .slice(0, MAX_GIT_FALLBACKS)
          .map(async (workspace) => {
            const workspaceId = str(workspace.workspace_id);
            if (!workspaceId) return;
            const status = await connection
              .gitStatus(workspaceId)
              .catch(() => null);
            if (status && !status.error) fallbackGit.set(workspaceId, status);
          }),
      );
      connections.push({
        connection_id: connection.id,
        label: connection.label,
        default: connection.isDefault || undefined,
        workspaces: scoped.slice(0, MAX_WORKSPACES).map((workspace) => {
          const workspaceId = str(workspace.workspace_id);
          const worktree = isRecord(workspace.worktree)
            ? workspace.worktree
            : null;
          const git = isRecord(worktree?.git_status)
            ? worktree.git_status
            : (fallbackGit.get(workspaceId ?? "") ?? null);
          const workspacePanes = allPanes.filter(
            (pane) => pane.workspace_id === workspaceId,
          );
          if (workspacePanes.length > MAX_PANES_PER_WORKSPACE) truncated = true;
          const focusedPane =
            workspacePanes.find((pane) => pane.focused === true) ??
            workspacePanes[0];
          return {
            workspace_id: workspaceId,
            label: str(workspace.label),
            focused: workspace.focused === true || undefined,
            agent_status: str(workspace.agent_status),
            cwd:
              str(worktree?.checkout_path) ??
              str(focusedPane?.cwd) ??
              str(focusedPane?.foreground_cwd),
            repo: str(worktree?.repo_name),
            branch: str(git?.branch),
            git: git
              ? {
                  ahead: num(git.ahead),
                  behind: num(git.behind),
                  staged: num(git.staged),
                  unstaged: num(git.unstaged),
                  untracked: num(git.untracked),
                  dirty: git.dirty === true,
                }
              : undefined,
            viewers: participants
              .filter(
                (participant) =>
                  participant.workspace_id === workspaceId &&
                  !participant.pane_id,
              )
              .map((participant) => str(participant.display_name)),
            tabs: args.include_panes
              ? allTabs
                  .filter((tab) => tab.workspace_id === workspaceId)
                  .map((tab) => ({
                    tab_id: str(tab.tab_id),
                    label: str(tab.label),
                    focused: tab.focused === true || undefined,
                    panes: workspacePanes
                      .filter((pane) => pane.tab_id === tab.tab_id)
                      .slice(0, MAX_PANES_PER_WORKSPACE)
                      .map((pane) => {
                        const paneId = str(pane.pane_id);
                        const viewers = participants
                          .filter(
                            (participant) => participant.pane_id === paneId,
                          )
                          .map((participant) => str(participant.display_name));
                        return {
                          pane_id: paneId,
                          focused: pane.focused === true || undefined,
                          agent: str(pane.display_agent) ?? str(pane.agent),
                          agent_status: str(pane.agent_status),
                          title:
                            str(pane.label) ??
                            str(pane.terminal_title_stripped) ??
                            str(pane.title),
                          cwd: str(pane.foreground_cwd) ?? str(pane.cwd),
                          viewers: viewers.length ? viewers : undefined,
                          controlled_by: controllers.get(paneId),
                        };
                      }),
                  }))
              : undefined,
          };
        }),
      });
    }
    return {
      data: {
        connections: connections.filter(
          (connection) =>
            ctx.principal.scope.kind === "all" ||
            connection.workspaces.length > 0,
        ),
        ...(truncated ? { truncated: true } : {}),
      },
    };
  },
});

const getPaneOutput = defineTool({
  name: "get_pane_output",
  title: "Get pane output",
  description:
    "Read the most recent terminal lines of a pane as plain text (ANSI stripped, wrapped lines joined). Read-only: never sends input.",
  inputSchema: z.object({
    pane_id: paneIdField,
    connection_id: connectionIdField,
    lines: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(200)
      .describe(
        "Number of recent lines, 1-1000 (Herdr scrollback limit applies).",
      ),
  }),
  async handler(ctx, args) {
    const connection = singleConnection(ctx, args.connection_id);
    const pane = await findPane(ctx, connection, args.pane_id);
    const read = await connection.paneRead(args.pane_id, args.lines);
    const text = read.text.replace(/\s+$/g, "");
    return {
      data: {
        connection_id: connection.id,
        pane_id: args.pane_id,
        workspace_id: str(pane.workspace_id),
        agent: str(pane.display_agent) ?? str(pane.agent),
        agent_status: str(pane.agent_status),
        lines: text ? text.split("\n").length : 0,
        ...(read.truncated ? { truncated: true } : {}),
      },
      body: text,
    };
  },
});

const listAgentSessions = defineTool({
  name: "list_agent_sessions",
  title: "List agent sessions",
  description:
    "List coding-agent panes (Claude Code, Codex, pi, and others) with status and session identity, most recently active first.",
  inputSchema: z.object({
    connection_id: connectionIdField,
    workspace_id: workspaceIdField.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  }),
  async handler(ctx, args) {
    const agents = [];
    for (const connection of connectionsFor(ctx, args.connection_id)) {
      if (args.workspace_id)
        assertWorkspace(ctx, connection, args.workspace_id);
      agents.push(...(await scopedAgents(ctx, connection, args.workspace_id)));
    }
    const page = agents.slice(args.offset, args.offset + args.limit);
    return {
      data: {
        total: agents.length,
        sessions: page,
        ...(args.offset + page.length < agents.length
          ? { next_offset: args.offset + page.length }
          : {}),
      },
    };
  },
});

const MAX_STATUS_ENTRIES = 300;

const getGitStatus = defineTool({
  name: "get_git_status",
  title: "Get Git status",
  description:
    "Branch, upstream tracking, and changed files (staged, unstaged, untracked, conflicted) with line counts for a workspace checkout.",
  inputSchema: z.object({
    workspace_id: workspaceIdField,
    connection_id: connectionIdField,
  }),
  async handler(ctx, args) {
    const connection = singleConnection(ctx, args.connection_id);
    assertWorkspace(ctx, connection, args.workspace_id);
    const [git, summary] = await Promise.all([
      connection.gitStatus(args.workspace_id),
      connection.gitDiffSummary(args.workspace_id, "working"),
    ]);
    return {
      data: {
        connection_id: connection.id,
        workspace_id: args.workspace_id,
        root: summary.root,
        branch: git.branch,
        upstream: git.upstream,
        ahead: git.ahead,
        behind: git.behind,
        counts: summary.counts,
        files: summary.entries.slice(0, MAX_STATUS_ENTRIES).map((entry) => ({
          path: entry.path,
          ...(entry.old_path ? { old_path: entry.old_path } : {}),
          kind: entry.kind,
          status: entry.status,
          additions: entry.additions,
          deletions: entry.deletions,
          ...(entry.generated ? { generated: true } : {}),
        })),
        ...(summary.entries.length > MAX_STATUS_ENTRIES
          ? { truncated: true, total_files: summary.entries.length }
          : {}),
      },
    };
  },
});

const MAX_DIFF_FILES = 50;

const getGitDiff = defineTool({
  name: "get_git_diff",
  title: "Get Git diff",
  description:
    "Unified diff of a workspace checkout: uncommitted changes (`working`) or the branch against main (`branch-main`). Pass `path` for one file; otherwise files are concatenated up to max_bytes. Files denied by the file policy are listed but withheld.",
  inputSchema: z.object({
    workspace_id: workspaceIdField,
    connection_id: connectionIdField,
    mode: z.enum(["working", "branch-main"]).default("working"),
    path: z.string().max(4096).optional(),
    max_bytes: z.number().int().min(1024).max(262144).default(65536),
  }),
  async handler(ctx, args) {
    const connection = singleConnection(ctx, args.connection_id);
    assertWorkspace(ctx, connection, args.workspace_id);
    const summary = await connection.gitDiffSummary(
      args.workspace_id,
      args.mode,
    );
    let entries = summary.entries;
    if (args.path) {
      deny(ctx, args.path);
      entries = summary.entries.filter((entry) => entry.path === args.path);
      if (entries.length === 0) {
        return {
          data: {
            workspace_id: args.workspace_id,
            mode: args.mode,
            path: args.path,
            changed: false,
          },
          body: "",
        };
      }
    }
    const parts: string[] = [];
    const withheld: string[] = [];
    const omitted: string[] = [];
    let bytes = 0;
    let truncated = false;
    for (const entry of entries) {
      if (
        ctx.filePolicy.deniedBy(entry.path) ||
        (entry.old_path && ctx.filePolicy.deniedBy(entry.old_path))
      ) {
        withheld.push(entry.path);
        continue;
      }
      if (entry.generated && !args.path) {
        omitted.push(entry.path);
        continue;
      }
      if (bytes >= args.max_bytes || parts.length >= MAX_DIFF_FILES) {
        omitted.push(entry.path);
        truncated = true;
        continue;
      }
      const diff = await connection.gitDiffFile(args.workspace_id, {
        path: entry.path,
        old_path: entry.old_path,
        kind: entry.kind,
        mode: args.mode,
      });
      let text = diff.diff;
      const remaining = args.max_bytes - bytes;
      if (Buffer.byteLength(text) > remaining || diff.truncated) {
        text = `${Buffer.from(text).subarray(0, remaining).toString("utf8")}\n[diff truncated]`;
        truncated = true;
      }
      bytes += Buffer.byteLength(text);
      parts.push(text.endsWith("\n") ? text : `${text}\n`);
    }
    return {
      data: {
        connection_id: connection.id,
        workspace_id: args.workspace_id,
        mode: args.mode,
        base: summary.base,
        files: parts.length,
        ...(withheld.length ? { withheld_by_policy: withheld } : {}),
        ...(omitted.length ? { omitted: omitted.slice(0, 200) } : {}),
        ...(truncated ? { truncated: true } : {}),
      },
      body: parts.join(""),
    };
  },
});

const readFile = defineTool({
  name: "read_file",
  title: "Read file",
  description:
    "Read a text file inside a workspace checkout by relative path, with line paging. Secret files (.env*, keys, credentials, and configured patterns) are denied.",
  inputSchema: z.object({
    workspace_id: workspaceIdField,
    path: z
      .string()
      .min(1)
      .max(4096)
      .describe("Path relative to the workspace root."),
    connection_id: connectionIdField,
    start_line: z.number().int().min(1).default(1),
    max_lines: z.number().int().min(1).max(5000).default(400),
    max_bytes: z.number().int().min(1024).max(262144).default(65536),
  }),
  async handler(ctx, args) {
    const connection = singleConnection(ctx, args.connection_id);
    assertWorkspace(ctx, connection, args.workspace_id);
    deny(ctx, args.path);
    const file = await connection.fileRead(args.workspace_id, args.path);
    deny(ctx, file.real_path);
    const meta = {
      connection_id: connection.id,
      workspace_id: args.workspace_id,
      path: file.path,
      size: file.size,
    };
    if (file.type === "directory") {
      return { data: { ...meta, type: "directory", hint: "use list_files" } };
    }
    if (file.binary || file.text === null) {
      return { data: { ...meta, binary: true, mime_type: file.mime_type } };
    }
    const lines = file.text.split("\n");
    const start = args.start_line - 1;
    let end = Math.min(lines.length, start + args.max_lines);
    let body = lines.slice(start, end).join("\n");
    let clipped = false;
    if (Buffer.byteLength(body) > args.max_bytes) {
      body = Buffer.from(body).subarray(0, args.max_bytes).toString("utf8");
      end = start + body.split("\n").length;
      clipped = true;
    }
    return {
      data: {
        ...meta,
        total_lines: lines.length,
        start_line: args.start_line,
        end_line: Math.max(args.start_line - 1, end),
        ...(end < lines.length || clipped ? { next_start_line: end + 1 } : {}),
        ...(file.truncated
          ? { file_truncated_at_bytes: file.text.length }
          : {}),
      },
      body,
    };
  },
});

const listFiles = defineTool({
  name: "list_files",
  title: "List files",
  description:
    "List one directory inside a workspace checkout. Entries matching the secret file policy are marked denied and cannot be read.",
  inputSchema: z.object({
    workspace_id: workspaceIdField,
    path: z
      .string()
      .max(4096)
      .default("")
      .describe(
        "Directory relative to the workspace root; empty for the root.",
      ),
    connection_id: connectionIdField,
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(1000).default(200),
  }),
  async handler(ctx, args) {
    const connection = singleConnection(ctx, args.connection_id);
    assertWorkspace(ctx, connection, args.workspace_id);
    if (args.path) deny(ctx, args.path);
    const listing = await connection.fileList(args.workspace_id, args.path);
    const base = listing.path ? `${listing.path}/` : "";
    const entries = listing.entries.map((entry) => {
      const denied = ctx.filePolicy.deniedBy(`${base}${entry.name}`) !== null;
      return {
        name: entry.name,
        type: entry.type,
        ...(entry.type !== "directory" ? { size: entry.size } : {}),
        ...(entry.symlink_status ? { symlink: entry.symlink_status } : {}),
        ...(entry.ignored ? { ignored: true } : {}),
        ...(denied ? { denied: true } : {}),
      };
    });
    const page = entries.slice(args.offset, args.offset + args.limit);
    return {
      data: {
        connection_id: connection.id,
        workspace_id: args.workspace_id,
        root: listing.root,
        path: listing.path,
        total: entries.length,
        entries: page,
        ...(args.offset + page.length < entries.length
          ? { next_offset: args.offset + page.length }
          : {}),
        ...(listing.truncated ? { truncated: true } : {}),
      },
    };
  },
});

const getActivity = defineTool({
  name: "get_activity",
  title: "Get activity",
  description:
    "What is happening now: agents that are working or waiting for input, who is viewing Thyra, and recent workspace events (agents finishing or blocking, panes and workspaces opening or closing).",
  inputSchema: z.object({
    connection_id: connectionIdField,
    limit: z.number().int().min(1).max(200).default(30),
  }),
  async handler(ctx, args) {
    const connections = connectionsFor(ctx, args.connection_id);
    const active = [];
    const idle: Record<string, number> = {};
    const viewers = [];
    for (const connection of connections) {
      for (const agent of await scopedAgents(ctx, connection)) {
        if (agent.status === "working" || agent.status === "blocked") {
          active.push(agent);
        } else {
          const status = agent.status ?? "unknown";
          idle[status] = (idle[status] ?? 0) + 1;
        }
      }
      const presence = await connection.collaborationList().catch(() => null);
      const snapshot = isRecord(presence)
        ? isRecord(presence.snapshot)
          ? presence.snapshot
          : presence
        : null;
      for (const participant of list(snapshot, "participants")) {
        const workspaceId =
          str(participant.workspace_id) ??
          workspaceOfId(str(participant.pane_id));
        if (!inScope(ctx, connection, workspaceId)) continue;
        viewers.push({
          connection_id: connection.id,
          name: str(participant.display_name),
          surface: str(participant.surface),
          activity: str(participant.activity),
          workspace_id: workspaceId,
          pane_id: str(participant.pane_id),
          typing: participant.typing === true || undefined,
        });
      }
    }
    const ids = new Set(connections.map((connection) => connection.id));
    const events = ctx
      .activity()
      .filter((event) => {
        if (!ids.has(event.connection_id)) return false;
        const connection = connections.find(
          (item) => item.id === event.connection_id,
        );
        const workspaceId =
          event.workspace_id ??
          workspaceOfId(event.pane_id) ??
          workspaceOfId(event.tab_id);
        return connection ? inScope(ctx, connection, workspaceId) : false;
      })
      .slice(-args.limit)
      .reverse();
    return {
      data: {
        now: new Date(ctx.now?.() ?? Date.now()).toISOString(),
        active_agents: active,
        other_agents_by_status: idle,
        viewers,
        recent_events: events,
      },
    };
  },
});

export const MCP_TOOLS = [
  listWorkspaces,
  getPaneOutput,
  listAgentSessions,
  getGitStatus,
  getGitDiff,
  readFile,
  listFiles,
  getActivity,
] as const;

export type McpToolName = (typeof MCP_TOOLS)[number]["name"];

export type McpToolResult = { text: string; isError: boolean };

/** Serialize, redact, and cap one tool result. */
export function formatToolOutput(output: ToolOutput): string {
  const data = JSON.stringify(redactDeep(output.data));
  let text =
    output.body === undefined ? data : `${data}\n\n${redactText(output.body)}`;
  // Defense in depth: patterns spanning the JSON encoding.
  text = redactText(text);
  if (text.length > MAX_TOOL_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[output truncated at ${MAX_TOOL_OUTPUT_CHARS} characters; narrow the request]`;
  }
  return text;
}

/** Validate arguments, run a tool, and return redacted, capped text. */
export async function runMcpTool(
  name: string,
  rawArgs: unknown,
  ctx: McpToolContext,
): Promise<McpToolResult> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { text: `unknown tool: ${name}`, isError: true };
  const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      text: redactText(`invalid arguments: ${z.prettifyError(parsed.error)}`),
      isError: true,
    };
  }
  try {
    const output = await (
      tool.handler as (
        ctx: McpToolContext,
        args: unknown,
      ) => Promise<ToolOutput>
    )(ctx, parsed.data);
    return { text: formatToolOutput(output), isError: false };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "error");
    return { text: redactText(message).slice(0, 2000), isError: true };
  }
}
