import type { Pane } from "../types";

export function paneHasAgent<T extends Pick<Pane, "agent">>(
  pane?: T | null,
): pane is T & { agent: string } {
  return typeof pane?.agent === "string" && pane.agent.trim().length > 0;
}

export function groupAgentPanesByWorkspace<
  T extends Pick<Pane, "agent" | "workspace_id">,
>(panes: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const pane of panes) {
    if (!paneHasAgent(pane)) continue;
    const workspacePanes = grouped.get(pane.workspace_id);
    if (workspacePanes) workspacePanes.push(pane);
    else grouped.set(pane.workspace_id, [pane]);
  }
  return grouped;
}

export type AgentStateKind =
  | "working"
  | "blocked"
  | "idle"
  | "done"
  | "unknown";

export function agentStateKind(status?: string): AgentStateKind {
  switch ((status ?? "unknown").toLowerCase()) {
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    case "idle":
      return "idle";
    case "done":
      return "done";
    default:
      return "unknown";
  }
}

export function shouldShowAgentStatusLabel(status?: string): boolean {
  const kind = agentStateKind(status);
  return kind !== "idle" && kind !== "unknown";
}

const AGENT_STATE_PRIORITY: Record<AgentStateKind, number> = {
  blocked: 5,
  working: 4,
  idle: 3,
  done: 2,
  unknown: 1,
};

export type TabAgentSummary = {
  primaryAgent: string;
  additionalAgents: number;
  agents: string[];
  status: AgentStateKind;
};

export function summarizeTabAgents<
  T extends Pick<Pane, "agent" | "agent_status" | "focused" | "tab_id">,
>(panes: readonly T[], tabId: string): TabAgentSummary | null {
  const matching = panes.filter(
    (pane) => pane.tab_id === tabId && paneHasAgent(pane),
  );
  if (matching.length === 0) return null;

  const focused = matching.find((pane) => pane.focused);
  const ordered = focused
    ? [focused, ...matching.filter((pane) => pane !== focused)]
    : matching;
  const agents: string[] = [];
  let status: AgentStateKind = "unknown";
  for (const pane of ordered) {
    const agent = pane.agent?.trim() ?? "";
    if (!agent) continue;
    if (
      !agents.some(
        (candidate) => candidate.toLowerCase() === agent.toLowerCase(),
      )
    ) {
      agents.push(agent);
    }
    if (agent.toLowerCase() !== agents[0]?.toLowerCase()) continue;
    const candidateStatus = agentStateKind(pane.agent_status);
    if (AGENT_STATE_PRIORITY[candidateStatus] > AGENT_STATE_PRIORITY[status]) {
      status = candidateStatus;
    }
  }

  return {
    primaryAgent: agents[0],
    additionalAgents: agents.length - 1,
    agents,
    status,
  };
}
