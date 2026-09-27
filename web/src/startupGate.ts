import { useEffect, useState } from "react";

// On slow links the first terminal output must not share bandwidth with
// warmups (file lists, diffs, update checks, chunk prefetch). Work that the
// terminal and the workspace/agent/tab switchers do not need waits until a
// terminal has rendered output, or a short fallback when none arrives (an
// empty workspace, a failed attach).

export const STARTUP_FALLBACK_MS = 4000;

let settled = false;
const waiters = new Set<() => void>();

function settle() {
  if (settled) return;
  settled = true;
  const pending = [...waiters];
  waiters.clear();
  for (const run of pending) run();
}

/** Called by a terminal once its first output has been parsed. */
export function noteTerminalOutput() {
  settle();
}

export function startupSettled() {
  return settled;
}

/**
 * Run `task` after the first terminal output, or `fallbackMs` after this
 * call, whichever comes first; immediately once startup has settled.
 * Returns a cancel function.
 */
export function afterStartup(
  task: () => void,
  fallbackMs = STARTUP_FALLBACK_MS,
  timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = globalThis,
) {
  if (settled) {
    task();
    return () => {};
  }
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    timers.clearTimeout(timer);
    waiters.delete(run);
    task();
  };
  // The fallback settles startup for everyone: nothing is coming first.
  const timer = timers.setTimeout(settle, fallbackMs);
  waiters.add(run);
  return () => {
    done = true;
    timers.clearTimeout(timer);
    waiters.delete(run);
  };
}

/** True once startup work may run; `armed` starts the fallback clock. */
export function useStartupSettled(armed: boolean) {
  const [ready, setReady] = useState(settled);
  useEffect(() => {
    if (ready || !armed) return;
    return afterStartup(() => setReady(true));
  }, [armed, ready]);
  return ready;
}

export function resetStartupGateForTests() {
  settled = false;
  waiters.clear();
}
