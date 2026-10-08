import { createHash } from "node:crypto";
import { powershellSingleQuotedString } from "../utils/powershell";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pinnedRelease from "./herdr-release.json";

/**
 * Thyra only installs this exact Herdr build. `herdr-release.json` is the one
 * pin shared with the release installers, which download it as the
 * `herdr-release.json` release asset. `bun scripts/pin-herdr.ts` records the
 * SHA-256 values from the pinned GitHub release, so a replaced or tampered
 * asset fails verification instead of installing. Re-pin only after verifying
 * a new Herdr build against Thyra's supported protocol
 * (server/src/bridge/protocol-compat.ts).
 */
export const VERIFIED_HERDR_REPOSITORY: string = pinnedRelease.repository;
export const VERIFIED_HERDR_TAG: string = pinnedRelease.tag;
export const VERIFIED_HERDR_VERSION: string = pinnedRelease.version;
export const VERIFIED_HERDR_PROTOCOL: number = pinnedRelease.protocol;

export type HerdrReleaseTarget =
  | "linux-x86_64"
  | "linux-aarch64"
  | "macos-x86_64"
  | "macos-aarch64"
  | "windows-x86_64";

export const VERIFIED_HERDR_SHA256: Record<HerdrReleaseTarget, string> =
  pinnedRelease.sha256;

export function resolveHerdrReleaseTarget(
  platform: string,
  arch: string,
): HerdrReleaseTarget | null {
  const os =
    platform === "linux"
      ? "linux"
      : platform === "darwin"
        ? "macos"
        : platform === "win32"
          ? "windows"
          : null;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!os || !cpu) return null;
  // Herdr publishes no native Windows ARM64 build; like Herdr's own
  // installer, run the x86_64 build under Windows emulation.
  if (os === "windows") return "windows-x86_64";
  const candidate = `${os}-${cpu}` as HerdrReleaseTarget;
  return candidate in VERIFIED_HERDR_SHA256 ? candidate : null;
}

export function herdrReleaseAssetName(target: HerdrReleaseTarget): string {
  const base = `herdr-${target}`;
  // Windows ships a zip (herdr.exe + conpty/); Unix ships a raw binary.
  return target.startsWith("windows") ? `${base}.zip` : base;
}

export function herdrReleaseUrl(
  target: HerdrReleaseTarget,
  tag: string = VERIFIED_HERDR_TAG,
  repository: string = VERIFIED_HERDR_REPOSITORY,
): string {
  return `https://github.com/${repository}/releases/download/${tag}/${herdrReleaseAssetName(target)}`;
}

export function herdrInstallRoot(
  homeDir: string,
  appDataDir?: string,
  platform: string = process.platform,
): string {
  if (platform === "win32") {
    // Herdr's official Windows layout is a junctioned release store under
    // %USERPROFILE%\.herdr plus a visible bin shim; Thyra does not
    // reimplement it and keeps its own managed directory instead.
    return join(
      appDataDir ?? join(homeDir, "AppData", "Roaming"),
      "thyra",
      "herdr",
    );
  }
  // The official Unix installer location (install.sh): a single binary that
  // `herdr update` can replace in place afterwards.
  return join(homeDir, ".local", "bin");
}

export function herdrManagedBinaryPath(
  homeDir: string,
  appDataDir?: string,
  platform: string = process.platform,
  tag: string = VERIFIED_HERDR_TAG,
): string {
  const base = herdrInstallRoot(homeDir, appDataDir, platform);
  if (platform !== "win32") return join(base, "herdr");
  // Keyed by release tag because a rebuilt fork can reuse a Herdr version.
  return join(base, tag, "herdr.exe");
}

export interface InstallHerdrDeps {
  platform?: string;
  arch?: string;
  homeDir?: string;
  appDataDir?: string;
  download?: (url: string, destinationPath: string) => Promise<void>;
  runCommand?: (argv: string[]) => number;
  /** Test-only override; production installs always use the verified table. */
  expectedSha256?: string;
}

async function defaultDownload(
  url: string,
  destinationPath: string,
): Promise<void> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Herdr download failed: HTTP ${response.status}`);
  }
  await Bun.write(destinationPath, response);
}

/**
 * Download the verified Herdr release into Thyra's managed directory and
 * return the binary path. Idempotent: an existing managed binary is kept.
 */
export async function installVerifiedHerdr(
  deps: InstallHerdrDeps = {},
): Promise<{ binaryPath: string; version: string; installed: boolean }> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const target = resolveHerdrReleaseTarget(platform, arch);
  if (!target) {
    throw new Error(
      `no verified Herdr ${VERIFIED_HERDR_VERSION} release for ${platform}-${arch}`,
    );
  }
  const homeDir = deps.homeDir ?? homedir();
  const appDataDir = deps.appDataDir ?? process.env.APPDATA;
  const binaryPath = herdrManagedBinaryPath(homeDir, appDataDir, platform);
  if (existsSync(binaryPath)) {
    return { binaryPath, version: VERIFIED_HERDR_VERSION, installed: false };
  }

  const download = deps.download ?? defaultDownload;
  const installRoot = herdrInstallRoot(homeDir, appDataDir, platform);
  const installDir =
    platform === "win32" ? join(installRoot, VERIFIED_HERDR_TAG) : installRoot;
  mkdirSync(installRoot, { recursive: true });
  // Stage inside the install root so final renames stay on one filesystem.
  const staging = join(installRoot, `.staging-${process.pid}`);
  mkdirSync(staging, { recursive: true });
  try {
    const assetName = herdrReleaseAssetName(target);
    const archivePath = join(staging, assetName);
    await download(herdrReleaseUrl(target), archivePath);
    const actual = createHash("sha256")
      .update(new Uint8Array(await Bun.file(archivePath).arrayBuffer()))
      .digest("hex");
    const expectedSha256 = deps.expectedSha256 ?? VERIFIED_HERDR_SHA256[target];
    if (actual !== expectedSha256) {
      throw new Error(
        "downloaded Herdr checksum does not match the verified release",
      );
    }

    if (platform === "win32") {
      const runCommand =
        deps.runCommand ??
        ((argv: string[]) => Bun.spawnSync(argv).exitCode ?? 1);
      const extractDir = join(staging, "extracted");
      const code = runCommand([
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${powershellSingleQuotedString(archivePath)} -DestinationPath ${powershellSingleQuotedString(extractDir)} -Force`,
      ]);
      if (code !== 0) {
        throw new Error("could not extract the downloaded Herdr archive");
      }
      if (!existsSync(join(extractDir, "herdr.exe"))) {
        throw new Error("downloaded Herdr archive does not contain herdr.exe");
      }
      // Publish the complete layout (herdr.exe, conpty/ and notices) at once.
      renameSync(extractDir, installDir);
    } else {
      chmodSync(archivePath, 0o755);
      renameSync(archivePath, binaryPath);
    }
    return { binaryPath, version: VERIFIED_HERDR_VERSION, installed: true };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
