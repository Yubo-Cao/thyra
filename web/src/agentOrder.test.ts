import { describe, expect, test } from "bun:test";
import {
  moveAgentPane,
  orderAgentPanes,
  parseAgentOrder,
  serializeAgentOrder,
} from "./agentOrder";

describe("agent panel ordering", () => {
  test("parses only bounded unique pane ids", () => {
    expect(
      parseAgentOrder(
        JSON.stringify(["p2", "p1", "p2", 42, "", "x".repeat(513)]),
      ),
    ).toEqual(["p2", "p1"]);
    expect(parseAgentOrder("bad json")).toEqual([]);
    expect(parseAgentOrder("{}" as string)).toEqual([]);
    expect(JSON.parse(serializeAgentOrder(["p2", "p1"]))).toEqual(["p2", "p1"]);
  });

  test("applies stored order and appends new panes in source order", () => {
    const panes = [{ pane_id: "p1" }, { pane_id: "p2" }, { pane_id: "p3" }];
    expect(
      orderAgentPanes(panes, ["closed", "p3", "p1"]).map(
        (pane) => pane.pane_id,
      ),
    ).toEqual(["p3", "p1", "p2"]);
  });

  test("moves panes before and after a drop target", () => {
    expect(moveAgentPane(["p1", "p2", "p3"], "p3", "p1", "before")).toEqual([
      "p3",
      "p1",
      "p2",
    ]);
    expect(moveAgentPane(["p1", "p2", "p3"], "p1", "p2", "after")).toEqual([
      "p2",
      "p1",
      "p3",
    ]);
    expect(moveAgentPane(["p1", "p2"], "missing", "p1", "after")).toEqual([
      "p1",
      "p2",
    ]);
  });
});

import {
  groupOrderedAgentPanes,
  parseAgentListPreferences,
  sortAgentPanes,
  withAgentActivity,
} from "./agentOrder";

const agents = [
  {
    pane_id: "p1",
    workspace_id: "w1",
    agent: "Codex",
    agent_status: "working",
  },
  {
    pane_id: "p2",
    workspace_id: "w2",
    agent: "Claude",
    agent_status: "blocked",
  },
  { pane_id: "p3", workspace_id: "w1", agent: "codex", agent_status: "done" },
  {
    pane_id: "p4",
    workspace_id: "w2",
    agent: "Codex",
    agent_status: "BLOCKED",
  },
  { pane_id: "p5", workspace_id: "w1", agent: "Claude", agent_status: "idle" },
  {
    pane_id: "p6",
    workspace_id: "w1",
    agent: "Claude",
    agent_status: "new-status",
  },
];

describe("agent attention and grouping", () => {
  test("prioritizes blocked and completed agents with stable manual tie-breaking", () => {
    expect(
      sortAgentPanes(agents, ["p4", "p1", "p2"], "attention").map(
        (pane) => pane.pane_id,
      ),
    ).toEqual(["p4", "p2", "p3", "p1", "p5", "p6"]);
    expect(agents.map((pane) => pane.pane_id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
    ]);
    expect(
      sortAgentPanes(agents, ["p4", "p1"], "manual").map(
        (pane) => pane.pane_id,
      ),
    ).toEqual(["p4", "p1", "p2", "p3", "p5", "p6"]);
    expect(sortAgentPanes(agents, ["p4", "p1"], "workspace")).toEqual(agents);
    const updated = agents.map((pane) =>
      pane.pane_id === "p1" ? { ...pane, agent_status: "blocked" } : pane,
    );
    expect(sortAgentPanes(updated, [], "attention")[0].pane_id).toBe("p1");
  });

  test("groups statuses in attention order and preserves pane order within groups", () => {
    const groups = groupOrderedAgentPanes(agents, "status", new Map());
    expect(groups.map((group) => group.key)).toEqual([
      "blocked",
      "done",
      "working",
      "idle",
      "unknown",
    ]);
    expect(groups[0].panes.map((pane) => pane.pane_id)).toEqual(["p2", "p4"]);
  });

  test("groups by workspace identity even when names are duplicated and normalizes agent types", () => {
    const groups = groupOrderedAgentPanes(
      agents,
      "workspace",
      new Map([
        ["w1", "Project"],
        ["w2", "Project"],
      ]),
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.label)).toEqual(["Project", "Project"]);
    expect(
      groupOrderedAgentPanes(agents, "agent", new Map()).map(
        (group) => group.panes.length,
      ),
    ).toEqual([3, 3]);
    expect(groupOrderedAgentPanes(agents, "none", new Map())[0].panes).toEqual(
      agents,
    );
  });

  test("validates saved sorting and grouping preferences", () => {
    for (const raw of [null, "oops", "[]", '{"sort":"bad","grouping":"bad"}']) {
      expect(parseAgentListPreferences(raw)).toEqual({
        sort: "attention",
        grouping: "none",
      });
    }
    expect(
      parseAgentListPreferences('{"sort":"manual","grouping":"workspace"}'),
    ).toEqual({ sort: "manual", grouping: "workspace" });
  });
});

describe("Herdr activity ordering", () => {
  test("ranks only idle peers by latest state change, with stable ties", () => {
    const panes = [
      { pane_id: "old", agent_status: "idle", state_change_seq: 10 },
      { pane_id: "new", agent_status: "idle", state_change_seq: 30 },
      { pane_id: "working", agent_status: "working", state_change_seq: 1 },
      { pane_id: "tie", agent_status: "IDLE", state_change_seq: 30 },
      { pane_id: "missing", agent_status: "idle" },
      { pane_id: "blocked", agent_status: "blocked", state_change_seq: 1 },
    ];
    expect(
      sortAgentPanes(panes, ["old", "tie"], "attention").map((p) => p.pane_id),
    ).toEqual(["blocked", "working", "tie", "new", "old", "missing"]);
    expect(
      sortAgentPanes(panes, ["old", "tie"], "manual").map((p) => p.pane_id),
    ).toEqual(["old", "tie", "new", "working", "missing", "blocked"]);
    expect(sortAgentPanes(panes, [], "workspace")).toEqual(panes);
  });
});

const activityPane = {
  pane_id: "p1",
  terminal_id: "t1",
  workspace_id: "w1",
  tab_id: "tab1",
  focused: false,
  agent: "codex",
  agent_status: "idle",
  revision: 1,
};

describe("Herdr activity metadata", () => {
  test("reconstructs recency from fresh snapshots without mutating pane data", () => {
    const result = { agents: [{ ...activityPane, state_change_seq: 42 }] };
    expect(withAgentActivity([activityPane], result)[0]?.state_change_seq).toBe(
      42,
    );
    expect(
      withAgentActivity([structuredClone(activityPane)], result)[0]
        ?.state_change_seq,
    ).toBe(42);
    expect(activityPane).not.toHaveProperty("state_change_seq");
    expect(
      withAgentActivity([activityPane], {
        agents: [{ ...activityPane, state_change_seq: 0 }],
      })[0]?.state_change_seq,
    ).toBe(0);
  });

  test("preserves completion recency when acknowledging Done races the two snapshots", () => {
    for (const [paneStatus, agentStatus] of [
      ["idle", "done"],
      ["done", "idle"],
    ]) {
      const pane = { ...activityPane, agent_status: paneStatus };
      const result = {
        agents: [{ ...pane, agent_status: agentStatus, state_change_seq: 42 }],
      };
      const merged = withAgentActivity([pane], result)[0]!;
      expect(merged.state_change_seq).toBe(42);
      expect(merged.agent_status).toBe(paneStatus);
      if (paneStatus === "idle") {
        const older = {
          ...activityPane,
          pane_id: "older",
          state_change_seq: 10,
        };
        expect(
          sortAgentPanes([older, merged], [], "attention").map(
            (pane) => pane.pane_id,
          ),
        ).toEqual(["p1", "older"]);
      }
    }
  });

  test("does not join activity across terminal, agent, or status changes", () => {
    for (const mismatch of [
      { terminal_id: "replacement" },
      { agent: "claude" },
      { agent_status: "working" },
      { pane_id: "other" },
    ]) {
      const result = {
        agents: [{ ...activityPane, state_change_seq: 42, ...mismatch }],
      };
      expect(withAgentActivity([activityPane], result)[0]).toBe(activityPane);
    }
  });

  test("tolerates missing metadata and rejects invalid sequence numbers", () => {
    for (const result of [
      null,
      {},
      { agents: {} },
      { agents: [null, 42, {}] },
    ]) {
      expect(withAgentActivity([activityPane], result)).toEqual([activityPane]);
    }
    for (const state_change_seq of [
      undefined,
      -1,
      1.5,
      "42",
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        withAgentActivity([activityPane], {
          agents: [{ ...activityPane, state_change_seq }],
        }),
      ).toEqual([activityPane]);
    }
  });
});

describe("session activity ordering", () => {
  test("puts recently used idle agents above old agents with newer status sequences", () => {
    const panes = [
      {
        ...activityPane,
        pane_id: "stockpyl4",
        state_change_seq: 482,
        last_activity_at: 1000,
      },
      {
        ...activityPane,
        pane_id: "backend",
        state_change_seq: 471,
        last_activity_at: 2000,
      },
      {
        ...activityPane,
        pane_id: "superadmin",
        state_change_seq: 474,
        last_activity_at: 3000,
      },
      { ...activityPane, pane_id: "missing", state_change_seq: 999 },
      {
        ...activityPane,
        pane_id: "working",
        agent_status: "working",
        last_activity_at: 500,
      },
    ];
    expect(
      sortAgentPanes(panes, [], "attention").map((p) => p.pane_id),
    ).toEqual(["working", "superadmin", "backend", "stockpyl4", "missing"]);
    expect(sortAgentPanes(panes, ["stockpyl4"], "manual")).toEqual(panes);
    expect(sortAgentPanes(panes, [], "workspace")).toEqual(panes);
  });

  test("retains timestamps across Done/Idle acknowledgements even without a sequence", () => {
    const merged = withAgentActivity([activityPane], {
      agents: [
        { ...activityPane, agent_status: "done", last_activity_at: 1234 },
      ],
    });
    expect(merged[0]?.last_activity_at).toBe(1234);
    expect(merged[0]?.agent_status).toBe("idle");
    expect(merged[0]).not.toHaveProperty("state_change_seq");
  });

  test("rejects invalid activity values independently of valid sequence values", () => {
    for (const time of [undefined, null, "1234", 0, -1, NaN, Infinity]) {
      const merged = withAgentActivity([activityPane], {
        agents: [
          { ...activityPane, state_change_seq: 42, last_activity_at: time },
        ],
      });
      expect(merged[0]?.state_change_seq).toBe(42);
      expect(merged[0]).not.toHaveProperty("last_activity_at");
    }
  });
});

import {
  agentPaneOrderSelector,
  orderedAgentPaneIds,
  selectPanesWithoutActivity,
  stablePanesWithoutActivity,
} from "./agentOrder";
import type { Pane } from "./types";

describe("activity-stable pane selection", () => {
  const pane = (pane_id: string, fields: Partial<Pane> = {}): Pane => ({
    pane_id,
    terminal_id: `term-${pane_id}`,
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused: false,
    agent: "claude",
    agent_status: "idle",
    revision: 1,
    ...fields,
  });

  test("an activity tick keeps every pane and the list itself", () => {
    const first = stablePanesWithoutActivity(
      [pane("p1", { last_activity_at: 10 }), pane("p2")],
      [],
    );
    expect(first.map((entry) => "last_activity_at" in entry)).toEqual([
      false,
      false,
    ]);
    const ticked = stablePanesWithoutActivity(
      [pane("p1", { last_activity_at: 99 }), pane("p2")],
      first,
    );
    expect(ticked).toBe(first);
  });

  test("a real change replaces only the pane that changed", () => {
    const incident = { processes: 1, limit_bytes: 1024 };
    const first = stablePanesWithoutActivity(
      [
        pane("p1"),
        pane("p2", { memory_incident: { ...incident } }),
        pane("p3"),
      ],
      [],
    );
    const next = stablePanesWithoutActivity(
      [
        pane("p1", { last_activity_at: 5 }),
        pane("p2", { memory_incident: { ...incident } }),
        pane("p3", { agent_status: "working" }),
      ],
      first,
    );
    expect(next).not.toBe(first);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).toBe(first[1]);
    expect(next[2]).not.toBe(first[2]);
    expect(next[2]?.agent_status).toBe("working");
  });

  test("added, removed and reordered panes produce a new list", () => {
    const first = stablePanesWithoutActivity([pane("p1"), pane("p2")], []);
    const reordered = stablePanesWithoutActivity(
      [pane("p2"), pane("p1")],
      first,
    );
    expect(reordered).not.toBe(first);
    expect(reordered[0]).toBe(first[1]);
    expect(stablePanesWithoutActivity([pane("p1")], first)).toEqual([
      first[0]!,
    ]);
  });

  test("the store selector is memoized on the panes array", () => {
    const state = { panes: [pane("p1", { last_activity_at: 1 })] };
    const selected = selectPanesWithoutActivity(state);
    expect(selectPanesWithoutActivity(state)).toBe(selected);
    expect(
      selectPanesWithoutActivity({
        panes: [pane("p1", { last_activity_at: 2 })],
      }),
    ).toBe(selected);
    expect(
      selectPanesWithoutActivity({ panes: [pane("p1", { focused: true })] }),
    ).not.toBe(selected);
  });

  test("the agent order changes identity only when the order does", () => {
    const workspaces = [
      { workspace_id: "w1", number: 2 },
      { workspace_id: "w0", number: 1 },
    ];
    const panes = [
      pane("p1", { last_activity_at: 10 }),
      pane("p2", { last_activity_at: 20 }),
      pane("p3", { workspace_id: "w0", agent_status: "working" }),
      pane("shell", { agent: undefined }),
    ];
    expect(orderedAgentPaneIds(panes, workspaces, [], "workspace")).toEqual([
      "p3",
      "p1",
      "p2",
    ]);
    expect(orderedAgentPaneIds(panes, workspaces, ["p2"], "manual")).toEqual([
      "p2",
      "p3",
      "p1",
    ]);
    const select = agentPaneOrderSelector([], "attention");
    const order = select({ panes, workspaces });
    expect(order).toEqual(["p3", "p2", "p1"]);
    expect(select({ panes, workspaces })).toBe(order);
    // Activity moved, but p2 is still the most recently active idle agent.
    const ticked = panes.map((entry) =>
      entry.pane_id === "p2" ? { ...entry, last_activity_at: 30 } : entry,
    );
    expect(select({ panes: ticked, workspaces })).toBe(order);
    const overtaken = panes.map((entry) =>
      entry.pane_id === "p1" ? { ...entry, last_activity_at: 40 } : entry,
    );
    expect(select({ panes: overtaken, workspaces })).toEqual([
      "p3",
      "p1",
      "p2",
    ]);
  });
});
