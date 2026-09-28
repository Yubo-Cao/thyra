import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { resolvePublicFilePath } from "./static-paths";

/**
 * Fingerprinted assets of recent builds, kept on disk.
 *
 * The binary embeds only its own build, so after an update a page that was
 * started from the previous build would get a 404 for any lazy chunk it had
 * not loaded yet. Each start copies the running build's `/assets/` files here
 * (names are content hashes, so existing files are skipped), and the static
 * server answers `/assets/` misses from this directory. The newest
 * `ASSET_ARCHIVE_BUILDS` builds are kept; files no kept build lists are
 * deleted.
 *
 * Layout: `builds/<version>.json` lists a build's assets once all of them
 * are copied; `files/assets/...` mirrors the URL paths.
 */
export const ASSET_ARCHIVE_BUILDS = 5;

const VERSION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type BuildManifest = { version: string; assets: string[] };

type ArchivedBuild = BuildManifest & { archivedAt: number };

export function parseBuildManifest(value: unknown): BuildManifest | null {
  if (!value || typeof value !== "object") return null;
  const { version, assets } = value as Record<string, unknown>;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version))
    return null;
  if (!Array.isArray(assets)) return null;
  const paths = assets.filter(
    (path): path is string =>
      typeof path === "string" && path.startsWith("/assets/"),
  );
  return { version, assets: paths };
}

/** On-disk path of an archived asset, or null outside `/assets/`. */
export function archivedAssetPath(
  archiveDir: string,
  pathname: string,
): string | null {
  if (!pathname.startsWith("/assets/")) return null;
  return resolvePublicFilePath(join(archiveDir, "files"), pathname);
}

async function writeAtomically(
  path: string,
  data: string | Blob,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await Bun.write(temporary, data);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readArchivedBuilds(buildsDir: string): Promise<ArchivedBuild[]> {
  const builds: ArchivedBuild[] = [];
  for (const name of await readdir(buildsDir).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await readFile(join(buildsDir, name), "utf8"));
      const build = parseBuildManifest(value);
      if (build && `${build.version}.json` === name) {
        builds.push({
          ...build,
          archivedAt: Number(value.archivedAt) || 0,
        });
        continue;
      }
    } catch {
      // Unreadable: treated as stale below.
    }
    await rm(join(buildsDir, name), { force: true });
  }
  return builds;
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else files.push(`/${relative(root, path).split(sep).join("/")}`);
  }
  return files;
}

/**
 * Copy the running build into the archive, then keep only the newest builds.
 * `source(pathname)` returns the running build's file for a `/assets/` path.
 */
export async function archiveBuild(args: {
  archiveDir: string;
  manifest: BuildManifest;
  source: (pathname: string) => Blob | null;
  keepBuilds?: number;
  now?: number;
}): Promise<{ copied: number; removed: number }> {
  const { archiveDir, manifest } = args;
  const filesDir = join(archiveDir, "files");
  const buildsDir = join(archiveDir, "builds");
  await mkdir(archiveDir, { recursive: true, mode: 0o700 });
  await mkdir(buildsDir, { recursive: true, mode: 0o700 });
  await mkdir(filesDir, { recursive: true, mode: 0o700 });
  let copied = 0;
  for (const pathname of manifest.assets) {
    const target = archivedAssetPath(archiveDir, pathname);
    const file = args.source(pathname);
    if (!target || !file) continue;
    const existing = await stat(target).catch(() => null);
    if (existing?.isFile() && existing.size === file.size) continue;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeAtomically(target, file);
    copied += 1;
  }
  // Listed only once every file is in place.
  await writeAtomically(
    join(buildsDir, `${manifest.version}.json`),
    JSON.stringify({
      version: manifest.version,
      assets: manifest.assets,
      archivedAt: args.now ?? Date.now(),
    }),
  );
  const limit = args.keepBuilds ?? ASSET_ARCHIVE_BUILDS;
  const builds = (await readArchivedBuilds(buildsDir)).sort(
    (a, b) => b.archivedAt - a.archivedAt,
  );
  const keep = new Set<string>();
  for (const [index, build] of builds.entries()) {
    if (index < limit || build.version === manifest.version) {
      for (const pathname of build.assets) keep.add(pathname);
    } else {
      await rm(join(buildsDir, `${build.version}.json`), { force: true });
    }
  }
  let removed = 0;
  for (const pathname of await listFiles(filesDir)) {
    // Another process may be writing a file under a temporary name.
    if (keep.has(pathname) || pathname.endsWith(".tmp")) continue;
    await rm(join(filesDir, pathname), { force: true });
    removed += 1;
  }
  return { copied, removed };
}
