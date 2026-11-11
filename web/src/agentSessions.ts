// Which panes run an agent session (shared/agentSession.ts) and whether each
// shows its agent view or its terminal. The view itself, its transcript
// state, and the Markdown code load with the first pane that shows one.
import { createStore, useStore } from "zustand";
import {
  AGENT_SESSIONS_CHANGED,
  type AgentSessionInfo,
} from "../../shared/agentSession";
import { bridge, type ConnectionClient } from "./api";

/** How the page reaches the sessions of one connection. */
export type AgentSessionTransport = {
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  /** `agent_session.*` pushes, until the returned function is called. */
  onEvent(listener: (name: string, data: unknown) => void): () => void;
};

export type AgentSessionTransportFactory = (
  client: ConnectionClient,
) => AgentSessionTransport;

const bridgeTransport: AgentSessionTransportFactory = (client) => ({
  call: (method, params) => client.call(method, params),
  onEvent: (listener) =>
    bridge.onEvent((event) => {
      if (
        event.event.startsWith("agent_session.") &&
        event.connection_id === client.connectionId &&
        client.acceptsServerGeneration(event.connection_generation)
      )
        listener(event.event, event.data);
    }),
});

let transportFactory = bridgeTransport;

export function agentSessionTransport(client: ConnectionClient) {
  return transportFactory(client);
}

export type AgentPaneView = "agent" | "terminal";

type AgentSessionsState = {
  /** The bridge announced the `agent_sessions` capability. */
  available: boolean;
  /** The connection lease `sessions` belongs to. */
  scope: string;
  connectionId: string;
  /** Sessions of that connection by pane ID. */
  sessions: Readonly<Record<string, AgentSessionInfo>>;
  /** Panes switched to their terminal, for this page's lifetime. */
  terminal: Readonly<Record<string, true>>;
};

export const agentSessionsStore = createStore<AgentSessionsState>()(() => ({
  available: false,
  scope: "",
  connectionId: "",
  sessions: {},
  terminal: {},
}));

/** Dev fixture seam: serve sessions from `factory` instead of the bridge. */
export function installAgentSessionTransport(
  factory: AgentSessionTransportFactory,
) {
  transportFactory = factory;
  agentSessionsStore.setState({ available: true, scope: "" });
}

export function setAgentSessionsAvailable(available: boolean) {
  if (transportFactory !== bridgeTransport) return;
  agentSessionsStore.setState(
    available ? { available } : { available, sessions: {} },
  );
}

const leaseScope = (client: ConnectionClient) =>
  `${client.connectionId}:${client.generation}:${client.serverRuntimeGeneration}`;
const paneKey = (connectionId: string, paneId: string) =>
  `${connectionId}\n${paneId}`;

function acceptSessions(scope: string, value: unknown) {
  if (agentSessionsStore.getState().scope !== scope || !Array.isArray(value))
    return;
  const sessions: Record<string, AgentSessionInfo> = {};
  for (const info of value as AgentSessionInfo[]) {
    if (typeof info?.pane_id === "string") sessions[info.pane_id] = info;
  }
  agentSessionsStore.setState({ sessions });
}

/**
 * Follow the session list of `client`'s connection: list now, then apply
 * `agent_session.changed`. Returns the function that stops following. Run it
 * again after a reconnect or a connection switch; another connection's
 * sessions are dropped at once.
 */
export function followAgentSessions(client: ConnectionClient): () => void {
  const scope = leaseScope(client);
  if (agentSessionsStore.getState().scope !== scope)
    agentSessionsStore.setState({
      scope,
      connectionId: client.connectionId,
      sessions: {},
    });
  if (!agentSessionsStore.getState().available) return () => {};
  const transport = agentSessionTransport(client);
  const stop = transport.onEvent((name, data) => {
    if (name === AGENT_SESSIONS_CHANGED)
      acceptSessions(scope, (data as { sessions?: unknown })?.sessions);
  });
  transport.call("agent_session.list").then(
    (result) => acceptSessions(scope, result?.sessions),
    // The next reconnect or change notification lists again.
    () => {},
  );
  return stop;
}

/** The view a pane shows; null without a session (always its terminal). */
export function agentPaneView(
  state: AgentSessionsState,
  connectionId: string,
  paneId: string | null | undefined,
): AgentPaneView | null {
  if (
    !paneId ||
    !state.available ||
    state.connectionId !== connectionId ||
    !state.sessions[paneId]
  )
    return null;
  return state.terminal[paneKey(connectionId, paneId)] ? "terminal" : "agent";
}

export function setAgentPaneView(
  connectionId: string,
  paneId: string,
  view: AgentPaneView,
) {
  const terminal = { ...agentSessionsStore.getState().terminal };
  if (view === "terminal") terminal[paneKey(connectionId, paneId)] = true;
  else delete terminal[paneKey(connectionId, paneId)];
  agentSessionsStore.setState({ terminal });
}

export function useAgentPaneView(
  connectionId: string,
  paneId: string | null | undefined,
) {
  return useStore(agentSessionsStore, (state) =>
    agentPaneView(state, connectionId, paneId),
  );
}

export function useAgentSessionsAvailable() {
  return useStore(agentSessionsStore, (state) => state.available);
}
