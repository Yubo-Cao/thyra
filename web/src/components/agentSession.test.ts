import { describe, expect, test } from "bun:test";
import {
  agentStateKind,
  groupAgentPanesByWorkspace,
  paneHasAgent,
  shouldShowAgentStatusLabel,
  summarizeTabAgents,
} from "./agentSession";

describe("agent session presentation", () => {
  test("treats an agent pane with unknown status as an agent", () => {
    expect(paneHasAgent({ agent: "codex", agent_status: "unknown" })).toBe(
      true,
    );
    expect(paneHasAgent({ agent: "   " })).toBe(false);
    expect(paneHasAgent(null)).toBe(false);
  });

  test("groups agent panes beneath their owning workspace", () => {
    const grouped = groupAgentPanesByWorkspace([
      { agent: "pi", workspace_id: "w1", pane_id: "p1" },
      { agent: undefined, workspace_id: "w1", pane_id: "p2" },
      { agent: "codex", workspace_id: "w2", pane_id: "p3" },
      { agent: "claude", workspace_id: "w1", pane_id: "p4" },
    ]);

    expect(grouped.get("w1")?.map((pane) => pane.pane_id)).toEqual([
      "p1",
      "p4",
    ]);
    expect(grouped.get("w2")?.map((pane) => pane.pane_id)).toEqual(["p3"]);
    expect(grouped.size).toBe(2);
  });

  test("summarizes the focused tab agent and its work state", () => {
    const panes = [
      {
        agent: "pi",
        agent_status: "working",
        focused: false,
        tab_id: "t1",
      },
      {
        agent: "codex",
        agent_status: "idle",
        focused: true,
        tab_id: "t1",
      },
      {
        agent: "PI",
        agent_status: "blocked",
        focused: false,
        tab_id: "t1",
      },
    ];

    expect(summarizeTabAgents(panes, "t1")).toEqual({
      primaryAgent: "codex",
      additionalAgents: 1,
      agents: ["codex", "pi"],
      status: "idle",
    });
    expect(
      summarizeTabAgents(
        panes.map((pane) => ({ ...pane, focused: false })),
        "t1",
      ),
    ).toMatchObject({ primaryAgent: "pi", status: "blocked" });
    expect(summarizeTabAgents(panes, "missing")).toBeNull();
    expect(agentStateKind("WORKING")).toBe("working");
    expect(agentStateKind("stopped")).toBe("unknown");
    expect(shouldShowAgentStatusLabel("idle")).toBe(false);
    expect(shouldShowAgentStatusLabel("unknown")).toBe(false);
    expect(shouldShowAgentStatusLabel("working")).toBe(true);
    expect(shouldShowAgentStatusLabel("blocked")).toBe(true);
    expect(shouldShowAgentStatusLabel("done")).toBe(true);
  });
});
