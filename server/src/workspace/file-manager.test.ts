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
import type { RunHostScript } from "./file-host";
import {
  FileConflictError,
  createFileOperations,
  variantName,
} from "./file-manager";

let root = "";
let data = "";
const previousData = process.env.XDG_DATA_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thyra-file-manager-"));
  data = join(root, ".data");
  process.env.XDG_DATA_HOME = data;
});

afterEach(async () => {
  if (previousData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousData;
  await rm(root, { recursive: true, force: true });
});

/** Runs the SSH scripts with the local bash, as the remote host would. */
const localBash: RunHostScript = async (_host, script, options) => {
  const proc = Bun.spawn(["bash", "-c", script], {
    env: { ...process.env, XDG_DATA_HOME: data },
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.input !== undefined && proc.stdin) {
    proc.stdin.write(options.input);
    proc.stdin.end();
  }
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

const hosts: Array<[string, string | undefined]> = [
  ["local", undefined],
  ["ssh", "remote-host"],
];
const operations = createFileOperations(localBash);

test("variant names follow the copy and numbered styles", () => {
  expect(variantName("report.txt", 1, "copy")).toBe("report copy.txt");
  expect(variantName("report.txt", 2, "copy")).toBe("report copy 2.txt");
  expect(variantName("archive.tar.gz", 1, "number")).toBe("archive.tar (2).gz");
  expect(variantName("src.d", 1, "copy", true)).toBe("src.d copy");
  expect(variantName(".env", 1, "copy")).toBe(".env copy");
});

describe.each(hosts)("%s file operations", (_label, host) => {
  test("renames in place and refuses names that leave the directory", async () => {
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    expect(await operations.rename(host, join(root, "a.txt"), "c.txt")).toBe(
      join(root, "c.txt"),
    );
    expect(await readFile(join(root, "c.txt"), "utf8")).toBe("a");
    await expect(
      operations.rename(host, join(root, "c.txt"), "b.txt"),
    ).rejects.toBeInstanceOf(FileConflictError);
    for (const name of ["../escape", "a/b", "..", "", "x\0y"]) {
      await expect(
        operations.rename(host, join(root, "c.txt"), name),
      ).rejects.toThrow("invalid file name");
    }
  });

  test("copies with copy names, moves, and replaces on request", async () => {
    await mkdir(join(root, "src/inner"), { recursive: true });
    await mkdir(join(root, "dest"));
    await writeFile(join(root, "src/a.txt"), "a");
    await symlink("a.txt", join(root, "src/link"));
    const transfer = (
      paths: string[],
      destination: string,
      mode: "move" | "copy",
      conflict: "fail" | "rename" | "replace" = "fail",
    ) =>
      operations.transfer(host, {
        paths,
        destination,
        mode,
        conflict,
        protectedPaths: new Set([root]),
      });

    const duplicate = await transfer(
      [join(root, "src/a.txt"), join(root, "src/a.txt")],
      join(root, "src"),
      "copy",
      "rename",
    );
    expect(duplicate.map((item) => item.path)).toEqual([
      join(root, "src/a copy.txt"),
      join(root, "src/a copy 2.txt"),
    ]);
    const copied = await transfer(
      [join(root, "src")],
      join(root, "dest"),
      "copy",
    );
    expect(copied[0]?.path).toBe(join(root, "dest/src"));
    // Symlinks are copied as links, not followed.
    expect(await readdir(join(root, "dest/src"))).toContain("link");
    await expect(
      transfer([join(root, "src")], join(root, "dest"), "copy"),
    ).rejects.toBeInstanceOf(FileConflictError);
    await expect(
      transfer([join(root, "src")], join(root, "src/inner"), "move"),
    ).rejects.toThrow("into itself");
    await expect(transfer([root], join(root, "dest"), "move")).rejects.toThrow(
      "root directory",
    );

    await writeFile(join(root, "dest/a.txt"), "old");
    await transfer(
      [join(root, "src/a.txt")],
      join(root, "dest"),
      "move",
      "replace",
    );
    expect(await readFile(join(root, "dest/a.txt"), "utf8")).toBe("a");
    const same = await transfer(
      [join(root, "dest/a.txt")],
      join(root, "dest"),
      "move",
    );
    expect(same[0]?.path).toBe(join(root, "dest/a.txt"));
  });
});
