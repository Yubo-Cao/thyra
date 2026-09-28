import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveBuild,
  archivedAssetPath,
  parseBuildManifest,
} from "./asset-archive";

function source(files: Record<string, string>) {
  return (pathname: string) =>
    pathname in files ? new Blob([files[pathname]!]) : null;
}

async function archived(archiveDir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory())
        await walk(join(directory, entry.name), `${prefix}/${entry.name}`);
      else files.push(`${prefix}/${entry.name}`);
    }
  };
  await walk(join(archiveDir, "files"), "");
  return files.sort();
}

test("each start archives its build and keeps only the newest builds", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "thyra-archive-"));
  try {
    const build = (n: number) => ({
      manifest: {
        version: `v${n}`,
        assets: ["/assets/vendor.js", `/assets/app-${n}.js`],
      },
      files: {
        "/assets/vendor.js": "vendor",
        [`/assets/app-${n}.js`]: `app ${n}`,
      },
    });
    for (let n = 1; n <= 3; n++) {
      const { manifest, files } = build(n);
      const result = await archiveBuild({
        archiveDir,
        manifest,
        source: source(files),
        keepBuilds: 2,
        now: n,
      });
      // Unchanged files are not copied again.
      expect(result.copied).toBe(n === 1 ? 2 : 1);
    }
    expect(await archived(archiveDir)).toEqual([
      "/assets/app-2.js",
      "/assets/app-3.js",
      "/assets/vendor.js",
    ]);
    expect((await readdir(join(archiveDir, "builds"))).sort()).toEqual([
      "v2.json",
      "v3.json",
    ]);
    expect(
      await Bun.file(archivedAssetPath(archiveDir, "/assets/app-2.js")!).text(),
    ).toBe("app 2");
    expect((await stat(archiveDir)).mode & 0o777).toBe(0o700);

    // Starting an older build again makes it the newest.
    const { manifest, files } = build(2);
    await archiveBuild({
      archiveDir,
      manifest,
      source: source(files),
      keepBuilds: 1,
      now: 4,
    });
    expect(await archived(archiveDir)).toEqual([
      "/assets/app-2.js",
      "/assets/vendor.js",
    ]);
  } finally {
    await rm(archiveDir, { recursive: true, force: true });
  }
});

test("archive paths stay inside the archive", () => {
  expect(archivedAssetPath("/srv/archive", "/assets/a.js")).toBe(
    "/srv/archive/files/assets/a.js",
  );
  expect(archivedAssetPath("/srv/archive", "/index.html")).toBeNull();
  expect(archivedAssetPath("/srv/archive", "/assets/../../x")).toBeNull();
});

test("build manifests need a safe version and keep only asset paths", () => {
  expect(
    parseBuildManifest({ version: "abc", assets: ["/assets/a.js", "/x", 1] }),
  ).toEqual({ version: "abc", assets: ["/assets/a.js"] });
  expect(parseBuildManifest({ version: "../x", assets: [] })).toBeNull();
  expect(parseBuildManifest({ version: "a" })).toBeNull();
  expect(parseBuildManifest(null)).toBeNull();
});
