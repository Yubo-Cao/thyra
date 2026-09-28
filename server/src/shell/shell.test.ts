import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  writeFile,
  chmod,
  mkdir,
  readdir,
  rm,
  symlink,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ShellStateTracker,
  parseShellRecord,
  readShellRecord,
  encodeSubmit,
  type ShellRecord,
} from "./state";
import { ShellHistoryStore, parseHistory, unmetafy } from "./history";
import { ShellCompleter, completionToken } from "./completion";
import { refreshShellScripts, shellIntegration } from "./installer";
import { shellPaths, paneFilename } from "./paths";
import { lookupRpc } from "../authz/policy";
import { isBridgeGlobalMethod } from "../connections/protocol";
import { createShellService } from "./service";

const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "thyra-shell-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const record = (override: Partial<ShellRecord> = {}): ShellRecord => ({
  v: 1,
  pane: "pane:1",
  pid: process.pid,
  shell: "bash",
  shell_version: "5.2",
  seq: 1,
  state: "prompt",
  cwd: "/tmp",
  exit: 0,
  histfile: "",
  bracketed_paste: true,
  ts: Date.now(),
  ...override,
});
async function fixture(value = record()) {
  const dir = await temp();
  const file = join(dir, paneFilename(value.pane));
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return { dir, file };
}
describe("shell state", () => {
  test("validates shape, private permissions, owner and symlinks", async () => {
    const { file, dir } = await fixture();
    expect(parseShellRecord({ ...record(), pid: -1 })).toBeNull();
    expect(parseShellRecord({ ...record(), seq: 0 })).toBeNull();
    expect(await readShellRecord(file)).not.toBeNull();
    expect(
      await readShellRecord(file, (process.getuid?.() ?? 0) + 1),
    ).toBeNull();
    await chmod(file, 0o644);
    expect(await readShellRecord(file)).toBeNull();
    await symlink(file, join(dir, "link"));
    expect(await readShellRecord(join(dir, "link"))).toBeNull();
  });
  test("rejects live forged pid and dead processes", async () => {
    const { dir } = await fixture();
    for (const [pid, alive] of [
      [process.pid + 1, true],
      [process.pid, false],
    ] as const) {
      const tracker = new ShellStateTracker({
        dir,
        alive: () => alive,
        call: async () => ({
          process_info: { shell_pid: pid, foreground_process_group_id: pid },
        }),
      });
      expect((await tracker.refresh("pane:1")).reason).toBe("no_integration");
    }
  });
  test("dirty and submitted persist until a fresh prompt; foreground and alternate-screen gates", async () => {
    const { dir, file } = await fixture();
    let foreground = process.pid;
    const calls: string[] = [];
    const tracker = new ShellStateTracker({
      dir,
      call: async (method) => {
        calls.push(method);
        return {
          process_info: {
            shell_pid: process.pid,
            foreground_process_group_id: foreground,
          },
        };
      },
    });
    expect((await tracker.refresh("pane:1")).available).toBe(true);
    tracker.dirty("pane:1");
    expect((await tracker.refresh("pane:1")).reason).toBe("dirty");
    await writeFile(file, JSON.stringify(record({ seq: 2 })));
    expect((await tracker.refresh("pane:1")).available).toBe(true);
    foreground++;
    expect((await tracker.refresh("pane:1")).reason).toBe("busy");
    foreground--;
    tracker.setAlternate("pane:1", true);
    expect((await tracker.refresh("pane:1")).reason).toBe("alternate_screen");
    tracker.setAlternate("pane:1", false);
    expect(
      await tracker.submit({
        pane_id: "pane:1",
        seq: 1,
        text: "ls",
        execute: true,
      }),
    ).toEqual({ ok: false, reason: "stale_seq" });
    expect(
      await tracker.submit({
        pane_id: "pane:1",
        seq: 2,
        text: "ls",
        execute: true,
      }),
    ).toEqual({ ok: true });
    expect((await tracker.refresh("pane:1")).reason).toBe("submitted");
    expect(calls.filter((method) => method === "pane.send_input")).toHaveLength(
      1,
    );
  });
  test("raw input during fresh process check and concurrent submissions fail closed", async () => {
    const { dir } = await fixture();
    let release!: () => void;
    let checking!: () => void;
    const started = new Promise<void>((resolve) => {
      checking = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tracker = new ShellStateTracker({
      dir,
      call: async () => {
        checking();
        await gate;
        return {
          process_info: {
            shell_pid: process.pid,
            foreground_process_group_id: process.pid,
          },
        };
      },
    });
    const request = { pane_id: "pane:1", seq: 1, text: "ls", execute: true };
    const first = tracker.submit(request);
    await started;
    expect(await tracker.submit(request)).toEqual({
      ok: false,
      reason: "busy",
    });
    tracker.dirty("pane:1");
    release();
    expect(await first).toEqual({ ok: false, reason: "dirty" });
  });
  test("submit encoding", () => {
    expect(encodeSubmit("a\nb\x1b[201~c", true, true)).toEqual({
      text: "a\nbc",
      keys: ["Enter"],
    });
    expect(encodeSubmit("ls", false, true)).toEqual({ text: "ls", keys: [] });
    expect(encodeSubmit("a\nb", true, true, "ble")).toEqual({
      text: "a\nb",
      keys: ["ctrl+j"],
    });
    expect(encodeSubmit("ls", true, true, "ble")).toEqual({
      text: "ls",
      keys: ["Enter"],
    });
    expect(encodeSubmit("ls", true, false)).toEqual({
      text: "ls",
      keys: ["Enter"],
    });
    expect(encodeSubmit("\x1b[201\x1b[201~~", false, true)).toEqual({
      text: "",
      keys: [],
    });
    expect(encodeSubmit("a\nb", true, false)).toEqual({
      ok: false,
      reason: "multiline",
    });
    expect(encodeSubmit("\x1b[A", false, false)).toEqual({
      ok: false,
      reason: "invalid_text",
    });
  });
  test("input after an unobserved prompt cannot be cleared by the watcher", async () => {
    const { dir, file } = await fixture();
    const tracker = new ShellStateTracker({
      dir,
      call: async () => ({
        process_info: {
          shell_pid: process.pid,
          foreground_process_group_id: process.pid,
        },
      }),
    });
    await tracker.refresh("pane:1");
    await writeFile(file, JSON.stringify(record({ seq: 2 })));
    tracker.dirty("pane:1");
    expect((await tracker.refresh("pane:1")).reason).toBe("dirty");
    await writeFile(file, JSON.stringify(record({ seq: 3 })));
    expect((await tracker.refresh("pane:1")).available).toBe(true);
  });
});
describe("history", () => {
  test("bash timestamps and multiline, zsh extended/metafied, fish escaping", () => {
    expect(
      parseHistory("bash", Buffer.from("ls\n secret\npwd\n")).map(
        (r) => r.command,
      ),
    ).toEqual(["ls", "pwd"]);
    expect(
      parseHistory(
        "bash",
        Buffer.from("#1700000000\necho one\ntwo\n#1700000001\npwd\n"),
      )[0],
    ).toEqual({
      command: "echo one\ntwo",
      start_ts: 1700000000000,
      end_ts: null,
    });
    const zsh = Buffer.concat([
      Buffer.from(": 1700000000:2;echo a\\\nb"),
      Buffer.from([0x83, 0xa3]),
      Buffer.from("\n"),
    ]);
    expect(unmetafy(Buffer.from([0x83, 0x20]))).toBe("\0");
    expect(parseHistory("zsh", zsh)[0]?.command).toBe("echo a\nb\ufffd");
    expect(parseHistory("zsh", zsh)[0]?.end_ts).toBe(1700000002000);
    expect(
      parseHistory(
        "fish",
        Buffer.from(
          "- cmd: echo a\\nb\\\\c\n  when: 1700000000\n  paths:\n    - /tmp\n",
        ),
      )[0],
    ).toEqual({
      command: "echo a\nb\\c",
      start_ts: 1700000000000,
      end_ts: null,
    });
  });
  test("durable offset, partial lines, rotation, dedupe, completion and ranking", async () => {
    const dir = await temp();
    const spool = join(dir, "spool");
    const path = join(dir, "history.sqlite");
    const a = {
      pane: "a",
      pid: 1,
      seq: 1,
      shell: "bash",
      cwd: "/project",
      command: "git status",
      start_ts: Date.now(),
    };
    await writeFile(spool, `${JSON.stringify(a)}\n{"pid":1`, { mode: 0o600 });
    let store = new ShellHistoryStore(path, spool);
    await store.ingest();
    await store.ingest();
    await store.close();
    store = new ShellHistoryStore(path, spool);
    await appendFile(spool, ',"seq":1,"exit":3,"end_ts":9999999999999}\n');
    await store.ingest();
    expect(store.search({ pane_id: "a" }, "/project")[0]?.exit).toBe(3);
    await appendFile(
      spool,
      JSON.stringify({ ...a, seq: 2, command: "echo git", cwd: "/elsewhere" }) +
        "\n",
    );
    await store.ingest();
    const matches = store.search({ pane_id: "a", prefix: "git" }, "/project");
    expect(matches.map((r) => r.command)).toEqual(["git status", "echo git"]);
    expect(
      store.search({ pane_id: "a", query: "gts" }, "/project"),
    ).toHaveLength(1);
    const histfile = join(dir, "bash_history");
    await writeFile(histfile, "git status\nls\n");
    await store.import(record({ histfile }));
    await store.import(record({ histfile }));
    expect(
      store.search({ pane_id: "a", latest: true }, "/project"),
    ).toHaveLength(3);
    await rm(spool);
    await writeFile(
      spool,
      JSON.stringify({ ...a, seq: 3, command: "pwd" }) + "\n",
      { mode: 0o600 },
    );
    await store.ingest();
    expect(
      store.search({ pane_id: "a", latest: true }, "/project"),
    ).toHaveLength(4);
    await store.close();
  });
});
describe("completion", () => {
  test("quotes, escapes, tilde and cursor mid-token", () => {
    expect(completionToken('cat "some file" rest', 9)).toEqual({
      start: 4,
      end: 15,
      prefix: "some",
      before: ["cat"],
    });
    expect(completionToken("cat some\\ file", 14).prefix).toBe("some file");
    expect(completionToken("cat ~/foo", 9).prefix).toBe("~/foo");
    expect(completionToken("git switch ", 11).before).toEqual([
      "git",
      "switch",
    ]);
  });
  test("cwd files, hidden filtering, executables, quoting, source cap and git branches", async () => {
    const dir = await temp();
    await mkdir(join(dir, "a dir"));
    await writeFile(join(dir, ".hidden"), "");
    await writeFile(join(dir, "my-executable"), "", { mode: 0o700 });
    await writeFile(join(dir, "my-not-executable"), "", { mode: 0o600 });
    const completer = new ShellCompleter();
    const state = record({ cwd: dir, path: dir });
    expect((await completer.complete(state, "cat a", 5)).items).toContainEqual({
      text: "a\\ dir/",
      kind: "dir",
    });
    expect(
      (await completer.complete(state, "cat ", 4)).items.some(
        (item) => item.text === ".hidden",
      ),
    ).toBe(false);
    expect(
      (await completer.complete(state, "cat .", 5)).items.some(
        (item) => item.text === ".hidden",
      ),
    ).toBe(true);
    expect((await completer.complete(state, "my-", 3)).items).toContainEqual({
      text: "my-executable",
      kind: "command",
    });
    const init = Bun.spawn(["git", "init", "-q", dir]);
    expect(await init.exited).toBe(0);
    const commit = Bun.spawn(
      [
        "git",
        "-C",
        dir,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "Test",
      ],
      { stderr: "pipe" },
    );
    expect(await commit.exited).toBe(0);
    const ref = Bun.spawn(["git", "-C", dir, "branch", "test-branch"]);
    expect(await ref.exited).toBe(0);
    expect(
      (await completer.complete(state, "git switch test", 15)).items,
    ).toContainEqual({ text: "test-branch", kind: "branch" });
  });
});
describe("installer and protocol", () => {
  test("idempotent install/uninstall, backup, shell discovery, XDG and embedded files", async () => {
    const home = await temp();
    const env = {
      HOME: home,
      XDG_DATA_HOME: join(home, "data with 'quote"),
      XDG_CONFIG_HOME: join(home, "config"),
    };
    await writeFile(join(home, ".bashrc"), "# user rc\n");
    await shellIntegration(
      "install",
      ["bash", "zsh", "fish"],
      env,
      (shell) => shell !== "fish",
    );
    // A shell without an rc file is left alone rather than given one.
    expect(await readdir(home)).not.toContain(".zshrc");
    const zdotdir = join(home, "zdot");
    await mkdir(zdotdir);
    await writeFile(join(zdotdir, ".zshrc"), "# zsh rc");
    await shellIntegration(
      "install",
      ["zsh"],
      { ...env, ZDOTDIR: zdotdir },
      () => true,
    );
    expect(await readFile(join(zdotdir, ".zshrc"), "utf8")).toMatch(
      /^# zsh rc\n# >>> thyra shell integration >>>\n/,
    );
    const first = await readFile(join(home, ".bashrc"), "utf8");
    await shellIntegration("install", ["bash", "zsh"], env, () => true);
    expect(await readFile(join(home, ".bashrc"), "utf8")).toBe(first);
    expect(
      (await readdir(home)).filter((name) => name.startsWith(".bashrc.bak")),
    ).toHaveLength(1);
    await shellIntegration("uninstall", ["bash", "zsh"], env, () => true);
    expect(await readFile(join(home, ".bashrc"), "utf8")).toBe("# user rc\n");
    await refreshShellScripts(env);
    expect(
      await readFile(join(shellPaths(env).scripts, "thyra.bash"), "utf8"),
    ).toContain("__thyra_prompt");
  });
  test("RPCs are connection scoped and require input-writer permission", () => {
    for (const method of [
      "shell.submit",
      "shell.complete",
      "shell.history",
      "shell.subscribe",
    ]) {
      expect(isBridgeGlobalMethod(method)).toBe(false);
      expect(lookupRpc(method)).toMatchObject({
        allowed: true,
        entry: { class: "write", writer: "input" },
      });
    }
  });
  test("subscription snapshot, updates and disconnect cleanup", async () => {
    const { dir } = await fixture();
    const service = createShellService({
      dir,
      stateDir: dir,
      call: async () => ({
        process_info: {
          shell_pid: process.pid,
          foreground_process_group_id: process.pid,
        },
      }),
    });
    const client = {};
    const events: unknown[] = [];
    expect(
      await service.rpc(
        "shell.subscribe",
        { pane_id: "pane:1" },
        client,
        (state) => events.push(state),
      ),
    ).toMatchObject({ available: true });
    service.state.dirty("pane:1");
    expect(events).toHaveLength(1);
    service.unsubscribe(client);
    service.state.setAlternate("pane:1", true);
    expect(events).toHaveLength(1);
    await service.stop();
  });
  test("SSH socket profiles never inspect local shell data", async () => {
    const { dir } = await fixture();
    let called = false;
    const service = createShellService({
      enabled: false,
      dir,
      call: async () => {
        called = true;
        return {};
      },
    });
    expect(
      await service.rpc("shell.subscribe", { pane_id: "pane:1" }, {}, () => {}),
    ).toMatchObject({ available: false, reason: "no_integration" });
    await expect(
      service.rpc("shell.history", { pane_id: "pane:1" }, {}, () => {}),
    ).rejects.toThrow("no_integration");
    expect(called).toBe(false);
    await service.stop();
  });
});
