import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { HerdrClient } from "../bridge/herdr-client";
import { assertSupportedHerdrProtocol } from "../bridge/protocol-compat";
import { herdrManagedBinaryPath, installVerifiedHerdr } from "./release";
import {
  type CaptureCommand,
  herdrLaunchdServiceLoaded,
  type HerdrSupervision,
  installHerdrService,
  probeHerdrSupervision,
} from "./service";

export type HerdrSetupState =
  | {
      state: "running";
      version: string;
      protocol: number;
      liveHandoff?: boolean;
    }
  | { state: "installed"; binaryPath: string }
  | { state: "missing" };

export type HerdrSetupResult =
  | {
      outcome: "already-running";
      version: string;
      protocol: number;
      /** Why a running server was left outside launchd, if it was. */
      unsupervised?: string;
    }
  | {
      outcome: "started" | "installed-and-started" | "adopted";
      binaryPath: string;
      version: string;
      protocol: number;
    };

/** Settings that make a thyra-managed Herdr impossible or ambiguous. */
export interface HerdrSetupGuard {
  sshHost?: string;
  session?: string;
  hasExplicitSocketPath?: boolean;
  hasExplicitClientSocketPath?: boolean;
}

export interface HerdrBootstrapDeps {
  guard?: HerdrSetupGuard;
  platform?: string;
  arch?: string;
  homeDir?: string;
  appDataDir?: string;
  pathEnv?: string;
  ping?: () => Promise<{
    version: string;
    protocol: number;
    capabilities?: { live_handoff?: boolean };
  }>;
  installRelease?: () => Promise<{ binaryPath: string }>;
  installService?: (binaryPath: string, options?: { adopt?: boolean }) => void;
  /**
   * macOS only: move a running server that launchd does not supervise under
   * the managed LaunchAgent through a live handoff (`herdr server --adopt`).
   */
  adopt?: boolean;
  launchdServiceLoaded?: () => boolean;
  probeSupervision?: (binaryPath: string) => HerdrSupervision | null;
  capture?: CaptureCommand;
  adoptTimeoutMs?: number;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function assertManagedSetupAllowed(guard: HerdrSetupGuard = {}): void {
  if (guard.sshHost) {
    throw new Error(
      "managed Herdr setup is only available for the local Herdr server, not SSH connections",
    );
  }
  if (guard.session) {
    throw new Error(
      "managed Herdr setup only supports the default Herdr session; start `herdr server` yourself for a named session",
    );
  }
  if (guard.hasExplicitSocketPath || guard.hasExplicitClientSocketPath) {
    throw new Error(
      "managed Herdr setup only supports the default Herdr socket paths; start `herdr server` yourself with your custom paths",
    );
  }
}

export function findHerdrBinary(
  deps: Pick<
    HerdrBootstrapDeps,
    "platform" | "homeDir" | "appDataDir" | "pathEnv"
  > = {},
): string | null {
  const platform = deps.platform ?? process.platform;
  const homeDir = deps.homeDir ?? homedir();
  const executable = platform === "win32" ? "herdr.exe" : "herdr";

  // 1. Whatever the user already has on PATH.
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? "";
  for (const directory of pathEnv.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, executable);
    if (existsSync(candidate)) return candidate;
  }

  // 2. Install locations: the official Unix default (~/.local/bin), or
  //    Thyra's managed directory on Windows.
  const managed = herdrManagedBinaryPath(
    homeDir,
    deps.appDataDir ?? process.env.APPDATA,
    platform,
  );
  if (existsSync(managed)) return managed;
  return null;
}

export async function detectHerdrSetup(
  deps: HerdrBootstrapDeps = {},
): Promise<HerdrSetupState> {
  const ping = deps.ping ?? (() => new HerdrClient(defaultSocketPath()).ping());
  try {
    const info = await ping();
    if (
      info &&
      typeof info.version === "string" &&
      typeof info.protocol === "number"
    ) {
      return {
        state: "running",
        version: info.version,
        protocol: info.protocol,
        liveHandoff: info.capabilities?.live_handoff === true,
      };
    }
  } catch {
    // Herdr is not reachable; fall through to binary detection.
  }
  const binaryPath = findHerdrBinary(deps);
  return binaryPath ? { state: "installed", binaryPath } : { state: "missing" };
}

/**
 * Waits until the launchd job has handed the running server's panes to a
 * successor and is supervising it. Adoption is a live handoff, so it may take
 * as long as one (the source allows 30 s per stage).
 */
async function waitForAdoption(
  binaryPath: string,
  deps: HerdrBootstrapDeps,
  probe: (binaryPath: string) => HerdrSupervision | null,
  ping: NonNullable<HerdrBootstrapDeps["ping"]>,
  sleep: (ms: number) => Promise<void>,
): Promise<HerdrSetupResult> {
  const timeoutMs = deps.adoptTimeoutMs ?? 90_000;
  const intervalMs = deps.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const supervision = probe(binaryPath);
    const server = supervision?.server;
    if (
      supervision?.supervisor_pid &&
      server?.state === "running" &&
      server.alive &&
      server.pid !== supervision.supervisor_pid
    ) {
      try {
        const info = await ping();
        assertSupportedHerdrProtocol(info?.protocol);
        return {
          outcome: "adopted",
          binaryPath,
          version: info.version,
          protocol: info.protocol,
        };
      } catch {
        // The successor may still be binding its sockets.
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  throw new Error(
    `launchd did not adopt the running Herdr server within ${Math.round(timeoutMs / 1000)}s; it keeps running unsupervised. See ~/Library/Logs/thyra-herdr.stderr.log`,
  );
}

function defaultSocketPath(): string {
  return join(homedir(), ".config", "herdr", "herdr.sock");
}

/**
 * Make the local Herdr server reachable: install the verified release when no
 * binary exists, then install and start the user service running
 * `herdr server`, and wait until the socket answers.
 */
export async function setupHerdr(
  deps: HerdrBootstrapDeps = {},
): Promise<HerdrSetupResult> {
  assertManagedSetupAllowed(deps.guard);
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ping = deps.ping ?? (() => new HerdrClient(defaultSocketPath()).ping());

  const state = await detectHerdrSetup({ ...deps, ping });
  const platform = deps.platform ?? process.platform;
  const probe =
    deps.probeSupervision ??
    ((path: string) => probeHerdrSupervision(path, deps.capture));
  const installService =
    deps.installService ??
    ((path: string, options: { adopt?: boolean } = {}) =>
      installHerdrService(path, {
        homeDir: deps.homeDir,
        appDataDir: deps.appDataDir,
        adopt: options.adopt,
      }));

  if (state.state === "running") {
    const alreadyRunning = (unsupervised?: string): HerdrSetupResult => ({
      outcome: "already-running",
      version: state.version,
      protocol: state.protocol,
      ...(unsupervised ? { unsupervised } : {}),
    });
    if (platform !== "darwin") return alreadyRunning();
    const loaded = (
      deps.launchdServiceLoaded ??
      (() => herdrLaunchdServiceLoaded({ homeDir: deps.homeDir }))
    )();
    if (loaded) return alreadyRunning();
    if (!deps.adopt) {
      return alreadyRunning(
        "launchd does not supervise it; run `thyra herdr setup` to adopt it",
      );
    }
    const binaryPath = findHerdrBinary(deps);
    if (!binaryPath) return alreadyRunning("no herdr binary found to adopt it");
    if (!state.liveHandoff) {
      return alreadyRunning(
        "the running server does not support live handoff; restart it to put it under launchd",
      );
    }
    if (!probe(binaryPath)) {
      return alreadyRunning(
        `${binaryPath} does not support \`herdr server --adopt\`; install the Thyra Herdr build to adopt it`,
      );
    }
    installService(binaryPath, { adopt: true });
    return await waitForAdoption(binaryPath, deps, probe, ping, sleep);
  }

  const binaryPath =
    state.state === "installed"
      ? state.binaryPath
      : (await (deps.installRelease ?? (() => installVerifiedHerdr(deps)))())
          .binaryPath;
  // A build that supports `--adopt` stays supervised across live handoffs.
  const adopt = platform === "darwin" && Boolean(probe(binaryPath));
  installService(binaryPath, { adopt });

  const timeoutMs = deps.startTimeoutMs ?? 15000;
  const intervalMs = deps.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  for (;;) {
    try {
      const info = await ping();
      assertSupportedHerdrProtocol(info?.protocol);
      return {
        outcome:
          state.state === "installed" ? "started" : "installed-and-started",
        binaryPath,
        version: info.version,
        protocol: info.protocol,
      };
    } catch (error) {
      lastError = error as Error;
      if (Date.now() >= deadline) break;
      await sleep(intervalMs);
    }
  }
  throw new Error(
    `Herdr service was installed but the server did not become reachable within ${Math.round(timeoutMs / 1000)}s: ${lastError?.message ?? "timeout"}`,
  );
}
