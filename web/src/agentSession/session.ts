import { createStore, type StoreApi } from "zustand/vanilla";
import {
  AGENT_SESSION_EVENT,
  type AgentSessionEvent,
  type AgentSessionSnapshot,
} from "../../../shared/agentSession";
import type { AgentSessionTransport } from "../agentSessions";
import {
  type AgentSessionState,
  applySessionEvent,
  sessionFromSnapshot,
} from "./reducer";

export type AgentSessionView = {
  /** Null until the first snapshot; kept while subscribing again. */
  session: AgentSessionState | null;
  /** Why the last subscribe failed, while it is being retried. */
  error: string | null;
};

export type AgentSessionStore = StoreApi<AgentSessionView>;

export function createAgentSessionStore(): AgentSessionStore {
  return createStore<AgentSessionView>(() => ({ session: null, error: null }));
}

const RETRY_MS = [1000, 2000, 5000, 10_000];

type Scheduler = {
  /** Run `task` with the next frame; returns its cancel function. */
  frame(task: () => void): () => void;
  timer(task: () => void, ms: number): () => void;
};

const browserScheduler: Scheduler = {
  frame(task) {
    // Frames stop in a hidden page; a timer keeps the state current there.
    if (typeof document !== "undefined" && !document.hidden) {
      const handle = requestAnimationFrame(task);
      return () => cancelAnimationFrame(handle);
    }
    return browserScheduler.timer(task, 250);
  },
  timer(task, ms) {
    const handle = setTimeout(task, ms);
    return () => clearTimeout(handle);
  },
};

/**
 * Keep `store` current with one pane's session until the returned function
 * is called: subscribe for a snapshot, apply the events that follow once per
 * frame, and subscribe again when a sequence number is skipped or the
 * subscribe fails. The store keeps its last session meanwhile.
 */
export function connectAgentSession(
  transport: AgentSessionTransport,
  paneId: string,
  store: AgentSessionStore,
  scheduler: Scheduler = browserScheduler,
): () => void {
  let disposed = false;
  let ready = false;
  let attempt = 0;
  let pending: AgentSessionEvent[] = [];
  let cancelFlush: (() => void) | null = null;
  let cancelRetry: (() => void) | null = null;

  const flush = () => {
    cancelFlush = null;
    const before = store.getState().session;
    if (!ready || !before) return;
    let session = before;
    const events = pending;
    pending = [];
    for (const event of events) {
      const next = applySessionEvent(session, event);
      if (next === "gap") {
        // Keep what applied; the fresh snapshot replaces it.
        subscribe();
        break;
      }
      session = next;
    }
    if (session !== before) store.setState({ session });
  };

  const subscribe = () => {
    ready = false;
    pending = [];
    transport.call("agent_session.subscribe", { pane_id: paneId }).then(
      (snapshot: AgentSessionSnapshot) => {
        if (disposed) return;
        attempt = 0;
        ready = true;
        store.setState({
          session: sessionFromSnapshot(snapshot, store.getState().session),
          error: null,
        });
        // Events that arrived while the snapshot was on its way.
        flush();
      },
      (failure: unknown) => {
        if (disposed) return;
        store.setState({
          error: failure instanceof Error ? failure.message : String(failure),
        });
        const delay = RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)];
        cancelRetry = scheduler.timer(subscribe, delay);
      },
    );
  };

  const stopEvents = transport.onEvent((name, data) => {
    const event = data as AgentSessionEvent;
    if (name !== AGENT_SESSION_EVENT || event?.pane_id !== paneId) return;
    pending.push(event);
    if (ready) cancelFlush ??= scheduler.frame(flush);
  });
  subscribe();

  return () => {
    disposed = true;
    stopEvents();
    cancelFlush?.();
    cancelRetry?.();
    // Fails on a connection that is gone, which has dropped it already.
    transport
      .call("agent_session.unsubscribe", { pane_id: paneId })
      .catch(() => {});
  };
}
