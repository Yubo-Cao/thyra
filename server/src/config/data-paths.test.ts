import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dataRoot, defaultDataFile, publishDataFile } from "./data-paths";

const roots: string[] = [];
function home() {
  const root = mkdtempSync(join(tmpdir(), "thyra-data-"));
  roots.push(root);
  return root;
}
function write(path: string, value: string, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode });
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("fresh Unix and Windows data roots respect APPDATA", () => {
  const root = home();
  expect(dataRoot(root, "linux")).toBe(join(root, ".config", "thyra"));
  expect(dataRoot(root, "win32", join(root, "custom"))).toBe(
    join(root, "custom", "thyra"),
  );
  expect(dataRoot(root, "win32", undefined)).toBe(
    join(root, "AppData", "Roaming", "thyra"),
  );
  expect(
    existsSync(defaultDataFile("settings.json", root, "linux")),
  ).toBeFalse();
});

test("data files never read other product directories", () => {
  const root = home();
  for (const product of ["roamgate", "herdr-gui"]) {
    for (const name of ["auth-token", "settings.json", "connections.json"]) {
      write(join(root, ".config", product, name), '{"version":1}\n');
    }
  }
  for (const name of [
    "auth-token",
    "settings.json",
    "connections.json",
  ] as const) {
    const target = defaultDataFile(name, root, "linux");
    expect(target).toBe(join(root, ".config", "thyra", name));
    expect(existsSync(target)).toBeFalse();
  }
  expect(existsSync(dataRoot(root, "linux"))).toBeFalse();
});

test("refuses symlinked data directories and files", () => {
  const root = home();
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  mkdirSync(join(root, ".config"));
  symlinkSync(elsewhere, dataRoot(root, "linux"));
  expect(() => defaultDataFile("settings.json", root, "linux")).toThrow(
    "symlink",
  );
  rmSync(dataRoot(root, "linux"));
  mkdirSync(dataRoot(root, "linux"));
  symlinkSync(
    join(elsewhere, "token"),
    join(dataRoot(root, "linux"), "auth-token"),
  );
  expect(() => defaultDataFile("auth-token", root, "linux")).toThrow("symlink");
});

test("failed publication leaves no partial target and retries without overwriting", () => {
  const root = home();
  const target = join(root, "thyra", "settings.json");
  write(dirname(target), "not a directory");
  expect(() => publishDataFile(target, "first")).toThrow();
  rmSync(dirname(target));
  publishDataFile(target, "first");
  publishDataFile(target, "second");
  expect(readFileSync(target, "utf8")).toBe("first");
  expect(readdirSync(dirname(target))).toEqual(["settings.json"]);
});

test("settings caller saves privately; clearing profiles stays cleared on next launch", async () => {
  const root = home();
  const current = dataRoot(
    root,
    process.platform,
    join(root, "AppData", "Roaming"),
  );
  write(
    join(current, "settings.json"),
    JSON.stringify({ version: 1, custom: { saved: "kept" } }),
  );
  const registry = JSON.stringify({
    version: 1,
    default_connection_id: "one",
    profiles: [
      {
        id: "one",
        label: "Local",
        type: "local",
        control_socket_path: "/tmp/control.sock",
        client_socket_path: "/tmp/client.sock",
        auto_connect: false,
      },
    ],
  });
  const connections = join(current, "connections.json");
  write(connections, registry);
  const script = `
    import { readGuiSettings, updateGuiSettings, guiSettingsPath } from ${JSON.stringify(join(import.meta.dir, "gui-settings.ts"))};
    import { ConnectionProfileStore } from ${JSON.stringify(join(import.meta.dir, "../connections/profiles.ts"))};
    import { statSync } from "node:fs";
    const settings = await readGuiSettings();
    if (settings.custom.saved !== "kept") throw new Error("lost settings");
    await updateGuiSettings(current => ({...current, custom: {...current.custom, changed: true}}));
    if (process.platform !== "win32" && (statSync(guiSettingsPath()).mode & 0o777) !== 0o600) throw new Error("settings permissions");
    const store = new ConnectionProfileStore();
    if (!store.load()) throw new Error("lost profiles");
    await store.clear();
    if (new ConnectionProfileStore().load() !== null) throw new Error("profiles resurrected");
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      APPDATA: join(root, "AppData", "Roaming"),
      THYRA_CONNECTIONS_PATH: undefined,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toBe("");
  expect(await child.exited).toBe(0);
  expect(existsSync(connections)).toBeFalse();
  expect(readdirSync(current)).toEqual(["settings.json"]);
});

test("concurrent fresh authentication returns the same complete token", async () => {
  const root = home();
  const target = join(dataRoot(root), "auth-token");
  const script = `import { loadOrCreateAuthToken } from ${JSON.stringify(join(import.meta.dir, "auth-token.ts"))}; console.log(loadOrCreateAuthToken(process.argv[1]));`;
  const children = Array.from({ length: 6 }, () =>
    Bun.spawn([process.execPath, "-e", script, target], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const tokens = await Promise.all(
    children.map(async (child) => {
      const value = (await new Response(child.stdout).text()).trim();
      expect(await child.exited).toBe(0);
      expect(value).toMatch(/^[a-f0-9]{64}$/);
      return value;
    }),
  );
  expect(new Set(tokens).size).toBe(1);
  expect(readFileSync(target, "utf8").trim()).toBe(tokens[0]);
  expect(readdirSync(dirname(target))).toEqual(["auth-token"]);
});

test("plugin URL reads only the Thyra env file and token", async () => {
  const root = home();
  const appData = join(root, "AppData", "Roaming");
  const current = dataRoot(root, process.platform, appData);
  const legacy = join(dirname(current), "herdr-gui");
  write(join(legacy, "herdr-gui.env"), "HOST=0.0.0.0\nPORT=8890\n");
  write(join(legacy, "auth-token"), `${"c".repeat(64)}\n`);
  const script = `import { computeUrl } from ${JSON.stringify(join(import.meta.dir, "../../..", "scripts/thyra-plugin.ts"))}; console.log(computeUrl());`;
  const invoke = async () => {
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, HOME: root, USERPROFILE: root, APPDATA: appData },
      stdout: "pipe",
      stderr: "pipe",
    });
    const value = (await new Response(child.stdout).text()).trim();
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await child.exited).toBe(0);
    return value;
  };
  expect(await invoke()).toBe("http://127.0.0.1:8787");
  write(join(current, "thyra.env"), "HOST=0.0.0.0\nPORT=8891\n");
  write(join(current, "auth-token"), `${"d".repeat(64)}\n`);
  expect(await invoke()).toBe(`http://localhost:8891/?token=${"d".repeat(64)}`);
});
