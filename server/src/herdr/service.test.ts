import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  HERDR_SERVICE_LABEL,
  HERDR_SERVICE_MARKER,
  herdrServiceStatus,
  installHerdrService,
  probeHerdrSupervision,
  renderHerdrLaunchdService,
  renderHerdrSystemdService,
  renderHerdrWindowsTask,
  resolveHerdrServicePaths,
  uninstallHerdrService,
} from "./service";

const trash: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "thyra-herdr-service-"));
  trash.push(dir);
  return dir;
}
afterEach(() => {
  while (trash.length) {
    const dir = trash.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveHerdrServicePaths", () => {
  test("uses per-platform user service locations", () => {
    const homeDir = scratch();
    expect(resolveHerdrServicePaths("systemd", homeDir).definition).toBe(
      join(homeDir, ".config", "systemd", "user", "thyra-herdr.service"),
    );
    const launchd = resolveHerdrServicePaths("launchd", homeDir);
    expect(launchd.definition).toBe(
      join(homeDir, "Library", "LaunchAgents", `${HERDR_SERVICE_LABEL}.plist`),
    );
    expect(launchd.stdoutLog).toContain("thyra-herdr.stdout.log");
    const windows = resolveHerdrServicePaths(
      "windows-task",
      "C:\\test-home",
      "C:\\test-home\\AppData\\Roaming",
    );
    expect(windows.definition).toContain("herdr-task.ps1");
    expect(windows.taskName).toStartWith(`${HERDR_SERVICE_LABEL}-`);
  });
});

describe("service definition renderers", () => {
  test("systemd runs `herdr server` with restart supervision", () => {
    const unit = renderHerdrSystemdService("/opt/herdr bin/herdr");
    expect(unit).toContain(HERDR_SERVICE_MARKER);
    expect(unit).toContain("ExecStart=/opt/herdr\\x20bin/herdr server");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("launchd keeps the server alive with log files", () => {
    const plist = renderHerdrLaunchdService(
      "/usr/local/bin/herdr",
      resolveHerdrServicePaths("launchd", scratch()),
    );
    expect(plist).toContain(HERDR_SERVICE_MARKER);
    expect(plist).toContain(`<string>${HERDR_SERVICE_LABEL}</string>`);
    expect(plist).toContain("<string>/usr/local/bin/herdr</string>");
    expect(plist).toContain("<string>server</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });

  test("windows task starts herdr server at logon from its install directory", () => {
    const script = renderHerdrWindowsTask("C:\\herdr\\herdr.exe", {
      definition: "C:\\cfg\\herdr-task.ps1",
      taskName: "dev.thyra.herdr-abc123",
    });
    expect(script).toContain(HERDR_SERVICE_MARKER);
    expect(script).toContain("$taskName = 'dev.thyra.herdr-abc123'");
    expect(script).toContain("-Execute 'C:\\herdr\\herdr.exe'");
    expect(script).toContain("-Argument 'server'");
    expect(script).toContain("-WorkingDirectory 'C:\\herdr'");
  });
});

describe("installHerdrService", () => {
  test("writes the unit and runs the systemd activation sequence", () => {
    const homeDir = scratch();
    const commands: string[][] = [];
    const paths = installHerdrService("/opt/herdr/herdr", {
      platform: "systemd",
      homeDir,
      runCommand: (argv) => {
        commands.push(argv);
        return 0;
      },
    });
    expect(readFileSync(paths.definition, "utf8")).toContain(
      "ExecStart=/opt/herdr/herdr server",
    );
    expect(commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "thyra-herdr.service"],
      ["systemctl", "--user", "restart", "thyra-herdr.service"],
    ]);
  });

  test("replaces a loaded launchd service only after it has unloaded", () => {
    const homeDir = scratch();
    const commands: string[][] = [];
    const sleeps: number[] = [];
    // launchd keeps listing the job for two polls after bootout returns.
    let listedAfterBootout = -1;
    const paths = installHerdrService("/usr/local/bin/herdr", {
      platform: "launchd",
      homeDir,
      uid: 501,
      launchd: { sleep: (ms) => sleeps.push(ms) },
      runCommand: (argv) => {
        commands.push(argv);
        if (argv[1] === "bootout") listedAfterBootout = 2;
        if (argv[1] !== "print") return 0;
        if (listedAfterBootout < 0) return 0;
        return listedAfterBootout-- > 0 ? 0 : 113;
      },
    });
    const service = `gui/501/${HERDR_SERVICE_LABEL}`;
    expect(commands).toEqual([
      ["launchctl", "print", service],
      ["launchctl", "bootout", service],
      ["launchctl", "print", service],
      ["launchctl", "print", service],
      ["launchctl", "print", service],
      ["launchctl", "bootstrap", "gui/501", paths.definition],
    ]);
    expect(sleeps).toEqual([50, 100]);
  });

  test("launchd runs --adopt with restart only after a failure when supported", () => {
    const homeDir = scratch();
    const paths = installHerdrService("/usr/local/bin/herdr", {
      platform: "launchd",
      homeDir,
      uid: 501,
      adopt: true,
      runCommand: (argv) => (argv[1] === "print" ? 113 : 0),
    });
    const plist = readFileSync(paths.definition, "utf8");
    expect(plist).toContain(
      "<string>server</string>\n    <string>--adopt</string>",
    );
    expect(plist).toContain(
      "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>",
    );
  });

  test("fails when an activation command fails", () => {
    const homeDir = scratch();
    expect(() =>
      installHerdrService("/opt/herdr/herdr", {
        platform: "systemd",
        homeDir,
        runCommand: () => 1,
      }),
    ).toThrow("systemd daemon-reload failed (exit 1)");
  });

  test("refuses to replace a definition not generated by thyra", () => {
    const homeDir = scratch();
    const paths = resolveHerdrServicePaths("systemd", homeDir);
    mkdirSync(dirname(paths.definition), { recursive: true });
    writeFileSync(
      paths.definition,
      "[Service]\nExecStart=/custom/herdr server\n",
    );
    expect(() =>
      installHerdrService("/opt/herdr/herdr", {
        platform: "systemd",
        homeDir,
        runCommand: () => 0,
      }),
    ).toThrow("was not generated by thyra");
  });
});

describe("herdrServiceStatus", () => {
  test("only running Windows tasks are active", () => {
    const homeDir = scratch();
    const appDataDir = scratch();
    const paths = resolveHerdrServicePaths("windows-task", homeDir, appDataDir);
    mkdirSync(dirname(paths.definition), { recursive: true });
    writeFileSync(paths.definition, HERDR_SERVICE_MARKER);
    for (const code of [0, 4, 3, 5]) {
      expect(
        herdrServiceStatus({
          platform: "windows-task",
          homeDir,
          appDataDir,
          runCommand: () => code,
        }),
      ).toEqual({ installed: true, active: code === 0 });
    }
  });

  test("reports systemd installation and activity", () => {
    const homeDir = scratch();
    const paths = resolveHerdrServicePaths("systemd", homeDir);
    expect(
      herdrServiceStatus({ platform: "systemd", homeDir, runCommand: () => 1 }),
    ).toEqual({ installed: false, active: false });
    mkdirSync(dirname(paths.definition), { recursive: true });
    writeFileSync(paths.definition, HERDR_SERVICE_MARKER);
    expect(
      herdrServiceStatus({ platform: "systemd", homeDir, runCommand: () => 0 }),
    ).toEqual({ installed: true, active: true });
  });
});

describe("uninstallHerdrService", () => {
  test("stops and removes a generated systemd unit", () => {
    const homeDir = scratch();
    const paths = resolveHerdrServicePaths("systemd", homeDir);
    mkdirSync(dirname(paths.definition), { recursive: true });
    writeFileSync(paths.definition, renderHerdrSystemdService("/x/herdr"));
    const commands: string[][] = [];
    const result = uninstallHerdrService({
      platform: "systemd",
      homeDir,
      runCommand: (argv) => {
        commands.push(argv);
        return 0;
      },
    });
    expect(result).toEqual({ removed: true, definition: paths.definition });
    expect(existsSync(paths.definition)).toBe(false);
    expect(commands).toEqual([
      ["systemctl", "--user", "disable", "--now", "thyra-herdr.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
  });

  test("is a no-op without a generated definition", () => {
    const homeDir = scratch();
    const commands: string[][] = [];
    for (const platform of ["systemd", "launchd"] as const) {
      expect(
        uninstallHerdrService({
          platform,
          homeDir,
          uid: 501,
          runCommand: (argv) => {
            commands.push(argv);
            return 0;
          },
        }).removed,
      ).toBe(false);
    }
    expect(commands).toEqual([]);
  });

  test("never removes a definition it did not generate", () => {
    const homeDir = scratch();
    const paths = resolveHerdrServicePaths("launchd", homeDir);
    mkdirSync(dirname(paths.definition), { recursive: true });
    writeFileSync(paths.definition, "<plist>custom</plist>");
    expect(() =>
      uninstallHerdrService({
        platform: "launchd",
        homeDir,
        uid: 501,
        runCommand: () => 0,
      }),
    ).toThrow("was not generated by thyra");
    expect(existsSync(paths.definition)).toBe(true);
  });

  test("boots out a loaded launchd agent before removing it", () => {
    const homeDir = scratch();
    const paths = resolveHerdrServicePaths("launchd", homeDir);
    mkdirSync(dirname(paths.definition), { recursive: true });
    writeFileSync(paths.definition, HERDR_SERVICE_MARKER);
    const commands: string[][] = [];
    let loaded = true;
    uninstallHerdrService({
      platform: "launchd",
      homeDir,
      uid: 501,
      runCommand: (argv) => {
        commands.push(argv);
        if (argv[1] === "bootout") loaded = false;
        return argv[1] === "print" && !loaded ? 113 : 0;
      },
    });
    expect(commands.map((argv) => argv[1])).toEqual([
      "print",
      "bootout",
      "print",
    ]);
    expect(existsSync(paths.definition)).toBe(false);
  });

  test("deletes only the Windows task whose definition Thyra generated", () => {
    const homeDir = scratch();
    const appDataDir = scratch();
    const paths = resolveHerdrServicePaths("windows-task", homeDir, appDataDir);
    // A task without Thyra's definition file belongs to someone else.
    expect(() =>
      uninstallHerdrService({
        platform: "windows-task",
        homeDir,
        appDataDir,
        runCommand: () => 4,
      }),
    ).toThrow("was not created by thyra");

    mkdirSync(dirname(paths.definition), { recursive: true });
    writeFileSync(paths.definition, HERDR_SERVICE_MARKER);
    const commands: string[][] = [];
    const result = uninstallHerdrService({
      platform: "windows-task",
      homeDir,
      appDataDir,
      runCommand: (argv) => {
        commands.push(argv);
        return 0;
      },
    });
    expect(result.removed).toBe(true);
    expect(commands.at(-1)).toEqual([
      "schtasks.exe",
      "/Delete",
      "/TN",
      paths.taskName ?? "",
      "/F",
    ]);
    expect(existsSync(paths.definition)).toBe(false);
  });
});

describe("probeHerdrSupervision", () => {
  test("recognizes builds that support --adopt", () => {
    const argvs: string[][] = [];
    const status = probeHerdrSupervision("/opt/herdr", (argv) => {
      argvs.push(argv);
      return {
        code: 0,
        stdout:
          '{"adopt":true,"api_socket":"/x/herdr.sock","server":{"pid":2,"state":"running","alive":true},"supervisor_pid":1}\n',
      };
    });
    expect(argvs).toEqual([["/opt/herdr", "server", "supervision"]]);
    expect(status?.supervisor_pid).toBe(1);
    expect(status?.server?.pid).toBe(2);
  });

  test("treats older builds and broken output as unsupported", () => {
    // Older builds print server help and exit 2 for unknown subcommands.
    expect(
      probeHerdrSupervision("/opt/herdr", () => ({ code: 2, stdout: "" })),
    ).toBeNull();
    expect(
      probeHerdrSupervision("/opt/herdr", () => ({ code: 0, stdout: "nope" })),
    ).toBeNull();
    expect(
      probeHerdrSupervision("/opt/herdr", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
});
