import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootoutLaunchdService,
  bootstrapLaunchdService,
  LAUNCHD_BOOTSTRAP_IO_ERROR,
  replaceLaunchdService,
  waitForLaunchdServiceGone,
} from "./launchd";
import { type RunCommand, runServiceCommand } from "./service-manager";

const SERVICE = "gui/501/dev.thyra";
const tempDirs: string[] = [];

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "thyra-launchd-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

/**
 * A `launchctl` stand-in with launchd's teardown race: `bootout` returns
 * while the job is still listed for FAKE_UNLOAD_POLLS more `print` calls, and
 * `bootstrap` fails with error 5 while the label is listed (or while the
 * `eio` counter lasts).
 */
const FAKE_LAUNCHCTL = `#!/bin/sh
s="$FAKE_LAUNCHCTL_STATE"
echo "$*" >> "$s/calls"
count() { cat "$s/$1" 2>/dev/null || echo 0; }
case "$1" in
  print)
    [ -f "$s/loaded" ] || { echo "Bad request. Could not find service" >&2; exit 113; }
    n=$(count unloading)
    if [ "$n" -gt 0 ]; then
      echo $((n - 1)) > "$s/unloading"
      [ "$n" -eq 1 ] && rm -f "$s/loaded"
    fi
    echo "state = running"
    exit 0 ;;
  bootout)
    [ -f "$s/loaded" ] || exit 113
    polls="\${FAKE_UNLOAD_POLLS:-0}"
    echo "$polls" > "$s/unloading"
    [ "$polls" -eq 0 ] && rm -f "$s/loaded"
    exit 0 ;;
  bootstrap)
    n=$(count eio)
    if [ -f "$s/loaded" ] || [ "$n" -gt 0 ]; then
      [ "$n" -gt 0 ] && echo $((n - 1)) > "$s/eio"
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    touch "$s/loaded"
    exit 0 ;;
esac
exit 64
`;

interface FakeLaunchctl {
  state: string;
  calls: () => string[];
  /** Runs `launchctl ...` through the fake executable in a real process. */
  runCommand: (env?: Record<string, string>) => RunCommand;
}

function fakeLaunchctl(): FakeLaunchctl {
  const root = tempDir();
  const executable = join(root, "launchctl");
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(executable, FAKE_LAUNCHCTL);
  chmodSync(executable, 0o755);
  return {
    state,
    calls: () => {
      try {
        return readFileSync(join(state, "calls"), "utf8").trim().split("\n");
      } catch {
        return [];
      }
    },
    runCommand: (env = {}) => {
      return (argv) => {
        expect(argv[0]).toBe("launchctl");
        const result = Bun.spawnSync([executable, ...argv.slice(1)], {
          env: { ...process.env, FAKE_LAUNCHCTL_STATE: state, ...env },
          stdout: "ignore",
          stderr: "ignore",
        });
        return result.exitCode ?? 1;
      };
    },
  };
}

describe("fake launchctl reproduces the reinstall race", () => {
  test("bootstrapping right after bootout fails with error 5", () => {
    const launchctl = fakeLaunchctl();
    writeFileSync(join(launchctl.state, "loaded"), "");
    const run = launchctl.runCommand({ FAKE_UNLOAD_POLLS: "2" });
    const codes = [
      run(["launchctl", "bootout", SERVICE]),
      run(["launchctl", "bootstrap", "gui/501", "/tmp/x.plist"]),
    ];
    expect(codes).toEqual([0, LAUNCHD_BOOTSTRAP_IO_ERROR]);
  });
});

describe("thyra service install on launchd", () => {
  function install(launchctl: FakeLaunchctl, env: Record<string, string>) {
    const homeDir = tempDir();
    const sleeps: number[] = [];
    const errors: string[] = [];
    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "darwin",
        homeDir,
        execPath: "/opt/thyra-test/bin/thyra",
        argv: ["/opt/thyra-test/bin/thyra"],
        uid: 501,
      },
      runCommand: launchctl.runCommand(env),
      log: () => undefined,
      error: (message) => errors.push(message),
      launchd: { sleep: (ms) => sleeps.push(ms), unloadTimeoutMs: 2_000 },
    });
    return { code, sleeps, errors, homeDir };
  }

  test("waits for the old job to unload before bootstrapping the new one", () => {
    const launchctl = fakeLaunchctl();
    writeFileSync(join(launchctl.state, "loaded"), "");
    const { code, sleeps } = install(launchctl, { FAKE_UNLOAD_POLLS: "3" });
    expect(code).toBe(0);
    const calls = launchctl.calls();
    expect(calls.map((call) => call.split(" ")[0])).toEqual([
      "print",
      "bootout",
      "print",
      "print",
      "print",
      "print",
      "bootstrap",
    ]);
    expect(calls.filter((call) => call.startsWith("bootstrap"))).toHaveLength(
      1,
    );
    // Exponential backoff between polls.
    expect(sleeps).toEqual([50, 100, 200]);
  });

  test("retries a bootstrap that launchd rejects with error 5", () => {
    const launchctl = fakeLaunchctl();
    writeFileSync(join(launchctl.state, "eio"), "2");
    const { code, sleeps } = install(launchctl, {});
    expect(code).toBe(0);
    const bootstraps = launchctl
      .calls()
      .filter((call) => call.startsWith("bootstrap"));
    expect(bootstraps).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
  });

  test("gives up after a bounded number of error-5 bootstraps", () => {
    const launchctl = fakeLaunchctl();
    writeFileSync(join(launchctl.state, "eio"), "100");
    const { code } = install(launchctl, {});
    expect(code).toBe(LAUNCHD_BOOTSTRAP_IO_ERROR);
    expect(
      launchctl.calls().filter((call) => call.startsWith("bootstrap")),
    ).toHaveLength(5);
  });

  test("reports a job that never unloads instead of bootstrapping over it", () => {
    const launchctl = fakeLaunchctl();
    writeFileSync(join(launchctl.state, "loaded"), "");
    const { code, errors, sleeps } = install(launchctl, {
      FAKE_UNLOAD_POLLS: "100000",
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("still lists gui/501/dev.thyra");
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(2_000);
    expect(launchctl.calls().some((call) => call.startsWith("bootstrap"))).toBe(
      false,
    );
  });
});

describe("launchd helpers", () => {
  test("waiting for unload is bounded and backs off to one second", () => {
    const sleeps: number[] = [];
    const gone = waitForLaunchdServiceGone(SERVICE, () => 0, {
      sleep: (ms) => sleeps.push(ms),
      unloadTimeoutMs: 3_000,
    });
    expect(gone).toBe(false);
    expect(sleeps).toEqual([50, 100, 200, 400, 800, 1000, 450]);
  });

  test("a failed bootout is returned without waiting", () => {
    const commands: string[][] = [];
    const code = bootoutLaunchdService(SERVICE, (argv) => {
      commands.push(argv);
      return 3;
    });
    expect(code).toBe(3);
    expect(commands).toEqual([["launchctl", "bootout", SERVICE]]);
  });

  test("other bootstrap failures are not retried", () => {
    let bootstraps = 0;
    const code = bootstrapLaunchdService(
      "gui/501",
      SERVICE,
      "/tmp/x.plist",
      (argv) => {
        if (argv[1] === "bootstrap") bootstraps += 1;
        return argv[1] === "bootstrap" ? 37 : 113;
      },
      { sleep: () => undefined },
    );
    expect(code).toBe(37);
    expect(bootstraps).toBe(1);
  });

  test("an unloaded job is bootstrapped without a bootout", () => {
    const commands: string[][] = [];
    const code = replaceLaunchdService(
      "gui/501",
      SERVICE,
      "/tmp/x.plist",
      (argv) => {
        commands.push(argv);
        return argv[1] === "print" ? 113 : 0;
      },
    );
    expect(code).toBe(0);
    expect(commands.map((argv) => argv[1])).toEqual(["print", "bootstrap"]);
  });
});
