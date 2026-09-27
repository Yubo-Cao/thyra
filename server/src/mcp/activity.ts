import { herdrEventName } from "../utils/herdr-events";

/** Bounded in-memory log of recent workspace events for `get_activity`. */

export type McpActivityEvent = {
  at: string;
  connection_id: string;
  type: string;
  workspace_id?: string;
  tab_id?: string;
  pane_id?: string;
  agent?: string;
};

// Structural events worth reporting; high-frequency focus and layout churn
// would only push useful history out of the buffer.
const RECORDED_HERDR_EVENTS = new Set([
  "workspace_created",
  "workspace_renamed",
  "workspace_closed",
  "tab_created",
  "tab_closed",
  "tab_renamed",
  "pane_created",
  "pane_closed",
  "pane_exited",
  "pane_agent_detected",
  "worktree_created",
  "worktree_opened",
  "worktree_removed",
  "workspace_last_step_completed",
]);

function stringField(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value.slice(0, 200) : undefined;
}

export type McpActivityLog = ReturnType<typeof createMcpActivityLog>;

export function createMcpActivityLog(
  args: { capacity?: number; now?: () => Date } = {},
) {
  const capacity = args.capacity ?? 200;
  const now = args.now ?? (() => new Date());
  const events: McpActivityEvent[] = [];
  const push = (event: McpActivityEvent) => {
    events.push(event);
    if (events.length > capacity) events.splice(0, events.length - capacity);
  };
  return {
    /** Record a Herdr event envelope (`{ event, data }`). */
    recordHerdrEvent(connectionId: string, envelope: unknown) {
      // Herdr pushes snake_case names (`pane_created`); subscriptions and
      // local fallbacks use dotted ones. Report the snake_case form.
      const type = herdrEventName(envelope)?.replaceAll(".", "_");
      if (!type || !RECORDED_HERDR_EVENTS.has(type)) return;
      const data = (envelope as { data?: unknown }).data;
      const pane = (data as { pane?: unknown } | undefined)?.pane;
      push({
        at: now().toISOString(),
        connection_id: connectionId,
        type,
        workspace_id:
          stringField(data, "workspace_id") ??
          stringField(pane, "workspace_id"),
        tab_id: stringField(data, "tab_id") ?? stringField(pane, "tab_id"),
        pane_id: stringField(data, "pane_id") ?? stringField(pane, "pane_id"),
        agent: stringField(data, "agent") ?? stringField(pane, "agent"),
      });
    },
    /** Record an agent task transition (completed or blocked). */
    recordTaskEvent(
      connectionId: string,
      event: {
        kind: string;
        workspaceId: string;
        tabId?: string;
        paneId: string;
        agent: string;
      },
    ) {
      push({
        at: now().toISOString(),
        connection_id: connectionId,
        type: `agent_${event.kind}`,
        workspace_id: event.workspaceId,
        tab_id: event.tabId,
        pane_id: event.paneId,
        agent: event.agent,
      });
    },
    list(): McpActivityEvent[] {
      return [...events];
    },
  };
}
