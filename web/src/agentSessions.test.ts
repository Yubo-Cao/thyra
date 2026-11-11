import { expect, test } from "bun:test";
import type { AgentSessionInfo } from "../../shared/agentSession";
import {
  agentPaneView,
  agentSessionsStore,
  followAgentSessions,
  installAgentSessionTransport,
  setAgentPaneView,
} from "./agentSessions";
import type { ConnectionClient } from "./api";

const info = (paneId: string, status = "idle"): AgentSessionInfo =>
  ({
    pane_id: paneId,
    kind: "claude",
    status,
    cwd: "/work",
    started_at: 1,
    modes: [],
  }) as AgentSessionInfo;

const client = (connectionId: string, generation = 1) =>
  ({
    connectionId,
    generation,
    serverRuntimeGeneration: 7,
  }) as ConnectionClient;

/** A transport per connection whose list reply and pushes the test controls. */
function fakeTransport() {
  const listeners = new Map<
    string,
    Set<(name: string, data: unknown) => void>
  >();
  const lists = new Map<string, (value: unknown) => void>();
  installAgentSessionTransport(({ connectionId }) => ({
    call: (method) =>
      method === "agent_session.list"
        ? new Promise((resolve) => lists.set(connectionId, resolve))
        : Promise.resolve({}),
    onEvent(listener) {
      const set = listeners.get(connectionId) ?? new Set();
      listeners.set(connectionId, set.add(listener));
      return () => set.delete(listener);
    },
  }));
  return {
    async list(connectionId: string, sessions: AgentSessionInfo[]) {
      lists.get(connectionId)?.({ sessions });
      await Promise.resolve();
    },
    changed(connectionId: string, sessions: AgentSessionInfo[]) {
      for (const listener of listeners.get(connectionId) ?? [])
        listener("agent_session.changed", { sessions });
    },
    listening: (connectionId: string) => listeners.get(connectionId)?.size ?? 0,
  };
}

const view = (connectionId: string, paneId: string) =>
  agentPaneView(agentSessionsStore.getState(), connectionId, paneId);

test("panes with a session show the agent view once listed, and follow changes", async () => {
  const transport = fakeTransport();
  const stop = followAgentSessions(client("local"));
  expect(view("local", "p1")).toBeNull();
  await transport.list("local", [info("p1"), info("p2", "running")]);
  expect(view("local", "p1")).toBe("agent");
  expect(view("local", "p3")).toBeNull();
  // Another connection's panes never match, whatever their IDs.
  expect(view("remote", "p1")).toBeNull();

  transport.changed("local", [info("p2", "idle"), info("p3")]);
  expect(view("local", "p1")).toBeNull();
  expect(view("local", "p3")).toBe("agent");
  expect(agentSessionsStore.getState().sessions.p2.status).toBe("idle");

  stop();
  expect(transport.listening("local")).toBe(0);
});

test("the terminal choice is kept per pane and connection", async () => {
  const transport = fakeTransport();
  followAgentSessions(client("local"));
  await transport.list("local", [info("p1"), info("p2")]);
  setAgentPaneView("local", "p1", "terminal");
  expect(view("local", "p1")).toBe("terminal");
  expect(view("local", "p2")).toBe("agent");
  // Still chosen after the session list is replaced.
  transport.changed("local", [info("p1", "running"), info("p2")]);
  expect(view("local", "p1")).toBe("terminal");
  setAgentPaneView("local", "p1", "agent");
  expect(view("local", "p1")).toBe("agent");
});

test("switching connection drops the old sessions and ignores late replies", async () => {
  const transport = fakeTransport();
  const stopLocal = followAgentSessions(client("local"));
  await transport.list("local", [info("p1")]);
  expect(view("local", "p1")).toBe("agent");

  stopLocal();
  followAgentSessions(client("remote"));
  expect(agentSessionsStore.getState().sessions).toEqual({});
  // A push for the lease that was left behind.
  transport.changed("local", [info("p9")]);
  expect(agentSessionsStore.getState().sessions).toEqual({});
  await transport.list("remote", [info("p5")]);
  expect(view("remote", "p5")).toBe("agent");
  expect(view("local", "p1")).toBeNull();

  // The same connection after a reconnect keeps its list until the new one arrives.
  followAgentSessions(client("remote"));
  expect(view("remote", "p5")).toBe("agent");
  followAgentSessions(client("remote", 2));
  expect(view("remote", "p5")).toBeNull();
});
