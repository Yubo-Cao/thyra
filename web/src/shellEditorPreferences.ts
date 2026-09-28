import { createStore, useStore } from "zustand";
import { thyraLocalStorage } from "./browserStorage";

export type ShellEditorMode = "auto" | "on" | "off";
const stored = thyraLocalStorage.getItem("shellEditorMode");
const preferences = createStore<{ mode: ShellEditorMode }>(() => ({
  mode: stored === "on" || stored === "off" ? stored : "auto",
}));
export const useShellEditorMode = () => useStore(preferences, (s) => s.mode);
export function setShellEditorMode(mode: ShellEditorMode) {
  thyraLocalStorage.setItem("shellEditorMode", mode);
  preferences.setState({ mode });
}
