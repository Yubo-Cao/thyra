import { createStore, useStore } from "zustand";
import { thyraLocalStorage } from "./browserStorage";

// Panes this browser watches closely: when a watched agent finishes or needs
// input, Thyra plays a chime and shows its toast even while the pane is in
// view or task notifications are off. Stored per browser, keyed by
// connection and pane so a Herdr handoff keeps the choice.
const STORAGE_KEY = "watchedPanes";
const MAX_WATCHED = 200;

export function paneWatchKey(connectionId: string, paneId: string): string {
  return `${connectionId}\u0000${paneId}`;
}

function storedWatchedPanes(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      thyraLocalStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

const watched = createStore<{ keys: ReadonlySet<string> }>()(() => ({
  keys: new Set(storedWatchedPanes()),
}));

export function paneWatched(connectionId: string, paneId: string): boolean {
  return watched.getState().keys.has(paneWatchKey(connectionId, paneId));
}

export function setPaneWatched(
  connectionId: string,
  paneId: string,
  on: boolean,
) {
  const key = paneWatchKey(connectionId, paneId);
  const keys = [...watched.getState().keys].filter((k) => k !== key);
  if (on) keys.push(key);
  const kept = keys.slice(-MAX_WATCHED);
  thyraLocalStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  watched.setState({ keys: new Set(kept) });
  // The click is the user gesture browsers need before audio may play.
  if (on) primeTaskChime();
}

/** Adopt a change another tab wrote. */
export function reloadWatchedPanes(event: Pick<StorageEvent, "key">) {
  if (event.key !== null && event.key !== `thyra:${STORAGE_KEY}`) return;
  watched.setState({ keys: new Set(storedWatchedPanes()) });
}

export function usePaneWatched(connectionId: string, paneId: string): boolean {
  return useStore(watched, (state) =>
    state.keys.has(paneWatchKey(connectionId, paneId)),
  );
}

let audio: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (audio) return audio;
  const Context =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Context) return null;
  try {
    audio = new Context();
  } catch {
    return null;
  }
  return audio;
}

export function primeTaskChime() {
  void audioContext()
    ?.resume()
    .catch(() => {});
}

/** A short two-note chime: rising when done, a repeated note for input. */
export function playTaskChime(kind: "completed" | "blocked") {
  const context = audioContext();
  if (!context) return;
  const play = () => {
    const notes = kind === "completed" ? [660, 990] : [880, 880];
    const start = context.currentTime + 0.02;
    notes.forEach((frequency, index) => {
      const at = start + index * 0.16;
      const tone = context.createOscillator();
      const gain = context.createGain();
      tone.type = "sine";
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      tone.connect(gain).connect(context.destination);
      tone.start(at);
      tone.stop(at + 0.4);
    });
  };
  if (context.state === "running") play();
  else void context.resume().then(play, () => {});
}
