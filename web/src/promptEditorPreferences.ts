import { createStore, useStore } from "zustand";
import { thyraLocalStorage } from "./browserStorage";
import { type LocalEditorMode, storedLocalEditorMode } from "./latencyAuto";

// When agent panes show the desktop prompt editor (stored per browser), and
// this page's per-pane choices (memory only, keyed like the composer
// drafts, so a reconnect starts again from the mode).
const STORAGE_KEY = "promptEditorMode";

type PromptEditorPreferences = {
  mode: LocalEditorMode;
  panes: Readonly<Record<string, boolean>>;
};

const preferences = createStore<PromptEditorPreferences>()(() => ({
  mode: storedLocalEditorMode(thyraLocalStorage.getItem(STORAGE_KEY)),
  panes: {},
}));

/**
 * The editor exists only on agent panes. There a pane's own toggle wins;
 * otherwise On and Off decide, and Auto shows it while the link is slow
 * (`highLatency`) or while the pane still holds a draft (`hasDraft`), so a
 * faster link never takes away text being written.
 */
export function promptEditorOpen(
  state: PromptEditorPreferences,
  paneKey: string,
  agentPane: boolean,
  highLatency: boolean,
  hasDraft = false,
): boolean {
  if (!agentPane) return false;
  const toggled = state.panes[paneKey];
  if (toggled !== undefined) return toggled;
  if (state.mode === "auto") return highLatency || hasDraft;
  return state.mode === "on";
}

export function setPromptEditorMode(mode: LocalEditorMode) {
  thyraLocalStorage.setItem(STORAGE_KEY, mode);
  preferences.setState({ mode });
}

export function setPromptEditorPaneOpen(paneKey: string, open: boolean) {
  preferences.setState((state) => ({
    panes: { ...state.panes, [paneKey]: open },
  }));
}

export function usePromptEditorMode(): LocalEditorMode {
  return useStore(preferences, (state) => state.mode);
}

export function usePromptEditorOpen(
  paneKey: string,
  agentPane: boolean,
  highLatency: boolean,
  hasDraft: boolean,
): boolean {
  return useStore(preferences, (state) =>
    promptEditorOpen(state, paneKey, agentPane, highLatency, hasDraft),
  );
}
