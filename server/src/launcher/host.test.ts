import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalLauncherHost,
  createSshLauncherHost,
  parseListingOutput,
  parseProbeOutput,
} from "./host";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

test("parses the remote probe, tolerating a login banner", () => {
  const probe = parseProbeOutput(
    "Welcome!\nHOME\0/home/me\0DIR\0/home/me/a\0DIR\0/srv/b c\0ZOXIDE\0 10.0 /home/me/z\n2 /srv/y\n\0",
  );
  expect(probe.home).toBe("/home/me");
  expect([...probe.directories]).toEqual(["/home/me/a", "/srv/b c"]);
  expect(probe.zoxide).toEqual([
    { path: "/home/me/z", score: 10 },
    { path: "/srv/y", score: 2 },
  ]);
  expect(parseProbeOutput("HOME\0/root\0").zoxide).toBeNull();
  expect(() => parseProbeOutput("HOME\0\0")).toThrow("home");
});

test("parses the remote listing", () => {
  expect(
    parseListingOutput(
      "PWD\0/srv\0D\0beta\0D\0Alpha\0D\0line\nbreak\0TRUNCATED\0",
    ),
  ).toEqual({
    path: "/srv",
    directories: ["Alpha", "beta", "line\nbreak"],
    truncated: true,
  });
  expect(() => parseListingOutput("")).toThrow("unable to list");
});

test("remote commands quote every path argument", async () => {
  const calls: string[][] = [];
  const host = createSshLauncherHost({
    host: "box",
    shQuote: (value) => `'${value.replace(/'/g, `'\\''`)}'`,
    runProcessWithCodeTimeout: async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "HOME\0/home/me\0", stderr: "" };
    },
  });
  await host.probe(["/tmp/it's here"], { zoxide: false });
  const command = calls[0].at(-1) ?? "";
  expect(calls[0]).toContain("box");
  expect(command.startsWith("bash -lc ")).toBe(true);
  expect(command.endsWith(`thyra-launcher '0' '/tmp/it'\\''s here'`)).toBe(
    true,
  );
});

test("remote failures surface stderr", async () => {
  const host = createSshLauncherHost({
    host: "box",
    shQuote: (value) => `'${value}'`,
    runProcessWithCodeTimeout: async () => ({
      code: 3,
      stdout: "",
      stderr: "not a directory: /nope\n",
    }),
  });
  await expect(host.listDirectories("/nope", false)).rejects.toThrow(
    "not a directory: /nope",
  );
});

test("local host checks directories and lists visible subfolders", async () => {
  const root = await mkdtemp(join(tmpdir(), "thyra-launcher-"));
  directories.push(root);
  await mkdir(join(root, "b-project"));
  await mkdir(join(root, "A-project"));
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, "file.txt"), "x");
  await symlink(join(root, "b-project"), join(root, "link"));
  const host = createLocalLauncherHost(async () => ({
    code: 1,
    stdout: "",
    stderr: "",
  }));
  const probe = await host.probe(
    [root, join(root, "file.txt"), join(root, "missing")],
    { zoxide: false },
  );
  expect([...probe.directories]).toEqual([root]);
  expect(probe.zoxide).toBeNull();
  expect(await host.listDirectories(root, false)).toEqual({
    path: root,
    directories: ["A-project", "b-project", "link"],
    truncated: false,
  });
  expect((await host.listDirectories(root, true)).directories).toContain(
    ".hidden",
  );
});
