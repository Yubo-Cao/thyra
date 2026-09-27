import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// Every test here spawns PowerShell, which is slow to start on shared CI runners.
setDefaultTimeout(30_000);
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPin } from "./pin-herdr";

// The Windows installer runs under Windows PowerShell 5.1 (`irm | iex`), so
// its pure helpers are exercised with PowerShell 7 where available and the
// source is checked for syntax that 5.1 cannot parse.
const script = join(import.meta.dir, "install.ps1");
const pwsh = Bun.which("pwsh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function ps(command: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync(
    [
      pwsh!,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'; . $env:INSTALLER; ${command}`,
    ],
    {
      env: {
        ...process.env,
        INSTALLER: script,
        THYRA_INSTALLER_LIBRARY: "1",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    code: result.exitCode,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString(),
  };
}

test("uses only syntax Windows PowerShell 5.1 understands", () => {
  const source = readFileSync(script, "utf8");
  // Null-coalescing, null-conditional, and ternary operators are PS 7 only.
  expect(source).not.toMatch(/\?\?|\?\.|\s\?\s[^:]+\s:\s/);
  expect(source).not.toContain("-AsHashtable");
  expect(source).toContain("-UseBasicParsing");
});

describe.skipIf(!pwsh)("install.ps1 helpers", () => {
  test("parses without errors", () => {
    const result = ps(
      "$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:INSTALLER, [ref]$t, [ref]$e); $e.Count",
    );
    expect(result.err).toBe("");
    expect(result.out).toBe("0");
  });

  test("maps Windows architectures to Thyra platforms", () => {
    expect(ps('Get-ThyraPlatform "X64"').out).toBe("windows-x64");
    expect(ps('Get-ThyraPlatform "Arm64"').out).toBe("windows-arm64");
    expect(ps('Get-ThyraPlatform "X86"').code).not.toBe(0);
  });

  test("resolves release base URLs and rejects unsafe mirrors", () => {
    expect(ps('Get-ReleaseBase "" ""').out).toBe(
      "https://github.com/Yubo-Cao/thyra/releases/latest/download",
    );
    expect(ps('Get-ReleaseBase "" "0.8.0"').out).toBe(
      "https://github.com/Yubo-Cao/thyra/releases/download/v0.8.0",
    );
    expect(ps('Get-ReleaseBase "http://127.0.0.1:9/m//" ""').out).toBe(
      "http://127.0.0.1:9/m",
    );
    for (const url of [
      "https://example.com/a",
      "http://127.0.0.1:8000/x",
      "http://localhost/x",
    ]) {
      expect(ps(`Assert-DownloadUrl '${url}'`).code, url).toBe(0);
    }
    for (const url of [
      "http://downloads.example.com/x",
      "https://user:pw@example.com/x",
      "https://example.com/x?y=1",
      "ftp://example.com/x",
    ]) {
      expect(ps(`Assert-DownloadUrl '${url}'`).code, url).not.toBe(0);
    }
  });

  test("accepts checksum files only for the expected asset", () => {
    const root = mkdtempSync(join(tmpdir(), "thyra-ps1-"));
    roots.push(root);
    const file = join(root, "sum");
    const digest = "A".repeat(64);
    writeFileSync(file, `${digest}  thyra-windows-x64.zip\n`);
    expect(
      ps('Read-ChecksumFile $env:SUM "thyra-windows-x64.zip"', { SUM: file })
        .out,
    ).toBe(digest.toLowerCase());
    for (const content of [
      `${digest}  ../thyra-windows-x64.zip\n`,
      `${digest.slice(1)}  thyra-windows-x64.zip\n`,
      `${digest}  thyra-windows-x64.zip extra\n`,
    ]) {
      writeFileSync(file, content);
      expect(
        ps('Read-ChecksumFile $env:SUM "thyra-windows-x64.zip"', { SUM: file })
          .code,
      ).not.toBe(0);
    }
  });

  test("reads the Windows entry of the rendered Herdr pin", () => {
    const root = mkdtempSync(join(tmpdir(), "thyra-ps1-"));
    roots.push(root);
    const file = join(root, "herdr-release.json");
    const pin = {
      repository: "Yubo-Cao/herdr",
      tag: "v0.9.1-thyra.1",
      version: "0.9.1",
      protocol: 22,
      sha256: { "windows-x86_64": "C".repeat(64) },
    };
    writeFileSync(file, renderPin(pin));
    expect(
      JSON.parse(
        ps("Read-HerdrPin $env:PIN | ConvertTo-Json -Compress", { PIN: file })
          .out,
      ),
    ).toEqual({
      Repository: "Yubo-Cao/herdr",
      Tag: "v0.9.1-thyra.1",
      Version: "0.9.1",
      Sha256: "c".repeat(64),
    });
    writeFileSync(
      file,
      renderPin({ ...pin, sha256: { "linux-x86_64": "a".repeat(64) } }),
    );
    expect(ps("Read-HerdrPin $env:PIN", { PIN: file }).code).not.toBe(0);
  });

  test("never replaces a Herdr it did not install", () => {
    const action = (installed: boolean, other: boolean, replace: boolean) =>
      ps(`Get-HerdrAction $${installed} $${other} $${replace}`).out;
    expect(action(true, true, false)).toBe("current");
    expect(action(false, true, false)).toBe("keep");
    expect(action(false, true, true)).toBe("install");
    expect(action(false, false, false)).toBe("install");
  });

  test("reads and edits service environment values", () => {
    const root = mkdtempSync(join(tmpdir(), "thyra-ps1-"));
    roots.push(root);
    const file = join(root, "thyra.env");
    writeFileSync(file, "# PORT=1\nHOST=127.0.0.1\nPORT=8787\nX=1\n");
    expect(ps('Get-EnvValue $env:ENVFILE "PORT"', { ENVFILE: file }).out).toBe(
      "8787",
    );
    ps(
      'Set-EnvValue $env:ENVFILE "PORT" "9001"; Set-EnvValue $env:ENVFILE "HOST" "0.0.0.0"; Set-EnvValue $env:ENVFILE "NEW" "2"',
      { ENVFILE: file },
    );
    expect(readFileSync(file, "utf8").replaceAll("\r\n", "\n")).toBe(
      "# PORT=1\nHOST=0.0.0.0\nPORT=9001\nX=1\nNEW=2\n",
    );
  });
});
