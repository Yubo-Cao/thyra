import { createStore, useStore } from "zustand";
import { thyraLocalStorage } from "./browserStorage";
import { type LocalEditorMode, storedLocalEditorMode } from "./latencyAuto";

export type ShellEditorMode = LocalEditorMode;
const preferences = createStore<{ mode: ShellEditorMode }>(() => ({
  mode: storedLocalEditorMode(thyraLocalStorage.getItem("shellEditorMode")),
}));
export const useShellEditorMode = () => useStore(preferences, (s) => s.mode);
export function setShellEditorMode(mode: ShellEditorMode) {
  thyraLocalStorage.setItem("shellEditorMode", mode);
  preferences.setState({ mode });
}
