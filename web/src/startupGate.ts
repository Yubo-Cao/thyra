import { useEffect, useState } from "react";

// On slow links the first terminal output must not share bandwidth with
// warmups (file lists, diffs, update checks, chunk prefetch). Work that the
// terminal and the workspace/agent/tab switchers do not need waits until a
// terminal's engine has drawn. The fallback for output that never comes (an
// empty pane, a failed attach) starts once a terminal has attached, so it
// cannot run out while the terminal code itself is still downloading, and
// waits for an engine still loading, as does the ceiling for no attach; the
// hold limit bounds both.

export const STARTUP_FALLBACK_MS = 4000;
export const STARTUP_CEILING_MS = 60_000;
/** How long a loading terminal engine may hold the ceiling back. */
export const STARTUP_HOLD_MS = 180_000;

type Timers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;

let settled = false;
const waiters = new Set<() => void>();
// Work the fallbacks wait for (a loading terminal engine), up to the hold limit.
const holds = new Set<Promise<unknown>>();
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

function settleAfter(ms: number, timers: Timers, force = false) {
  const due = () => {
    if (force || !holds.size) settle();
    else void Promise.allSettled([...holds]).then(settle);
  };
  fallback.push({ timers, handle: timers.setTimeout(due, ms) });
}

/** The fallback settles only once `work` has finished as well. */
export function holdStartup(
  work: Promise<unknown>,
  timers: Timers = globalThis,
) {
  if (settled) return;
  if (!holds.size) settleAfter(STARTUP_HOLD_MS, timers, true);
  holds.add(work);
  const release = () => holds.delete(work);
  work.then(release, release);
}

let framed = false;
const frameWaiters = new Set<() => void>();

/** Called by a terminal when its first frame arrives, before the engine draws. */
export function noteTerminalFrame() {
  if (framed) return;
  framed = true;
  for (const run of [...frameWaiters]) run();
  frameWaiters.clear();
}

/**
 * Run `task` once a terminal frame is in (or startup settled): light work
 * the engine download may share the link with.
 */
export function afterTerminalFrame(
  task: () => void,
  timers: Timers = globalThis,
) {
  if (framed || settled) {
    task();
    return () => {};
  }
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    frameWaiters.delete(run);
    task();
  };
  frameWaiters.add(run);
  const cancelSettled = afterStartup(run, timers);
  return () => {
    done = true;
    frameWaiters.delete(run);
    cancelSettled();
  };
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
  framed = false;
  waiters.clear();
  frameWaiters.clear();
  holds.clear();
  for (const { timers, handle } of fallback) timers.clearTimeout(handle);
  fallback = [];
}
