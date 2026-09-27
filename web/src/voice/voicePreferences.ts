import { createStore, useStore } from "zustand";
import { thyraLocalStorage } from "../browserStorage";
import { msg } from "../i18n";

/** How a finished dictation is rewritten by the bridge's language model. */
export type VoiceCleanupMode =
  | "off"
  | "tidy"
  | "verbatim"
  | "typeset"
  | "polish";

export const VOICE_CLEANUP_OPTIONS: {
  value: VoiceCleanupMode;
  label: string;
}[] = [
  { value: "off", label: msg("Off") },
  { value: "tidy", label: msg("Tidy") },
  { value: "verbatim", label: msg("Clean") },
  { value: "typeset", label: msg("Typeset") },
  { value: "polish", label: msg("Polish") },
];

const STORAGE_KEY = "voiceCleanupMode";

export function voiceCleanupMode(): VoiceCleanupMode {
  const stored = thyraLocalStorage.getItem(STORAGE_KEY);
  return VOICE_CLEANUP_OPTIONS.some((option) => option.value === stored)
    ? (stored as VoiceCleanupMode)
    : "tidy";
}

const cleanupModeStore = createStore<VoiceCleanupMode>()(voiceCleanupMode);

export function setVoiceCleanupMode(mode: VoiceCleanupMode) {
  thyraLocalStorage.setItem(STORAGE_KEY, mode);
  cleanupModeStore.setState(mode, true);
}

export function useVoiceCleanupMode(): VoiceCleanupMode {
  return useStore(cleanupModeStore);
}
