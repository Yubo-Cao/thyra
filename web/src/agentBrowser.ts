// Which connection's panes can open the host's agent browser, and which pane's
// view is open. The view itself (and noVNC) loads on first open.
import { createStore, useStore } from "zustand";

export type AgentBrowserTab = {
  targetId: string;
  url: string;
  title: string;
  review?: { state: string; message?: string };
};
export type AgentBrowserInfo = {
  connection_id: string | null;
  vnc: boolean;
  proxy: boolean;
  tabs?: AgentBrowserTab[] | null;
};
export type AgentBrowserTarget = {
  connectionId: string;
  workspaceId: string;
  paneId: string;
  targetId?: string;
};

export const agentBrowserStore = createStore<{
  /** The connection the agent browser serves (local Herdr), if any. */
  connectionId: string | null;
  open: AgentBrowserTarget | null;
}>()(() => ({ connectionId: null, open: null }));

export async function fetchAgentBrowser(
  paneId?: string,
): Promise<AgentBrowserInfo | null> {
  const query = paneId ? `?pane=${encodeURIComponent(paneId)}` : "";
  try {
    const response = await fetch(`/api/browser${query}`, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? ((await response.json()) as AgentBrowserInfo) : null;
  } catch {
    return null;
  }
}

/** Ask again after each hello: only instance admins get an answer. */
export async function refreshAgentBrowserStatus(host: boolean) {
  const info = host ? await fetchAgentBrowser() : null;
  agentBrowserStore.setState({ connectionId: info?.connection_id ?? null });
}

export async function activateAgentBrowserTab(
  paneId: string,
  targetId?: string,
): Promise<string | null> {
  const query = new URLSearchParams({ pane: paneId });
  if (targetId) query.set("target", targetId);
  try {
    const response = await fetch(`/api/browser/activate?${query}`, {
      method: "POST",
      credentials: "same-origin",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return (
      ((await response.json()) as { target_id?: string | null }).target_id ??
      null
    );
  } catch {
    return null;
  }
}

export function openAgentBrowser(target: AgentBrowserTarget) {
  agentBrowserStore.setState({ open: target });
}

export function closeAgentBrowser() {
  agentBrowserStore.setState({ open: null });
}

/** Whether panes of `connectionId` offer the agent browser. */
export function useAgentBrowserAvailable(connectionId: string): boolean {
  return useStore(
    agentBrowserStore,
    (state) =>
      state.connectionId !== null && state.connectionId === connectionId,
  );
}

export function useAgentBrowserOpen() {
  return useStore(agentBrowserStore, (state) => state.open);
}

/** X11 keysym of a typed character (Latin-1 direct, else Unicode). */
export function keysymOf(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)
    ? code
    : 0x01000000 + code;
}
