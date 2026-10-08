import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHostTools, runHostScript } from "./file-host";
import {
  MAX_RUNNING_JOBS,
  archiveCapabilities,
  archiveFormat,
  archiveStem,
  compressScript,
  createArchiveJobs,
  extractScript,
  extractTool,
} from "./file-archive";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thyra-archive-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const has = (tool: string) => Bun.which(tool) !== null;
const sh = async (...argv: string[]) => {
  const proc = Bun.spawn(argv, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
};

async function runJob(
  script: string,
  kind: "extract" | "compress" = "extract",
) {
  const jobs = createArchiveJobs(runHostScript);
  const id = jobs.start(undefined, "w1", kind, script);
  for (;;) {
    const status = jobs.status(id, "w1");
    if (status.state !== "running") return status;
    await Bun.sleep(20);
  }
}

const leftovers = async () =>
  (await readdir(root)).filter((name) => name.startsWith(".thyra-"));

test("at most a few archive jobs run at once", () => {
  const jobs = createArchiveJobs(
    () => new Promise(() => {}) as ReturnType<typeof runHostScript>,
  );
  for (let index = 0; index < MAX_RUNNING_JOBS; index += 1) {
    jobs.start(undefined, "w1", "extract", "sleep 60");
  }
  expect(() => jobs.start(undefined, "w1", "extract", "sleep 60")).toThrow(
    "already running",
  );
});

test("formats, stems and tool choice follow the host", () => {
  expect(archiveFormat("/x/Photos.TAR.GZ")).toBe("tar.gz");
  expect(archiveFormat("a.tgz")).toBe("tar.gz");
  expect(archiveFormat("a.tar.zst")).toBe("tar.zst");
  expect(archiveFormat("notes.txt")).toBeNull();
  expect(archiveStem("photos.tar.gz")).toBe("photos");
  expect(archiveStem(".zip")).toBe("archive");
  const linux = parseHostTools("OS\tLinux\nTOOL\ttar\nTOOL\tunzip\n");
  expect(extractTool("tar.xz", linux)).toEqual({
    tool: null,
    missing: "tar with xz, or bsdtar",
  });
  expect(extractTool("zip", linux)).toEqual({ tool: "unzip" });
  const mac = parseHostTools("OS\tDarwin\nTOOL\ttar\n");
  expect(extractTool("tar.xz", mac)).toEqual({ tool: "tar" });
  expect(archiveCapabilities(mac).extract.rar).toBe("unrar, 7-Zip or bsdtar");
  expect(archiveCapabilities(mac).compress["tar.gz"]).toBe(true);
});

describe("archive round trips", () => {
  beforeEach(async () => {
    await mkdir(join(root, "project/src"), { recursive: true });
    await writeFile(join(root, "project/src/main.ts"), "export {};\n");
    await writeFile(join(root, "project/readme.md"), "# hi\n");
    await symlink("src/main.ts", join(root, "project/entry"));
  });

  for (const [format, tool] of [
    ["zip", "zip"],
    ["tar.gz", "tar"],
  ] as const) {
    test(`compresses to ${format} and extracts into a new folder`, async () => {
      if (!has(tool)) return;
      const compressed = await runJob(
        compressScript({
          base: root,
          names: ["project"],
          output: join(root, `project.${format}`),
          format,
          tool,
        }),
        "compress",
      );
      expect(compressed.error).toBeUndefined();
      expect(compressed.result).toBe(join(root, `project.${format}`));
      await rm(join(root, "project"), { recursive: true });
      const extractor = format === "zip" ? "unzip" : "tar";
      if (!has(extractor)) return;
      const extracted = await runJob(
        extractScript({
          archive: join(root, `project.${format}`),
          parent: root,
          folder: "project",
          tool: extractor,
        }),
      );
      expect(extracted.error).toBeUndefined();
      expect(extracted.state).toBe("done");
      expect(extracted.result).toBe(join(root, "project"));
      expect(
        await readFile(join(root, "project/project/src/main.ts"), "utf8"),
      ).toBe("export {};\n");
      // A second extraction gets a numbered sibling, never a merge.
      const again = await runJob(
        extractScript({
          archive: join(root, `project.${format}`),
          parent: root,
          folder: "project",
          tool: extractor,
        }),
      );
      expect(again.result).toBe(join(root, "project (2)"));
      expect(await leftovers()).toEqual([]);
    });
  }

  for (const [suffix, flag, tool] of [
    ["tar.xz", "-J", "xz"],
    ["tar.zst", "--zstd", "zstd"],
    ["tar.bz2", "-j", "bzip2"],
  ] as const) {
    test(`extracts ${suffix}`, async () => {
      if (!has("tar") || !has(tool)) return;
      await sh("tar", flag, "-cf", `p.${suffix}`, "project");
      const job = await runJob(
        extractScript({
          archive: join(root, `p.${suffix}`),
          parent: root,
          folder: "p",
          tool: "tar",
        }),
      );
      expect(job.state).toBe("done");
      expect(await readdir(join(root, "p/project"))).toContain("readme.md");
    });
  }

  test("extracts 7z with 7-Zip", async () => {
    const tool = ["7zz", "7z", "7za"].find(has);
    if (!tool) return;
    await sh(tool, "a", "-bd", "p.7z", "project");
    const job = await runJob(
      extractScript({
        archive: join(root, "p.7z"),
        parent: root,
        folder: "p",
        tool: tool as "7z",
      }),
    );
    expect(job.error).toBeUndefined();
    expect(await readdir(join(root, "p/project/src"))).toEqual(["main.ts"]);
  });
});

describe("hostile archives", () => {
  test("refuses zip-slip entries before writing anything", async () => {
    if (!has("unzip") || !has("python3")) return;
    await sh(
      "python3",
      "-c",
      "import zipfile; z = zipfile.ZipFile('evil.zip', 'w'); z.writestr('ok.txt', 'ok'); z.writestr('../../escape.txt', 'x'); z.close()",
    );
    const job = await runJob(
      extractScript({
        archive: join(root, "evil.zip"),
        parent: root,
        folder: "evil",
        tool: "unzip",
      }),
    );
    expect(job.state).toBe("failed");
    expect(job.error).toContain("outside its folder: ../../escape.txt");
    expect(await readdir(root)).toEqual(["evil.zip"]);
  });

  test("refuses absolute tar entries", async () => {
    if (!has("tar") || !has("python3")) return;
    await sh(
      "python3",
      "-c",
      "import tarfile, io; t = tarfile.open('abs.tar', 'w'); i = tarfile.TarInfo('/tmp/thyra-abs-escape'); data = b'x'; i.size = len(data); t.addfile(i, io.BytesIO(data)); t.close()",
    );
    const job = await runJob(
      extractScript({
        archive: join(root, "abs.tar"),
        parent: root,
        folder: "abs",
        tool: "tar",
      }),
    );
    expect(job.error).toContain("outside its folder: /tmp/thyra-abs-escape");
    expect(await Bun.file("/tmp/thyra-abs-escape").exists()).toBe(false);
  });

  test("refuses symlinks that point outside the extracted folder", async () => {
    if (!has("tar")) return;
    await mkdir(join(root, "src"));
    await symlink("../../../etc", join(root, "src/up"));
    await symlink("/etc/passwd", join(root, "src/abs"));
    for (const name of ["up", "abs"]) {
      await sh("tar", "-cf", `${name}.tar`, "-C", "src", name);
      const job = await runJob(
        extractScript({
          archive: join(root, `${name}.tar`),
          parent: root,
          folder: name,
          tool: "tar",
        }),
      );
      expect(job.error).toContain(
        `symlink that points outside its folder: ${name}`,
      );
    }
    // Links that stay inside are kept.
    await mkdir(join(root, "inside/lib"), { recursive: true });
    await symlink("../lib", join(root, "inside/lib/self"));
    await sh("tar", "-cf", "inside.tar", "inside");
    const job = await runJob(
      extractScript({
        archive: join(root, "inside.tar"),
        parent: root,
        folder: "inside-out",
        tool: "tar",
      }),
    );
    expect(job.state).toBe("done");
    expect(await leftovers()).toEqual([]);
  });

  test("never writes through a symlink the archive itself planted", async () => {
    if (!has("python3")) return;
    const outside = join(root, "outside");
    await mkdir(outside);
    const plant = (kind: "tar" | "zip", name: string) =>
      sh(
        "python3",
        "-c",
        kind === "tar"
          ? `import tarfile, io; t = tarfile.open('${name}', 'w'); l = tarfile.TarInfo('a'); l.type = tarfile.SYMTYPE; l.linkname = '${outside}'; t.addfile(l); f = tarfile.TarInfo('a/pwned.txt'); d = b'x'; f.size = len(d); t.addfile(f, io.BytesIO(d)); t.close()`
          : `import zipfile; z = zipfile.ZipFile('${name}', 'w'); i = zipfile.ZipInfo('a'); i.create_system = 3; i.external_attr = 0o120777 << 16; z.writestr(i, '${outside}'); z.writestr('a/pwned.txt', 'x'); z.close()`,
      );
    for (const [kind, tool] of [
      ["tar", "tar"],
      ["zip", "unzip"],
    ] as const) {
      if (!has(tool)) continue;
      const name = `plant.${kind}`;
      await plant(kind, name);
      const job = await runJob(
        extractScript({
          archive: join(root, name),
          parent: root,
          folder: `plant-${kind}`,
          tool,
        }),
      );
      expect(job.state).toBe("failed");
      expect(await readdir(outside)).toEqual([]);
    }
    expect(await leftovers()).toEqual([]);
  });

  test("stops past the size and entry limits", async () => {
    if (!has("tar")) return;
    await mkdir(join(root, "many"));
    for (let index = 0; index < 5; index += 1) {
      await writeFile(
        join(root, "many", `${index}.bin`),
        Buffer.alloc(64 * 1024),
      );
    }
    await sh("tar", "-cf", "many.tar", "many");
    const tooMany = await runJob(
      extractScript({
        archive: join(root, "many.tar"),
        parent: root,
        folder: "many-out",
        tool: "tar",
        maxEntries: 3,
      }),
    );
    expect(tooMany.error).toContain("more than 3 entries");
    const tooBig = await runJob(
      extractScript({
        archive: join(root, "many.tar"),
        parent: root,
        folder: "many-out",
        tool: "tar",
        maxBytes: 100 * 1024,
      }),
    );
    expect(tooBig.error).toContain("extraction limit");
    expect(await leftovers()).toEqual([]);
  });

  test("cancel kills the tool and removes the staging folder", async () => {
    if (!has("tar") || !has("gzip")) return;
    await mkdir(join(root, "big"));
    await sh(
      "dd",
      "if=/dev/zero",
      `of=${join(root, "big/zero")}`,
      "bs=1M",
      "count=400",
      "status=none",
    );
    await sh("tar", "-czf", "big.tar.gz", "big");
    await rm(join(root, "big"), { recursive: true });
    const jobs = createArchiveJobs(runHostScript);
    const id = jobs.start(
      undefined,
      "w1",
      "extract",
      extractScript({
        archive: join(root, "big.tar.gz"),
        parent: root,
        folder: "big",
        tool: "tar",
      }),
    );
    while ((await leftovers()).length === 0) await Bun.sleep(10);
    expect(() => jobs.cancel(id, "w2")).toThrow("unknown archive job");
    expect(jobs.cancel(id, "w1").state).toBe("canceled");
    for (let i = 0; i < 200 && (await leftovers()).length; i += 1) {
      await Bun.sleep(20);
    }
    expect(await leftovers()).toEqual([]);
    expect(await readdir(root)).toEqual(["big.tar.gz"]);
  });
});
