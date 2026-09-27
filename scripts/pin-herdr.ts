/**
 * Record or verify the Herdr build Thyra installs.
 *
 *   bun scripts/pin-herdr.ts pin Yubo-Cao/herdr v0.9.1-thyra.1
 *   bun scripts/pin-herdr.ts check [--repository Yubo-Cao/herdr]
 *   bun scripts/pin-herdr.ts mirror <dir> [--output <file>]
 *
 * `pin` downloads every Herdr release asset, cross-checks the release's
 * SHA256SUMS when it has one, and rewrites server/src/herdr/herdr-release.json.
 * `check` downloads the pinned assets again and fails unless each digest
 * matches (the release workflow runs it before publishing). `mirror` writes
 * a pin for Herdr assets in a local directory so installers can be tested
 * against a loopback mirror; it never edits the committed pin.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const HERDR_TARGETS = [
  "linux-x86_64",
  "linux-aarch64",
  "macos-x86_64",
  "macos-aarch64",
  "windows-x86_64",
] as const;

export type HerdrTarget = (typeof HERDR_TARGETS)[number];

export interface HerdrPin {
  repository: string;
  tag: string;
  version: string;
  protocol: number;
  sha256: Partial<Record<HerdrTarget, string>>;
}

export const PIN_PATH = join(
  import.meta.dir,
  "..",
  "server",
  "src",
  "herdr",
  "herdr-release.json",
);

export function herdrAssetName(target: HerdrTarget): string {
  return target.startsWith("windows")
    ? `herdr-${target}.zip`
    : `herdr-${target}`;
}

/** `v0.9.1`, `v0.9.1-thyra.2` -> `0.9.1`. */
export function versionFromTag(tag: string): string {
  const match = /^v(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(tag);
  if (!match) throw new Error(`cannot derive a Herdr version from tag ${tag}`);
  return match[1];
}

/** Parse `sha256sum` output; later duplicate names are rejected. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-fA-F]{64}) [ *]?(\S+)$/.exec(line.trim());
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
    if (sums.has(match[2])) {
      throw new Error(`duplicate SHA256SUMS entry: ${match[2]}`);
    }
    sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

export function validatePin(value: unknown, complete = true): HerdrPin {
  const pin = value as HerdrPin;
  if (!pin || typeof pin !== "object") throw new Error("pin must be an object");
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(pin.repository))) {
    throw new Error("pin repository must be owner/name");
  }
  if (versionFromTag(String(pin.tag)) !== pin.version) {
    throw new Error("pin version must match its tag");
  }
  if (!Number.isSafeInteger(pin.protocol)) {
    throw new Error("pin protocol must be an integer");
  }
  const targets = Object.keys(pin.sha256 ?? {});
  for (const target of targets) {
    if (!HERDR_TARGETS.includes(target as HerdrTarget)) {
      throw new Error(`unknown Herdr target: ${target}`);
    }
    if (!/^[0-9a-f]{64}$/.test(pin.sha256[target as HerdrTarget] ?? "")) {
      throw new Error(`invalid SHA-256 for ${target}`);
    }
  }
  if (complete && targets.length !== HERDR_TARGETS.length) {
    throw new Error("pin must record every Herdr target");
  }
  return pin;
}

/** One key per line, so POSIX installers can read it with awk. */
export function renderPin(pin: HerdrPin): string {
  const sha256: Record<string, string> = {};
  for (const target of HERDR_TARGETS) {
    const digest = pin.sha256[target];
    if (digest) sha256[target] = digest;
  }
  return `${JSON.stringify(
    {
      repository: pin.repository,
      tag: pin.tag,
      version: pin.version,
      protocol: pin.protocol,
      sha256,
    },
    null,
    2,
  )}\n`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function download(url: string): Promise<Uint8Array | null> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(300_000),
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`download failed: HTTP ${response.status} ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

function releaseBase(repository: string, tag: string): string {
  return `https://github.com/${repository}/releases/download/${tag}`;
}

async function digestRelease(
  repository: string,
  tag: string,
): Promise<Record<HerdrTarget, string>> {
  const base = releaseBase(repository, tag);
  const sumsBytes = await download(`${base}/SHA256SUMS`);
  const sums = sumsBytes
    ? parseSha256Sums(new TextDecoder().decode(sumsBytes))
    : null;
  const digests = {} as Record<HerdrTarget, string>;
  for (const target of HERDR_TARGETS) {
    const name = herdrAssetName(target);
    const bytes = await download(`${base}/${name}`);
    if (!bytes) throw new Error(`release ${repository}@${tag} lacks ${name}`);
    const digest = sha256Hex(bytes);
    if (sums && sums.get(name) !== digest) {
      throw new Error(`${name} does not match the release SHA256SUMS`);
    }
    digests[target] = digest;
    console.log(`${digest}  ${name}`);
  }
  return digests;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string" },
      protocol: { type: "string" },
      repository: { type: "string" },
      tag: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  const protocol = Number(values.protocol ?? 22);

  if (command === "pin") {
    const [repository, tag] = rest;
    if (!repository || !tag) throw new Error("usage: pin <owner/repo> <tag>");
    const pin = validatePin({
      repository,
      tag,
      version: versionFromTag(tag),
      protocol,
      sha256: await digestRelease(repository, tag),
    });
    writeFileSync(values.output ?? PIN_PATH, renderPin(pin));
    console.log(`Pinned Herdr ${repository}@${tag}.`);
    return 0;
  }

  if (command === "check") {
    const pin = validatePin(JSON.parse(readFileSync(PIN_PATH, "utf8")));
    if (values.repository && pin.repository !== values.repository) {
      throw new Error(
        `Herdr is pinned to ${pin.repository}, expected ${values.repository}; run \`bun scripts/pin-herdr.ts pin ${values.repository} <tag>\``,
      );
    }
    const digests = await digestRelease(pin.repository, pin.tag);
    for (const target of HERDR_TARGETS) {
      if (digests[target] !== pin.sha256[target]) {
        throw new Error(`${target} no longer matches the pinned SHA-256`);
      }
    }
    console.log(`Verified Herdr pin ${pin.repository}@${pin.tag}.`);
    return 0;
  }

  if (command === "mirror") {
    const [directory] = rest;
    if (!directory) throw new Error("usage: mirror <dir> [--output <file>]");
    const tag = values.tag ?? "v0.0.0-mirror";
    const sha256: HerdrPin["sha256"] = {};
    for (const target of HERDR_TARGETS) {
      const path = join(directory, herdrAssetName(target));
      if (existsSync(path)) sha256[target] = sha256Hex(readFileSync(path));
    }
    if (Object.keys(sha256).length === 0) {
      throw new Error(`no Herdr assets found in ${directory}`);
    }
    const pin = validatePin(
      {
        repository: values.repository ?? "local/mirror",
        tag,
        version: versionFromTag(tag),
        protocol,
        sha256,
      },
      false,
    );
    writeFileSync(
      values.output ?? join(directory, "herdr-release.json"),
      renderPin(pin),
    );
    return 0;
  }

  throw new Error("usage: pin-herdr.ts <pin | check | mirror> ...");
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (cause) {
    console.error(`pin-herdr: ${(cause as Error).message}`);
    process.exit(1);
  }
}
