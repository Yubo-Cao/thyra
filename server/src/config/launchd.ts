import type { RunCommand } from "./service-manager";

/**
 * `launchctl bootstrap` fails with EIO (5) while launchd is still tearing
 * down an earlier instance of the same label, which `launchctl bootout` does
 * not wait for. It also reports 5 for an already-loaded label.
 */
export const LAUNCHD_BOOTSTRAP_IO_ERROR = 5;

export interface LaunchdTiming {
  /** Blocks for the given milliseconds; tests pass a recorder. */
  sleep?: (ms: number) => void;
  /** Upper bound on waiting for one job to disappear. */
  unloadTimeoutMs?: number;
  /** Bootstrap attempts in total when launchd answers with error 5. */
  bootstrapAttempts?: number;
}

// Longer than launchd's default 20 s ExitTimeOut, after which it kills the job.
const DEFAULT_UNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_BOOTSTRAP_ATTEMPTS = 5;
const FIRST_POLL_DELAY_MS = 50;
const MAX_POLL_DELAY_MS = 1_000;
const FIRST_RETRY_DELAY_MS = 250;

function timing(options: LaunchdTiming) {
  return {
    sleep: options.sleep ?? ((ms: number) => Bun.sleepSync(ms)),
    unloadTimeoutMs: options.unloadTimeoutMs ?? DEFAULT_UNLOAD_TIMEOUT_MS,
    bootstrapAttempts: Math.max(
      1,
      options.bootstrapAttempts ?? DEFAULT_BOOTSTRAP_ATTEMPTS,
    ),
  };
}

export function launchdServiceLoaded(
  service: string,
  runCommand: RunCommand,
): boolean {
  return runCommand(["launchctl", "print", service], { quiet: true }) === 0;
}

/**
 * Polls `launchctl print` with exponential backoff until the job is gone.
 * Returns false when it is still registered after the bounded wait.
 */
export function waitForLaunchdServiceGone(
  service: string,
  runCommand: RunCommand,
  options: LaunchdTiming = {},
): boolean {
  const { sleep, unloadTimeoutMs } = timing(options);
  let waited = 0;
  let delay = FIRST_POLL_DELAY_MS;
  for (;;) {
    if (!launchdServiceLoaded(service, runCommand)) return true;
    if (waited >= unloadTimeoutMs) return false;
    const step = Math.min(delay, unloadTimeoutMs - waited);
    sleep(step);
    waited += step;
    delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
  }
}

/** Stops a loaded job and waits until launchd has really removed it. */
export function bootoutLaunchdService(
  service: string,
  runCommand: RunCommand,
  options: LaunchdTiming = {},
): number {
  const code = runCommand(["launchctl", "bootout", service]);
  if (code !== 0) return code;
  if (!waitForLaunchdServiceGone(service, runCommand, options)) {
    const seconds = Math.round(timing(options).unloadTimeoutMs / 1000);
    throw new Error(
      `launchd still lists ${service} ${seconds}s after bootout; check \`launchctl print ${service}\``,
    );
  }
  return 0;
}

/**
 * Bootstraps a job, retrying a bounded number of times with backoff while
 * launchd reports error 5 because an earlier instance is still unloading.
 */
export function bootstrapLaunchdService(
  domain: string,
  service: string,
  definition: string,
  runCommand: RunCommand,
  options: LaunchdTiming = {},
): number {
  const { sleep, bootstrapAttempts } = timing(options);
  let delay = FIRST_RETRY_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    const code = runCommand(["launchctl", "bootstrap", domain, definition]);
    if (code !== LAUNCHD_BOOTSTRAP_IO_ERROR || attempt >= bootstrapAttempts) {
      return code;
    }
    waitForLaunchdServiceGone(service, runCommand, options);
    sleep(delay);
    delay = Math.min(delay * 2, MAX_POLL_DELAY_MS * 2);
  }
}

/** Replaces a (possibly loaded) job with the definition on disk. */
export function replaceLaunchdService(
  domain: string,
  service: string,
  definition: string,
  runCommand: RunCommand,
  options: LaunchdTiming = {},
): number {
  if (launchdServiceLoaded(service, runCommand)) {
    const code = bootoutLaunchdService(service, runCommand, options);
    if (code !== 0) return code;
  }
  return bootstrapLaunchdService(
    domain,
    service,
    definition,
    runCommand,
    options,
  );
}
