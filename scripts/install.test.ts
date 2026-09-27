import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPin } from "./pin-herdr";

const installer = join(import.meta.dir, "install.sh");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

/** Run installer functions without executing main. */
function lib(script: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync(["sh", "-c", `. "$INSTALLER"; ${script}`], {
    env: {
      PATH: process.env.PATH ?? "",
      INSTALLER: installer,
      THYRA_INSTALLER_LIBRARY: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString(),
  };
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("installer helpers", () => {
  test("maps OS and CPU to Thyra platforms, including Rosetta shells", () => {
    const cases: [string, string, string, string | null][] = [
      ["Linux", "x86_64", "0", "linux-x64"],
      ["Linux", "amd64", "0", "linux-x64"],
      ["Linux", "aarch64", "0", "linux-arm64"],
      ["Linux", "arm64", "0", "linux-arm64"],
      ["Darwin", "arm64", "0", "darwin-arm64"],
      ["Darwin", "x86_64", "0", "darwin-x64"],
      ["Darwin", "x86_64", "1", "darwin-arm64"],
      ["Linux", "armv7l", "0", null],
      ["FreeBSD", "amd64", "0", null],
      ["MINGW64_NT-10.0", "x86_64", "0", null],
    ];
    for (const [os, arch, rosetta, expected] of cases) {
      const result = lib(`thyra_platform ${os} ${arch} ${rosetta}`);
      expect(result.code === 0 ? result.out : null).toBe(expected);
    }
  });

  test("maps Thyra platforms to Herdr release targets", () => {
    expect(
      lib(
        "for p in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do herdr_target $p; done",
      ).out.split("\n"),
    ).toEqual([
      "linux-x86_64",
      "linux-aarch64",
      "macos-x86_64",
      "macos-aarch64",
    ]);
    expect(lib("herdr_target windows-x64").code).not.toBe(0);
  });

  test("resolves latest, versioned, and mirror base URLs", () => {
    expect(lib('release_base "" ""').out).toBe(
      "https://github.com/Yubo-Cao/thyra/releases/latest/download",
    );
    expect(lib('release_base "" 0.8.0').out).toBe(
      "https://github.com/Yubo-Cao/thyra/releases/download/v0.8.0",
    );
    expect(lib('release_base "http://127.0.0.1:9/m///" 0.8.0').out).toBe(
      "http://127.0.0.1:9/m",
    );
  });

  test("allows HTTPS and loopback HTTP mirrors only", () => {
    const allowed: [string, string][] = [
      ["https://example.com/a", "=https"],
      ["http://127.0.0.1:8000/x", "=http"],
      ["http://localhost/x", "=http"],
      ["http://[::1]:9/x", "=http"],
    ];
    for (const [url, protocol] of allowed) {
      expect(lib(`curl_protocol '${url}'`).out).toBe(protocol);
    }
    for (const url of [
      "http://downloads.example.com/x",
      "http://127.0.0.1.example.com/x",
      "https://user:pw@example.com/x",
      "https://example.com/x?y=1",
      "https://example.com/x#y",
      "ftp://example.com/x",
      "file:///tmp/x",
    ]) {
      expect(lib(`curl_protocol '${url}'`).code, url).not.toBe(0);
    }
  });

  test("accepts checksum files only for the expected asset", () => {
    const root = scratch("thyra-installer-sum-");
    const digest = "A".repeat(64);
    const cases: [string, string | null][] = [
      [`${digest}  thyra-linux-x64.tar.xz\n`, digest.toLowerCase()],
      [`${digest}  ../../thyra-linux-x64.tar.xz\n`, null],
      [`${digest}  other.tar.xz\n`, null],
      [`${"g".repeat(64)}  thyra-linux-x64.tar.xz\n`, null],
      [`${digest.slice(1)}  thyra-linux-x64.tar.xz\n`, null],
      [`${digest}  thyra-linux-x64.tar.xz extra\n`, null],
      ["", null],
    ];
    for (const [content, expected] of cases) {
      writeFileSync(join(root, "sum"), content);
      const result = lib(
        `checksum_from_file "$ROOT/sum" thyra-linux-x64.tar.xz`,
        { ROOT: root },
      );
      expect(result.code === 0 ? result.out : null, content).toBe(expected);
    }
  });

  test("reads the pin that pin-herdr.ts renders", () => {
    const root = scratch("thyra-installer-pin-");
    const pin = join(root, "herdr-release.json");
    writeFileSync(
      pin,
      renderPin({
        repository: "Yubo-Cao/herdr",
        tag: "v0.9.1-thyra.1",
        version: "0.9.1",
        protocol: 22,
        sha256: {
          "linux-x86_64": "a".repeat(64),
          "macos-aarch64": "B".repeat(64),
        },
      }),
    );
    const read = (script: string) => lib(script, { PIN: pin }).out;
    expect(read('pin_value "$PIN" repository')).toBe("Yubo-Cao/herdr");
    expect(read('pin_value "$PIN" tag')).toBe("v0.9.1-thyra.1");
    expect(read('pin_value "$PIN" version')).toBe("0.9.1");
    expect(read('pin_value "$PIN" protocol')).toBe("22");
    expect(read('pin_sha256 "$PIN" linux-x86_64')).toBe("a".repeat(64));
    expect(read('pin_sha256 "$PIN" macos-aarch64')).toBe("b".repeat(64));
    expect(read('pin_sha256 "$PIN" linux-aarch64')).toBe("");
  });

  test("never replaces a Herdr binary it did not install", () => {
    const pinned = "p";
    const cases: [string, string, string, string, string][] = [
      // installed, recorded, other-on-PATH, replace -> action
      ["-", "-", "0", "0", "install"],
      ["-", "-", "1", "0", "keep"],
      ["-", "-", "1", "1", "install"],
      [pinned, "-", "0", "0", "current"],
      ["old", "old", "0", "0", "upgrade"],
      ["custom", "old", "0", "0", "keep"],
      ["custom", "-", "0", "0", "keep"],
      ["custom", "-", "0", "1", "replace"],
    ];
    for (const [installed, recorded, other, replace, action] of cases) {
      expect(
        lib(
          `herdr_action ${installed} ${recorded} ${pinned} ${other} ${replace}`,
        ).out,
      ).toBe(action);
    }
  });

  test("reads and edits service environment values in place", () => {
    const root = scratch("thyra-installer-env-");
    const file = join(root, "thyra.env");
    writeFileSync(
      file,
      "# HOST=example\nHOST=0.0.0.0\nexport PORT='9000'\nTHYRA_LOG_LEVEL=debug\n",
    );
    const env = { FILE: file };
    expect(lib('env_value "$FILE" HOST', env).out).toBe("0.0.0.0");
    expect(lib('env_value "$FILE" PORT', env).out).toBe("9000");
    expect(lib('env_value "$FILE" MISSING', env).out).toBe("");
    lib('set_env_value "$FILE" PORT 8123; set_env_value "$FILE" NEW 1', env);
    expect(readFileSync(file, "utf8")).toBe(
      "# HOST=example\nHOST=0.0.0.0\nPORT=8123\nTHYRA_LOG_LEVEL=debug\nNEW=1\n",
    );
  });
});

function currentReleasePlatform(): string {
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : null;
  const arch =
    process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  if (!os || !arch) throw new Error("unsupported test platform");
  return `${os}-${arch}`;
}

function herdrTargetFor(platform: string): string {
  return {
    "linux-x64": "linux-x86_64",
    "linux-arm64": "linux-aarch64",
    "darwin-x64": "macos-x86_64",
    "darwin-arm64": "macos-aarch64",
  }[platform]!;
}

interface Fixture {
  root: string;
  assets: string;
  fakeBin: string;
  home: string;
  installDir: string;
  log: string;
  herdrTarget: string;
}

function writeHerdrRelease(fixture: Fixture, body: string) {
  const asset = join(fixture.assets, `herdr-${fixture.herdrTarget}`);
  writeFileSync(asset, body, { mode: 0o755 });
  writeFileSync(
    join(fixture.assets, "herdr-release.json"),
    renderPin({
      repository: "Yubo-Cao/herdr",
      tag: "v0.9.1-thyra.1",
      version: "0.9.1",
      protocol: 22,
      sha256: { [fixture.herdrTarget]: sha256(body) },
    }),
  );
}

const HERDR_V1 = '#!/bin/sh\necho "herdr 0.9.1"\n';
const HERDR_V2 = '#!/bin/sh\necho "herdr 0.9.1" # rebuilt\n';

const SYSTEM_TOOLS = [
  "awk",
  "basename",
  "cat",
  "chmod",
  "cp",
  "dirname",
  "install",
  "mkdir",
  "mktemp",
  "mv",
  "rm",
  "sh",
  "sha256sum",
  "shasum",
  "sleep",
  "sysctl",
  "tar",
  "uname",
  "xz",
];

function createFixture(checksumName?: string): Fixture {
  const root = scratch("thyra-installer-test-");
  const assets = join(root, "assets");
  const fakeBin = join(root, "bin");
  const home = join(root, "home");
  const installDir = join(home, ".local", "bin");
  const log = join(root, "thyra-calls.log");
  const platform = currentReleasePlatform();
  const packageDir = `thyra-${platform}`;
  const archiveName = `${packageDir}.tar.xz`;
  mkdirSync(join(assets, packageDir), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(home, { recursive: true });

  // The fake Thyra logs every non-version command for assertions.
  writeFileSync(
    join(assets, packageDir, "thyra"),
    `#!/bin/sh\n[ "\${1:-}" = "--version" ] && { echo "thyra 9.8.7"; exit 0; }\necho "$*" >> "$THYRA_CALLS"\nexit 0\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(assets, packageDir, "VERSION"),
    `thyra 9.8.7 ${platform}\n`,
  );
  const archive = join(assets, archiveName);
  const packaged = Bun.spawnSync(
    ["tar", "-C", assets, "-cJf", archive, packageDir],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, stderr: "pipe" },
  );
  if (packaged.exitCode !== 0) throw new Error(packaged.stderr.toString());
  writeFileSync(
    `${archive}.sha256`,
    `${sha256(readFileSync(archive))}  ${checksumName ?? archiveName}\n`,
  );

  // Serve files by basename; loopback probes ending in "/" are refused.
  writeFileSync(
    join(fakeBin, "curl"),
    `#!/bin/sh
set -eu
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --proto|--proto-redir|--max-filesize|--retry|--connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */) exit 7 ;;
  */healthz) exit 0 ;;
esac
[ -f "$FIXTURE_DIR/\${url##*/}" ] || exit 22
cp "$FIXTURE_DIR/\${url##*/}" "$out"
`,
    { mode: 0o755 },
  );
  // Never reach the real systemd user manager from tests.
  writeFileSync(join(fakeBin, "systemctl"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  chmodSync(join(fakeBin, "curl"), 0o755);
  // Expose only the tools the installer needs, so a Herdr installed on the
  // test machine never appears on PATH.
  for (const tool of SYSTEM_TOOLS) {
    const path = Bun.which(tool);
    if (path) symlinkSync(path, join(fakeBin, tool));
  }
  const fixture = {
    root,
    assets,
    fakeBin,
    home,
    installDir,
    log,
    herdrTarget: herdrTargetFor(platform),
  };
  writeHerdrRelease(fixture, HERDR_V1);
  return fixture;
}

function runInstaller(
  fixture: Fixture,
  args: string[] = ["--no-service"],
  environment: Record<string, string | undefined> = {},
) {
  return Bun.spawnSync(["sh", installer, ...args], {
    env: {
      PATH: fixture.fakeBin,
      HOME: fixture.home,
      TMPDIR: fixture.root,
      FIXTURE_DIR: fixture.assets,
      THYRA_CALLS: fixture.log,
      THYRA_INSTALL_BASE_URL: "http://127.0.0.1/releases",
      THYRA_HERDR_BASE_URL: "http://127.0.0.1/herdr",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function calls(fixture: Fixture): string[] {
  return existsSync(fixture.log)
    ? readFileSync(fixture.log, "utf8").trim().split("\n")
    : [];
}

describe("release installer", () => {
  test("installs Thyra and the pinned Herdr, then upgrades idempotently", () => {
    const fixture = createFixture();
    const first = runInstaller(fixture);
    expect(first.stderr.toString()).toBe("");
    expect(first.exitCode).toBe(0);
    const thyra = join(fixture.installDir, "thyra");
    const herdr = join(fixture.installDir, "herdr");
    expect(Bun.spawnSync([thyra, "--version"]).stdout.toString().trim()).toBe(
      "thyra 9.8.7",
    );
    expect(readFileSync(herdr, "utf8")).toBe(HERDR_V1);
    expect(statSync(herdr).mode & 0o111).not.toBe(0);
    expect(first.stdout.toString()).toContain("Installed Herdr 0.9.1");

    const second = runInstaller(fixture);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toContain("is already current");
    expect(existsSync(`${thyra}.previous`)).toBe(true);
    expect(existsSync(`${herdr}.previous`)).toBe(false);

    // A new pinned build replaces the managed binary and keeps the old one.
    writeHerdrRelease(fixture, HERDR_V2);
    const third = runInstaller(fixture);
    expect(third.exitCode).toBe(0);
    expect(readFileSync(herdr, "utf8")).toBe(HERDR_V2);
    expect(readFileSync(`${herdr}.previous`, "utf8")).toBe(HERDR_V1);
    expect(calls(fixture)).toEqual([]);
  });

  test("keeps a Herdr it did not install unless asked to replace it", () => {
    const fixture = createFixture();
    const herdr = join(fixture.installDir, "herdr");
    mkdirSync(fixture.installDir, { recursive: true });
    writeFileSync(herdr, '#!/bin/sh\necho "herdr 0.9.1-custom"\n', {
      mode: 0o755,
    });
    const kept = runInstaller(fixture);
    expect(kept.exitCode).toBe(0);
    expect(kept.stdout.toString()).toContain("Keeping the existing Herdr");
    expect(readFileSync(herdr, "utf8")).toContain("custom");

    const replaced = runInstaller(fixture, ["--no-service", "--replace-herdr"]);
    expect(replaced.exitCode).toBe(0);
    expect(readFileSync(herdr, "utf8")).toBe(HERDR_V1);
    expect(readFileSync(`${herdr}.previous`, "utf8")).toContain("custom");
  });

  test("rejects a Herdr asset that does not match the pin", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.assets, `herdr-${fixture.herdrTarget}`), "x");
    const result = runInstaller(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Herdr checksum mismatch");
    // Nothing is installed when any download fails verification.
    expect(existsSync(join(fixture.installDir, "thyra"))).toBe(false);
  });

  test("sets up loopback services, then edits only the requested settings", () => {
    const fixture = createFixture();
    const result = runInstaller(fixture, ["--port", "8123"]);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    const config = join(fixture.home, ".config", "thyra", "thyra.env");
    expect(readFileSync(config, "utf8")).toContain(
      "HOST=127.0.0.1\nPORT=8123\n",
    );
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(calls(fixture)).toEqual(["herdr setup", "service install"]);
    expect(result.stdout.toString()).toContain(
      "Open http://127.0.0.1:8123 on this machine",
    );
    expect(result.stdout.toString()).toContain(
      "tailscale serve --bg --https=443 http://127.0.0.1:8123",
    );

    writeFileSync(config, `${readFileSync(config, "utf8")}CUSTOM=kept\n`);
    const lan = runInstaller(fixture, ["--lan"]);
    expect(lan.exitCode).toBe(0);
    const edited = readFileSync(config, "utf8");
    expect(edited).toContain("HOST=0.0.0.0\nPORT=8123\n");
    expect(edited).toContain("CUSTOM=kept\n");
  });

  test("uninstalls services and its own binaries but keeps foreign Herdr and config", () => {
    const fixture = createFixture();
    expect(runInstaller(fixture, []).exitCode).toBe(0);
    const config = join(fixture.home, ".config", "thyra");
    const removed = runInstaller(fixture, ["--uninstall"]);
    expect(removed.exitCode).toBe(0);
    expect(calls(fixture).slice(-2)).toEqual([
      "service uninstall",
      "herdr uninstall",
    ]);
    expect(existsSync(join(fixture.installDir, "thyra"))).toBe(false);
    expect(existsSync(join(fixture.installDir, "herdr"))).toBe(false);
    expect(existsSync(join(config, "thyra.env"))).toBe(true);

    // A Herdr the installer never recorded survives uninstall.
    const foreign = join(fixture.installDir, "herdr");
    writeFileSync(foreign, "custom", { mode: 0o755 });
    expect(runInstaller(fixture, ["--uninstall", "--purge"]).exitCode).toBe(0);
    expect(readFileSync(foreign, "utf8")).toBe("custom");
    expect(existsSync(config)).toBe(false);
  });

  test("treats an empty version as latest and rejects bad options", () => {
    const fixture = createFixture();
    expect(
      runInstaller(fixture, ["--no-service"], { THYRA_VERSION: "" }).exitCode,
    ).toBe(0);
    for (const args of [
      ["--port", "70000"],
      ["--purge"],
      ["--bogus"],
      ["--version", "1.0/../x"],
    ]) {
      expect(runInstaller(fixture, args).exitCode, args.join(" ")).not.toBe(0);
    }
  });

  test("rejects an explicitly empty installation directory", () => {
    const fixture = createFixture();
    const result = runInstaller(fixture, ["--no-service"], {
      THYRA_INSTALL_DIR: "",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "install directory must not be empty",
    );
  });

  test("rejects filenames supplied by an untrusted checksum file", () => {
    const fixture = createFixture("../../unrelated-file");
    const result = runInstaller(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("invalid package checksum file");
  });

  test("refuses to replace a symlinked install target", () => {
    const fixture = createFixture();
    mkdirSync(fixture.installDir, { recursive: true });
    const outside = join(fixture.root, "outside-binary");
    writeFileSync(outside, "outside\n", { mode: 0o755 });
    symlinkSync(outside, join(fixture.installDir, "thyra"));
    const result = runInstaller(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "install target exists but is not a regular file",
    );
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  test("rejects unauthenticated non-loopback release mirrors", () => {
    const fixture = createFixture();
    const result = runInstaller(fixture, ["--no-service"], {
      THYRA_INSTALL_BASE_URL: "http://downloads.example.com/thyra",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "must use HTTPS unless the mirror is loopback",
    );
  });
});
