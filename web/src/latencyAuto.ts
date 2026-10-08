import { useEffect } from "react";
import { createStore, useStore } from "zustand";
import { bridge } from "./api";

/** How a local editor (shell command line, agent prompt editor) appears. */
export type LocalEditorMode = "auto" | "on" | "off";

export function storedLocalEditorMode(value: string | null): LocalEditorMode {
  return value === "on" || value === "off" ? value : "auto";
}

/**
 * Whether the link is slow enough for Auto mode: the median bridge round
 * trip turns it on above 60 ms and off again only below 40 ms, so a jittery
 * link does not flap between the local editor and the terminal.
 */
export function autoEnabled(samples: readonly number[], previous: boolean) {
  if (!samples.length) return false;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return previous ? median >= 40 : median > 60;
}

// One poll of the heartbeat samples for every editor on the page.
const latency = createStore(() => ({ high: false }));
let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** Auto mode's latency verdict, updated once a second. */
export function useHighLatency(): boolean {
  useEffect(() => {
    if (users++ === 0) {
      const update = () =>
        latency.setState((state) => ({
          high: autoEnabled(bridge.recentRoundTrips, state.high),
        }));
      update();
      timer = setInterval(update, 1000);
    }
    return () => {
      if (--users === 0) clearInterval(timer);
    };
  }, []);
  return useStore(latency, (state) => state.high);
}
