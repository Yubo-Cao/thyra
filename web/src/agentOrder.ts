import { msg, t } from "./i18n";
import type { Pane } from "./types";

export const AGENT_ORDER_STORAGE_KEY = "agentOrder.v1";

const MAX_AGENT_ORDER_ENTRIES = 512;
const MAX_PANE_ID_LENGTH = 512;

export function parseAgentOrder(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const paneIds: string[] = [];
    for (const candidate of value) {
      if (
        typeof candidate !== "string" ||
        candidate.length === 0 ||
        candidate.length > MAX_PANE_ID_LENGTH ||
        seen.has(candidate)
      ) {
        continue;
      }
      seen.add(candidate);
      paneIds.push(candidate);
      if (paneIds.length >= MAX_AGENT_ORDER_ENTRIES) break;
    }
    return paneIds;
  } catch {
    return [];
  }
}

export function serializeAgentOrder(paneIds: readonly string[]): string {
  return JSON.stringify(paneIds.slice(0, MAX_AGENT_ORDER_ENTRIES));
}

export function orderAgentPanes<T extends { pane_id: string }>(
  panes: readonly T[],
  preferredPaneIds: readonly string[],
): T[] {
  const panesById = new Map(panes.map((pane) => [pane.pane_id, pane]));
  const ordered: T[] = [];
  const seen = new Set<string>();
  for (const paneId of preferredPaneIds) {
    const pane = panesById.get(paneId);
    if (!pane || seen.has(paneId)) continue;
    ordered.push(pane);
    seen.add(paneId);
  }
  for (const pane of panes) {
    if (seen.has(pane.pane_id)) continue;
    ordered.push(pane);
    seen.add(pane.pane_id);
  }
  return ordered;
}

export function moveAgentPane(
  paneIds: readonly string[],
  draggedPaneId: string,
  targetPaneId: string,
  position: "before" | "after",
): string[] {
  if (draggedPaneId === targetPaneId) return [...paneIds];
  if (!paneIds.includes(draggedPaneId) || !paneIds.includes(targetPaneId)) {
    return [...paneIds];
  }
  const next = paneIds.filter((paneId) => paneId !== draggedPaneId);
  const targetIndex = next.indexOf(targetPaneId);
  next.splice(targetIndex + (position === "after" ? 1 : 0), 0, draggedPaneId);
  return next;
}

export const AGENT_LIST_PREFERENCES_STORAGE_KEY = "agentListPreferences.v1";
export type AgentSort = "attention" | "manual" | "workspace";
export type AgentGrouping = "none" | "status" | "workspace" | "agent";
export type AgentListPreferences = { sort: AgentSort; grouping: AgentGrouping };

export function parseAgentListPreferences(
  raw: string | null,
): AgentListPreferences {
  let value: Partial<AgentListPreferences> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (parsed && typeof parsed === "object") value = parsed;
  } catch {
    // Use attention-first defaults for missing or malformed preferences.
  }
  return {
    sort:
      value.sort === "manual" || value.sort === "workspace"
        ? value.sort
        : "attention",
    grouping:
      value.grouping === "status" ||
      value.grouping === "workspace" ||
      value.grouping === "agent"
        ? value.grouping
        : "none",
  };
}

const ATTENTION_STATUSES = [
  "blocked",
  "done",
  "working",
  "idle",
  "unknown",
] as const;

const AGENT_STATUS_TEXT: Record<string, string> = {
  blocked: msg("Blocked"),
  done: msg("Done"),
  working: msg("Working"),
  idle: msg("Idle"),
  unknown: msg("Unknown"),
};

/** The status Herdr reports, translated when it is a known agent state. */
export function agentStatusText(status: string): string {
  const text = AGENT_STATUS_TEXT[status.toLowerCase()];
  return text ? t(text) : status;
}

export function agentAttentionPriority(status: string): number {
  const index = ATTENTION_STATUSES.indexOf(
    status.toLowerCase() as (typeof ATTENTION_STATUSES)[number],
  );
  return index < 0 ? ATTENTION_STATUSES.length - 1 : index;
}

/** Join server activity metadata; no activity history is tracked in the browser. */
export function withAgentActivity(
  panes: readonly Pane[],
  result: unknown,
): Pane[] {
  const agents =
    result && typeof result === "object" && "agents" in result
      ? result.agents
      : null;
  if (!Array.isArray(agents)) return [...panes];
  const byPane = new Map<string, Record<string, unknown>>();
  for (const agent of agents) {
    if (
      !agent ||
      typeof agent !== "object" ||
      typeof agent.pane_id !== "string"
    )
      continue;
    byPane.set(agent.pane_id, agent);
  }
  return panes.map((pane) => {
    const agent = byPane.get(pane.pane_id);
    // Done and Idle share Herdr's underlying Idle state and sequence; only
    // the seen flag changes. The list calls can straddle an acknowledgement.
    const sameCompletedState =
      (pane.agent_status === "idle" || pane.agent_status === "done") &&
      (agent?.agent_status === "idle" || agent?.agent_status === "done");
    // Still reject metadata from a replacement or an actual state transition.
    if (
      !agent ||
      agent.terminal_id !== pane.terminal_id ||
      agent.agent !== pane.agent ||
      (agent.agent_status !== pane.agent_status && !sameCompletedState)
    )
      return pane;
    const sequence = agent.state_change_seq;
    const activity = agent.last_activity_at;
    return {
      ...pane,
      ...(typeof sequence === "number" &&
      Number.isSafeInteger(sequence) &&
      sequence >= 0
        ? { state_change_seq: sequence }
        : {}),
      // Sorting reads activity only among idle agents. A working agent's
      // timestamp moves on every poll and would re-render the whole app.
      ...(typeof activity === "number" &&
      Number.isFinite(activity) &&
      activity > 0 &&
      pane.agent_status.toLowerCase() !== "working"
        ? { last_activity_at: activity }
        : {}),
    };
  });
}

/**
 * A pane as everything but the attention sort reads it. The bridge moves
 * `last_activity_at` whenever an idle agent writes its session file; a view
 * that does not sort by it must not re-render for it.
 */
export type PaneWithoutActivity = Omit<Pane, "last_activity_at">;

function sameFieldValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return (
    typeof left === "object" &&
    typeof right === "object" &&
    left !== null &&
    right !== null &&
    JSON.stringify(left) === JSON.stringify(right)
  );
}

function sameFields(left: object, right: object): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return leftKeys.every((key) => key in b && sameFieldValue(a[key], b[key]));
}

/**
 * Derives activity-free panes whose identity follows their content: a pane
 * keeps its object, and the list its array, across refreshes that change
 * nothing but activity timestamps. `previous` is the last list derived.
 */
export function stablePanesWithoutActivity(
  panes: readonly Pane[],
  previous: readonly PaneWithoutActivity[],
): readonly PaneWithoutActivity[] {
  const previousById = new Map(previous.map((pane) => [pane.pane_id, pane]));
  let changed = panes.length !== previous.length;
  const next = panes.map((pane, index) => {
    const stripped: Pane = { ...pane };
    delete stripped.last_activity_at;
    const prior = previousById.get(pane.pane_id);
    const kept = prior && sameFields(prior, stripped) ? prior : stripped;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? next : previous;
}

let activityFreeSource: readonly Pane[] | null = null;
let activityFreePanes: readonly PaneWithoutActivity[] = [];

/**
 * Store selector for the panes without their activity timestamps. Select
 * this instead of `state.panes` unless the view sorts by activity.
 */
export function selectPanesWithoutActivity(state: {
  panes: readonly Pane[];
}): PaneWithoutActivity[] {
  if (state.panes !== activityFreeSource) {
    activityFreePanes = stablePanesWithoutActivity(
      state.panes,
      activityFreePanes,
    );
    activityFreeSource = state.panes;
  }
  // Consumers hold the list as the store's own pane array type.
  return activityFreePanes as PaneWithoutActivity[];
}

type AgentOrderWorkspace = { workspace_id: string; number: number };

/** Agent pane ids in the order the agent list shows them. */
export function orderedAgentPaneIds(
  panes: readonly Pane[],
  workspaces: readonly AgentOrderWorkspace[],
  preferredPaneIds: readonly string[],
  sort: AgentSort,
): string[] {
  const workspaceNumbers = new Map(
    workspaces.map((workspace) => [workspace.workspace_id, workspace.number]),
  );
  const agents = panes
    .filter((pane) => typeof pane.agent === "string" && pane.agent.trim())
    .sort((left, right) => {
      const workspaceOrder =
        (workspaceNumbers.get(left.workspace_id) ?? 0) -
        (workspaceNumbers.get(right.workspace_id) ?? 0);
      return workspaceOrder || left.pane_id.localeCompare(right.pane_id);
    });
  return sortAgentPanes(agents, preferredPaneIds, sort).map(
    (pane) => pane.pane_id,
  );
}

/**
 * A store selector for `orderedAgentPaneIds` that returns the same array
 * until the order itself changes, so activity that does not reorder the
 * list re-renders nothing.
 */
export function agentPaneOrderSelector(
  preferredPaneIds: readonly string[],
  sort: AgentSort,
) {
  let panes: readonly Pane[] | null = null;
  let workspaces: readonly AgentOrderWorkspace[] | null = null;
  let order: string[] = [];
  return (state: {
    panes: readonly Pane[];
    workspaces: readonly AgentOrderWorkspace[];
  }): string[] => {
    if (state.panes === panes && state.workspaces === workspaces) return order;
    const next = orderedAgentPaneIds(
      state.panes,
      state.workspaces,
      preferredPaneIds,
      sort,
    );
    panes = state.panes;
    workspaces = state.workspaces;
    if (
      next.length !== order.length ||
      next.some((paneId, index) => paneId !== order[index])
    )
      order = next;
    return order;
  };
}

export function sortAgentPanes<
  T extends {
    pane_id: string;
    agent_status: string;
    state_change_seq?: number;
    last_activity_at?: number;
  },
>(
  panes: readonly T[],
  preferredPaneIds: readonly string[],
  sort: AgentSort,
): T[] {
  if (sort === "workspace") return [...panes];
  const ordered = orderAgentPanes(panes, preferredPaneIds);
  return sort === "attention"
    ? ordered.sort((left, right) => {
        const priority =
          agentAttentionPriority(left.agent_status) -
          agentAttentionPriority(right.agent_status);
        if (priority || left.agent_status.toLowerCase() !== "idle")
          return priority;
        return (
          (right.last_activity_at ?? 0) - (left.last_activity_at ?? 0) ||
          (right.state_change_seq ?? 0) - (left.state_change_seq ?? 0)
        );
      })
    : ordered;
}

export function groupOrderedAgentPanes<
  T extends { workspace_id: string; agent?: string; agent_status: string },
>(
  panes: readonly T[],
  grouping: AgentGrouping,
  workspaceLabels: ReadonlyMap<string, string>,
): { key: string; label: string; panes: T[] }[] {
  const groups = new Map<string, { key: string; label: string; panes: T[] }>();
  for (const pane of panes) {
    const status =
      ATTENTION_STATUSES[agentAttentionPriority(pane.agent_status)];
    const key =
      grouping === "workspace"
        ? pane.workspace_id
        : grouping === "agent"
          ? pane.agent?.trim().toLowerCase() || "unknown"
          : grouping === "status"
            ? status
            : "all";
    const label =
      grouping === "workspace"
        ? (workspaceLabels.get(key) ?? key)
        : grouping === "agent"
          ? pane.agent?.trim() || t("Unknown agent")
          : grouping === "status"
            ? {
                blocked: t("Blocked"),
                done: t("Done"),
                idle: t("Idle"),
                working: t("Working"),
                unknown: t("Unknown"),
              }[status]
            : t("All agents");
    const group = groups.get(key);
    if (group) group.panes.push(pane);
    else groups.set(key, { key, label, panes: [pane] });
  }
  const result = [...groups.values()];
  if (grouping === "status")
    result.sort(
      (left, right) =>
        agentAttentionPriority(left.key) - agentAttentionPriority(right.key),
    );
  return result;
}
