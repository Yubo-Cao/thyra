import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunHostScript } from "./file-host";
import { FileConflictError } from "./file-manager";
import { createTrash, createTrashRegistry, trashInfoPath } from "./file-trash";

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
const operations = createTrash(localBash);

test("trash info paths are percent-encoded", () => {
  expect(trashInfoPath("/tmp/a b/ü%.txt")).toBe("/tmp/a%20b/%C3%BC%25.txt");
});

describe.each(hosts)("%s trash", (_label, host) => {
  test("trashes to the freedesktop trash and restores", async () => {
    await mkdir(join(root, "work"));
    await writeFile(join(root, "work/note.txt"), "keep me");
    const [entry] = await operations.trash(
      host,
      [join(root, "work/note.txt")],
      new Set([join(root, "work")]),
    );
    expect(entry?.method).toBe("freedesktop");
    expect(entry?.trashed).toBe(join(data, "Trash/files/note.txt"));
    const info = await readFile(
      join(data, "Trash/info/note.txt.trashinfo"),
      "utf8",
    );
    expect(info).toContain(
      `Path=${trashInfoPath(join(root, "work/note.txt"))}`,
    );
    expect(info).toMatch(/DeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);

    await writeFile(join(root, "work/note.txt"), "second");
    const [second] = await operations.trash(
      host,
      [join(root, "work/note.txt")],
      new Set(),
    );
    expect(second?.trashed).toBe(join(data, "Trash/files/note.txt.2"));

    await operations.restore(host, [entry!]);
    expect(await readFile(join(root, "work/note.txt"), "utf8")).toBe("keep me");
    expect(await readdir(join(data, "Trash/info"))).toEqual([
      "note.txt.2.trashinfo",
    ]);
    await expect(operations.restore(host, [second!])).rejects.toBeInstanceOf(
      FileConflictError,
    );
    await expect(
      operations.trash(
        host,
        [join(root, "work")],
        new Set([join(root, "work")]),
      ),
    ).rejects.toThrow("root directory");
  });
});

test("trash tokens restore only in the workspace and scope that made them", () => {
  const registry = createTrashRegistry();
  const context = { host: undefined, workspaceId: "w1", filesystem: false };
  const token = registry.add(
    { original: "/a", trashed: "/t/a", method: "freedesktop" },
    context,
  );
  expect(() =>
    registry.take([token], { ...context, workspaceId: "w2" }),
  ).toThrow("can no longer be undone");
  expect(() =>
    registry.take([token], { ...context, filesystem: true }),
  ).toThrow("can no longer be undone");
  expect(registry.take([token], context)).toHaveLength(1);
  expect(() => registry.take([token], context)).toThrow();
});
