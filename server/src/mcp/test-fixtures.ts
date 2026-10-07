import type { McpActivityEvent } from "./activity";
import { createFilePolicy } from "./file-policy";
import type { GitDiffSummary, McpConnection } from "./gateway";
import type { McpToolContext } from "./tools";
import { type McpPrincipal, parseScope } from "./tokens";

/** Shared fake Herdr/bridge data for MCP unit tests. */

// Assembled at runtime so repository secret scanners ignore the fixture.
export const PLANTED_SECRET = `sk-proj-${"Z".repeat(40)}`;

export type FakeCalls = string[];

export function fakeConnection(
  overrides: Partial<McpConnection> & { calls?: FakeCalls } = {},
): McpConnection {
  const calls = overrides.calls ?? [];
  const track = (name: string) => calls.push(name);
  const diffSummary: GitDiffSummary = {
    root: "/repo/alpha",
    mode: "working",
    entries: [
      {
        path: "src/app.ts",
        kind: "unstaged",
        status: "M",
        additions: 2,
        deletions: 1,
      },
      {
        path: ".env",
        kind: "unstaged",
        status: "M",
        additions: 1,
        deletions: 1,
      },
      {
        path: "notes.md",
        kind: "untracked",
        status: "?",
        additions: 3,
        deletions: 0,
      },
    ],
    counts: { staged: 0, unstaged: 2, untracked: 1, conflicted: 0 },
  };
  return {
    id: "legacy-default",
    label: "Default",
    isDefault: true,
    remote: false,
    async workspaceList() {
      track("workspace.list");
      return {
        workspaces: [
          {
            workspace_id: "w1",
            label: "alpha",
            focused: true,
            agent_status: "working",
            worktree: {
              repo_name: "alpha",
              checkout_path: "/repo/alpha",
              git_status: {
                branch: "main",
                ahead: 1,
                behind: 0,
                staged: 0,
                unstaged: 2,
                untracked: 1,
                dirty: true,
              },
            },
          },
          { workspace_id: "w2", label: "beta", agent_status: "idle" },
        ],
      };
    },
    async tabList() {
      track("tab.list");
      return {
        tabs: [
          { tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true },
          { tab_id: "w2:t1", workspace_id: "w2", label: "other" },
        ],
      };
    },
    async paneList() {
      track("pane.list");
      return {
        panes: [
          {
            pane_id: "w1:p1",
            workspace_id: "w1",
            tab_id: "w1:t1",
            focused: true,
            agent: "claude",
            agent_status: "working",
            cwd: "/repo/alpha",
            tokens: { usage: "12k" },
          },
          {
            pane_id: "w2:p1",
            workspace_id: "w2",
            tab_id: "w2:t1",
            agent: "codex",
            agent_status: "done",
            cwd: "/repo/beta",
          },
        ],
      };
    },
    async paneRead(paneId, lines) {
      track(`pane.read:${paneId}:${lines}`);
      return {
        text: `$ env\nAWS_SECRET_ACCESS_KEY=${"q".repeat(40)}\nOPENAI_API_KEY=${PLANTED_SECRET}\nready\n`,
        truncated: false,
      };
    },
    async agentList() {
      track("agent.list");
      return {
        agents: [
          {
            pane_id: "w1:p1",
            workspace_id: "w1",
            tab_id: "w1:t1",
            agent: "claude",
            agent_status: "working",
            agent_session: {
              source: "hook",
              agent: "claude",
              kind: "id",
              value: "s-1",
            },
            last_activity_at: Date.parse("2026-09-27T10:00:03.000Z"),
          },
          {
            pane_id: "w2:p1",
            workspace_id: "w2",
            tab_id: "w2:t1",
            agent: "codex",
            agent_status: "done",
            agent_session: {
              source: "hook",
              agent: "codex",
              kind: "id",
              value: "s-2",
            },
            last_activity_at: Date.parse("2026-09-27T11:00:00.000Z"),
          },
        ],
      };
    },
    async collaborationList() {
      track("collaboration.list");
      return {
        snapshot: {
          participants: [
            {
              participant_id: "p-a",
              display_name: "Ada",
              workspace_id: "w1",
              pane_id: "w1:p1",
              activity: "active",
              surface: "web",
            },
            {
              participant_id: "p-b",
              display_name: "Bo",
              workspace_id: "w2",
              activity: "idle",
              surface: "web",
            },
          ],
          pane_claims: [{ pane_id: "w1:p1", participant_id: "p-a" }],
        },
      };
    },
    async fileList(workspaceId, path) {
      track(`file.list:${workspaceId}:${path}`);
      return {
        root: "/repo/alpha",
        path,
        truncated: false,
        entries: [
          {
            name: ".env",
            path: ".env",
            type: "file",
            size: 20,
            mtime_ms: 0,
            hidden: true,
          },
          {
            name: "src",
            path: "src",
            type: "directory",
            size: 0,
            mtime_ms: 0,
            hidden: false,
          },
          {
            name: "README.md",
            path: "README.md",
            type: "file",
            size: 30,
            mtime_ms: 0,
            hidden: false,
          },
          {
            name: "server.pem",
            path: "server.pem",
            type: "file",
            size: 30,
            mtime_ms: 0,
            hidden: false,
          },
        ],
      };
    },
    async fileRead(workspaceId, path) {
      track(`file.read:${workspaceId}:${path}`);
      return {
        root: "/repo/alpha",
        path,
        real_path: path,
        size: 60,
        mtime_ms: 0,
        truncated: false,
        binary: false,
        text: [
          "line 1",
          "line 2",
          `token = "${PLANTED_SECRET}"`,
          "line 4",
        ].join("\n"),
      };
    },
    async gitStatus(workspaceId) {
      track(`git.status:${workspaceId}`);
      return {
        root: "/repo/alpha",
        branch: "main",
        upstream: "origin/main",
        ahead: 1,
        behind: 0,
      };
    },
    async gitDiffSummary(workspaceId, mode) {
      track(`git.diff_summary:${workspaceId}:${mode}`);
      return diffSummary;
    },
    async gitDiffFile(workspaceId, entry) {
      track(`git.diff_file:${workspaceId}:${entry.path}`);
      return {
        diff: `diff --git a/${entry.path} b/${entry.path}\n+changed ${entry.path}\n`,
        truncated: false,
      };
    },
    ...overrides,
  };
}

export function principal(scope = "all"): McpPrincipal {
  return { tokenId: "abcd1234", name: "test", scope: parseScope(scope) };
}

export function toolContext(
  args: {
    scope?: string;
    connections?: McpConnection[];
    activity?: McpActivityEvent[];
    denyFiles?: string[];
  } = {},
): McpToolContext {
  const connections = args.connections ?? [fakeConnection()];
  return {
    principal: principal(args.scope),
    connections: () => connections,
    defaultConnectionId: () => "legacy-default",
    activity: () => args.activity ?? [],
    filePolicy: createFilePolicy(args.denyFiles),
    now: () => Date.parse("2026-09-27T12:00:00.000Z"),
  };
}
