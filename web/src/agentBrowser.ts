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
  /** The display can switch to 2x device scale for a HiDPI viewer. */
  hidpi?: boolean;
  tabs?: AgentBrowserTab[] | null;
  /** Without a pane: the windows, each by its front tab. */
  windows?:
    | { targetId: string; url: string; title: string; tabs: number }[]
    | null;
};
/** A pane's tabs; without `paneId`, the whole browser with every tab. */
export type AgentBrowserTarget = {
  connectionId: string;
  workspaceId?: string;
  paneId?: string;
  targetId?: string;
};

export const agentBrowserStore = createStore<{
  /** The connection the agent browser serves (local Herdr), if any. */
  connectionId: string | null;
  open: AgentBrowserTarget | null;
}>()(() => ({ connectionId: null, open: null }));

/** Status only by default; `{ paneId }` adds its tabs, `{ all }` every tab. */
export async function fetchAgentBrowser(
  scope: { paneId?: string; all?: boolean } = {},
): Promise<AgentBrowserInfo | null> {
  const query = scope.paneId
    ? `?pane=${encodeURIComponent(scope.paneId)}`
    : scope.all
      ? "?all=1"
      : "";
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

/** Fronts a tab; never closes one, so other agents' tabs stay open. */
export async function activateAgentBrowserTab(
  paneId: string | undefined,
  targetId?: string,
): Promise<string | null> {
  if (!paneId && !targetId) return null;
  const query = new URLSearchParams();
  if (paneId) query.set("pane", paneId);
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

/** The connection whose host serves the agent browser, if any. */
export function useAgentBrowserConnection() {
  return useStore(agentBrowserStore, (state) => state.connectionId);
}

export function useAgentBrowserOpen() {
  return useStore(agentBrowserStore, (state) => state.open);
}

/**
 * Device scale to draw the remote at for this screen: its pixel density in
 * quarter steps from 1 to 3, so remote pixels land 1:1 on screen pixels.
 */
export function viewerScale(devicePixelRatio: number): number {
  const scale = Math.round(devicePixelRatio * 4) / 4;
  return Number.isFinite(scale) ? Math.min(3, Math.max(1, scale)) : 1;
}

/**
 * Whether a canvas of `pixels` drawn over `css` CSS pixels lands 1:1 on
 * screen pixels. Then it should be copied (nearest neighbour), not smoothed:
 * at 125% or 150% the canvas sits at a fractional device-pixel offset, and
 * smoothing resamples the whole picture into blur.
 */
export function landsOnPixels(
  css: { width: number; height: number },
  pixels: { width: number; height: number },
  devicePixelRatio: number,
): boolean {
  return (
    Math.abs(css.width * devicePixelRatio - pixels.width) <= 1 &&
    Math.abs(css.height * devicePixelRatio - pixels.height) <= 1
  );
}

/** X11 keysym of a typed character (Latin-1 direct, else Unicode). */
export function keysymOf(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)
    ? code
    : 0x01000000 + code;
}

/**
 * What to type so remote text that shows `previous` (an IME's composition so
 * far) shows `next`: how many characters to delete, then the text to add.
 */
export function compositionEdit(
  previous: string,
  next: string,
): { backspaces: number; text: string } {
  const before = Array.from(previous);
  const after = Array.from(next);
  let common = 0;
  while (
    common < before.length &&
    common < after.length &&
    before[common] === after[common]
  )
    common++;
  return {
    backspaces: before.length - common,
    text: after.slice(common).join(""),
  };
}

/** Consecutive failed status polls tolerated before the display is dropped. */
export const AGENT_BROWSER_POLL_MISSES = 3;
