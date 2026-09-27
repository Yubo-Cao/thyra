import { useEffect, useState } from "react";

// On slow links the first terminal output must not share bandwidth with
// warmups (file lists, diffs, update checks, chunk prefetch, the WebGL
// renderer and the terminal font). Work that the terminal and the
// workspace/agent/tab switchers do not need waits until a terminal has
// rendered output. The fallback for output that never comes (an empty pane,
// a failed attach) starts once a terminal has attached, so it cannot run out
// while the terminal code itself is still downloading; without any attach,
// a long ceiling applies.

export const STARTUP_FALLBACK_MS = 4000;
export const STARTUP_CEILING_MS = 60_000;

type Timers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;

let settled = false;
const waiters = new Set<() => void>();
let fallback: { timers: Timers; handle: ReturnType<typeof setTimeout> }[] = [];

function settle() {
  if (settled) return;
  settled = true;
  for (const { timers, handle } of fallback) timers.clearTimeout(handle);
  fallback = [];
  const pending = [...waiters];
  waiters.clear();
  for (const run of pending) run();
}

function settleAfter(ms: number, timers: Timers) {
  fallback.push({ timers, handle: timers.setTimeout(settle, ms) });
}

/** Called by a terminal once its first output has been parsed. */
export function noteTerminalOutput() {
  settle();
}

/** Called once a terminal attach has completed: output should follow. */
export function noteTerminalAttached(timers: Timers = globalThis) {
  if (!settled) settleAfter(STARTUP_FALLBACK_MS, timers);
}

export function startupSettled() {
  return settled;
}

/**
 * Run `task` after the first terminal output (or the fallback); immediately
 * once startup has settled. Returns a cancel function.
 */
export function afterStartup(task: () => void, timers: Timers = globalThis) {
  if (settled) {
    task();
    return () => {};
  }
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    waiters.delete(run);
    task();
  };
  if (!fallback.length) settleAfter(STARTUP_CEILING_MS, timers);
  waiters.add(run);
  return () => {
    done = true;
    waiters.delete(run);
  };
}

/** True once startup work may run. */
export function useStartupSettled() {
  const [ready, setReady] = useState(settled);
  useEffect(() => {
    if (ready) return;
    return afterStartup(() => setReady(true));
  }, [ready]);
  return ready;
}

export function resetStartupGateForTests() {
  settled = false;
  waiters.clear();
  for (const { timers, handle } of fallback) timers.clearTimeout(handle);
  fallback = [];
}
