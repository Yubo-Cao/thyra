import { HerdrClient } from "../bridge/herdr-client";
import { loadServerConfig } from "../config/server-config";
import {
  detectHerdrSetup,
  type HerdrSetupGuard,
  type HerdrSetupResult,
  type HerdrSetupState,
  setupHerdr,
} from "./bootstrap";
import {
  HERDR_SERVICE_LABEL,
  herdrServiceStatus,
  uninstallHerdrService,
} from "./service";
import { VERIFIED_HERDR_VERSION } from "./release";

function herdrHelp(): string {
  return `Install and start the local Herdr server.

Usage:
  thyra herdr setup
  thyra herdr status
  thyra herdr uninstall

Setup installs the Thyra-verified Herdr ${VERIFIED_HERDR_VERSION} release
when no herdr binary is found, then installs and starts a user service running
\`herdr server\` (systemd user service on Linux, launchd LaunchAgent on macOS,
per-user Task Scheduler task on Windows). An existing herdr binary is used as
is and never replaced. On macOS, a Herdr build that supports
\`herdr server --adopt\` stays supervised across live handoffs, and setup moves
a running server that launchd does not supervise under the LaunchAgent through
a live handoff, keeping its panes. Status prints the detected state. Uninstall stops and
removes only the service that setup created, which ends that server's panes;
it keeps the Herdr binary and Herdr's own data.
`;
}

export interface HerdrCommandDeps {
  loadConfig?: typeof loadServerConfig;
  detect?: () => Promise<HerdrSetupState>;
  setup?: () => Promise<HerdrSetupResult>;
  serviceStatus?: () => { installed: boolean; active: boolean };
  uninstallService?: () => { removed: boolean; definition: string };
  log?: (message: string) => void;
  error?: (message: string) => void;
}

// loadServerConfig parses process.argv strictly, so remove the herdr words
// first. Guarded so tests (and unusual argv layouts) never mutate argv.
function stripHerdrArgv(action: string) {
  if (process.argv[2] === "herdr" && process.argv[3] === action) {
    process.argv.splice(2, 2);
  }
}

/**
 * Handle `thyra herdr ...`. Returns null when argv is not a herdr command,
 * matching the runServiceCommand convention.
 */
export async function runHerdrCommand(
  args: string[],
  appVersion: string,
  dependencies: HerdrCommandDeps = {},
): Promise<number | null> {
  if (args[0] !== "herdr") return null;
  const log = dependencies.log ?? console.log;
  const error = dependencies.error ?? console.error;
  const action = args[1];
  if (
    args.length === 1 ||
    action === "help" ||
    action === "--help" ||
    action === "-h"
  ) {
    log(herdrHelp());
    return 0;
  }
  if (action === "uninstall") {
    try {
      const result = (dependencies.uninstallService ?? uninstallHerdrService)();
      log(
        result.removed
          ? `Removed the Thyra-managed Herdr service: ${result.definition}`
          : `No Thyra-managed Herdr service found: ${result.definition}`,
      );
      return 0;
    } catch (cause) {
      error(`thyra herdr: ${(cause as Error).message}`);
      return 1;
    }
  }
  if (action !== "setup" && action !== "status") {
    error(`unknown herdr action: ${action}`);
    error("Run `thyra herdr --help` for usage.");
    return 1;
  }

  try {
    stripHerdrArgv(action);
    const loadConfig = dependencies.loadConfig ?? loadServerConfig;
    const config = loadConfig(appVersion);
    const guard: HerdrSetupGuard = {
      sshHost: config.sshHost,
      session: config.session,
      hasExplicitSocketPath: config.hasExplicitSocketPath,
      hasExplicitClientSocketPath: config.hasExplicitClientSocketPath,
    };
    const ping = () => new HerdrClient(config.socketPath).ping();
    const detect =
      dependencies.detect ?? (() => detectHerdrSetup({ guard, ping }));
    const serviceStatus = dependencies.serviceStatus ?? herdrServiceStatus;

    if (action === "status") {
      const state = await detect();
      if (state.state === "running") {
        log(
          `Herdr is running (version ${state.version}, protocol ${state.protocol}).`,
        );
      } else if (state.state === "installed") {
        log(`Herdr is installed but not running: ${state.binaryPath}`);
        log("Run `thyra herdr setup` to start it as a user service.");
      } else {
        log("Herdr is not installed.");
        log(
          `Run \`thyra herdr setup\` to install the verified Herdr ${VERIFIED_HERDR_VERSION} and start it.`,
        );
      }
      const service = serviceStatus();
      log(
        `Managed service: ${
          service.installed
            ? service.active
              ? "installed, active"
              : "installed, inactive"
            : "not installed"
        }`,
      );
      return 0;
    }

    const setup =
      dependencies.setup ?? (() => setupHerdr({ guard, ping, adopt: true }));
    const result = await setup();
    if (result.outcome === "already-running") {
      log(
        `Herdr is already running (version ${result.version}, protocol ${result.protocol}).`,
      );
      if (result.unsupervised) {
        log(`It is not supervised by launchd: ${result.unsupervised}.`);
      }
    } else {
      log(
        result.outcome === "adopted"
          ? `Moved the running Herdr ${result.version} under launchd (${HERDR_SERVICE_LABEL}) through a live handoff; its panes kept running.`
          : result.outcome === "started"
            ? `Started Herdr ${result.version} as a user service.`
            : `Installed Herdr ${result.version} and started it as a user service.`,
      );
      log(`Binary: ${result.binaryPath}`);
    }
    return 0;
  } catch (cause) {
    error(`thyra herdr: ${(cause as Error).message}`);
    error("Run `thyra herdr --help` for usage.");
    return 1;
  }
}
