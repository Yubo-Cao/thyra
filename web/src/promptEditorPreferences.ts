import { createStore, useStore } from "zustand";
import { thyraLocalStorage } from "./browserStorage";

// Whether agent panes open the desktop prompt editor by default (stored per
// browser), and this page's per-pane choices (memory only, keyed like the
// composer drafts, so a reconnect starts again from the default).
const STORAGE_KEY = "promptEditorAgentDefault";

type PromptEditorPreferences = {
  byDefault: boolean;
  panes: Readonly<Record<string, boolean>>;
};

function storedDefault() {
  return thyraLocalStorage.getItem(STORAGE_KEY) !== "0";
}

const preferences = createStore<PromptEditorPreferences>()(() => ({
  byDefault: storedDefault(),
  panes: {},
}));

/** The editor exists only on agent panes; there it follows the pane's toggle. */
export function promptEditorOpen(
  state: PromptEditorPreferences,
  paneKey: string,
  agentPane: boolean,
): boolean {
  return agentPane && (state.panes[paneKey] ?? state.byDefault);
}

export function setPromptEditorOpensByDefault(open: boolean) {
  if (open) thyraLocalStorage.removeItem(STORAGE_KEY);
  else thyraLocalStorage.setItem(STORAGE_KEY, "0");
  preferences.setState({ byDefault: open });
}

export function setPromptEditorPaneOpen(paneKey: string, open: boolean) {
  preferences.setState((state) => ({
    panes: { ...state.panes, [paneKey]: open },
  }));
}

export function usePromptEditorOpensByDefault(): boolean {
  return useStore(preferences, (state) => state.byDefault);
}

export function usePromptEditorOpen(
  paneKey: string,
  agentPane: boolean,
): boolean {
  return useStore(preferences, (state) =>
    promptEditorOpen(state, paneKey, agentPane),
  );
}
