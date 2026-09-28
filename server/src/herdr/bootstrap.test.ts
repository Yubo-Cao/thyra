import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  assertManagedSetupAllowed,
  detectHerdrSetup,
  findHerdrBinary,
  setupHerdr,
} from "./bootstrap";
import { herdrManagedBinaryPath, VERIFIED_HERDR_VERSION } from "./release";

const trash: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "thyra-herdr-bootstrap-"));
  trash.push(dir);
  return dir;
}
afterEach(() => {
  while (trash.length) {
    const dir = trash.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const reachablePing = () =>
  Promise.resolve({ version: VERIFIED_HERDR_VERSION, protocol: 22 });
const failingPing = () => Promise.reject(new Error("ENOENT: no socket"));

describe("assertManagedSetupAllowed", () => {
  test("rejects non-local or customized Herdr targets", () => {
    expect(() => assertManagedSetupAllowed({ sshHost: "box" })).toThrow(
      "only available for the local Herdr server",
    );
    expect(() => assertManagedSetupAllowed({ session: "work" })).toThrow(
      "default Herdr session",
    );
    expect(() =>
      assertManagedSetupAllowed({ hasExplicitSocketPath: true }),
    ).toThrow("default Herdr socket paths");
    expect(() =>
      assertManagedSetupAllowed({ hasExplicitClientSocketPath: true }),
    ).toThrow("default Herdr socket paths");
    expect(() => assertManagedSetupAllowed({})).not.toThrow();
  });
});

describe("findHerdrBinary", () => {
  test("prefers whatever is on PATH", () => {
    const homeDir = scratch();
    const official = herdrManagedBinaryPath(homeDir, undefined, "linux");
    mkdirSync(join(official, ".."), { recursive: true });
    writeFileSync(official, "official");
    const pathDir = scratch();
    writeFileSync(join(pathDir, "herdr"), "path");
    expect(
      findHerdrBinary({ platform: "linux", homeDir, pathEnv: pathDir }),
    ).toBe(join(pathDir, "herdr"));
  });

  test("falls back to the official installer location", () => {
    const homeDir = scratch();
    const localBin = join(homeDir, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    writeFileSync(join(localBin, "herdr"), "local");
    expect(findHerdrBinary({ platform: "linux", homeDir, pathEnv: "" })).toBe(
      join(localBin, "herdr"),
    );
  });

  test("returns null when no herdr binary exists", () => {
    expect(
      findHerdrBinary({ platform: "linux", homeDir: scratch(), pathEnv: "" }),
    ).toBeNull();
  });

  test("looks for herdr.exe on Windows, including the managed directory", () => {
    const homeDir = scratch();
    const pathDir = scratch();
    writeFileSync(join(pathDir, "herdr.exe"), "exe");
    expect(
      findHerdrBinary({ platform: "win32", homeDir, pathEnv: pathDir }),
    ).toBe(join(pathDir, "herdr.exe"));

    const managedHome = scratch();
    const managed = herdrManagedBinaryPath(managedHome, undefined, "win32");
    mkdirSync(join(managed, ".."), { recursive: true });
    writeFileSync(managed, "managed");
    expect(
      findHerdrBinary({ platform: "win32", homeDir: managedHome, pathEnv: "" }),
    ).toBe(managed);
  });
});

describe("detectHerdrSetup", () => {
  test("reports a reachable server as running", async () => {
    const state = await detectHerdrSetup({ ping: reachablePing });
    expect(state).toEqual({
      state: "running",
      version: VERIFIED_HERDR_VERSION,
      protocol: 22,
      liveHandoff: false,
    });
    expect(
      await detectHerdrSetup({
        ping: () =>
          Promise.resolve({
            version: VERIFIED_HERDR_VERSION,
            protocol: 22,
            capabilities: { live_handoff: true },
          }),
      }),
    ).toMatchObject({ state: "running", liveHandoff: true });
  });

  test("distinguishes installed-but-down from missing", async () => {
    const homeDir = scratch();
    const pathDir = scratch();
    writeFileSync(join(pathDir, "herdr"), "path");
    const deps = {
      ping: failingPing,
      platform: "linux",
      homeDir,
      pathEnv: pathDir,
    };
    expect(await detectHerdrSetup(deps)).toEqual({
      state: "installed",
      binaryPath: join(pathDir, "herdr"),
    });
    expect(
      await detectHerdrSetup({ ...deps, homeDir: scratch(), pathEnv: "" }),
    ).toEqual({ state: "missing" });
  });
});

describe("setupHerdr", () => {
  test("does nothing when Herdr is already running", async () => {
    let installs = 0;
    const result = await setupHerdr({
      ping: reachablePing,
      installRelease: async () => {
        installs += 1;
        return { binaryPath: "/unused" };
      },
      installService: () => {
        installs += 1;
      },
    });
    expect(result.outcome).toBe("already-running");
    expect(installs).toBe(0);
  });

  test("starts an installed binary as a service without downloading", async () => {
    const homeDir = scratch();
    const pathDir = scratch();
    const binaryPath = join(pathDir, "herdr");
    writeFileSync(binaryPath, "path");
    const serviced: string[] = [];
    let releaseInstalls = 0;
    let pings = 0;
    const result = await setupHerdr({
      platform: "linux",
      homeDir,
      pathEnv: pathDir,
      ping: () => {
        pings += 1;
        return pings < 2 ? failingPing() : reachablePing();
      },
      installRelease: async () => {
        releaseInstalls += 1;
        return { binaryPath: "/unused" };
      },
      installService: (path) => {
        serviced.push(path);
      },
      sleep: () => Promise.resolve(),
    });
    expect(result).toEqual({
      outcome: "started",
      binaryPath,
      version: VERIFIED_HERDR_VERSION,
      protocol: 22,
    });
    expect(serviced).toEqual([binaryPath]);
    expect(releaseInstalls).toBe(0);
  });

  test("installs the verified release when no binary exists", async () => {
    const homeDir = scratch();
    const managed = herdrManagedBinaryPath(homeDir, undefined, "linux");
    const serviced: string[] = [];
    let pings = 0;
    const result = await setupHerdr({
      platform: "linux",
      homeDir,
      pathEnv: "",
      ping: () => {
        pings += 1;
        return pings < 2 ? failingPing() : reachablePing();
      },
      installRelease: async () => ({ binaryPath: managed }),
      installService: (path) => {
        serviced.push(path);
      },
      sleep: () => Promise.resolve(),
    });
    expect(result.outcome).toBe("installed-and-started");
    expect(serviced).toEqual([managed]);
  });

  test("fails when the server never becomes reachable", async () => {
    await expect(
      setupHerdr({
        ping: failingPing,
        installRelease: async () => ({ binaryPath: "/managed/herdr" }),
        installService: () => {},
        startTimeoutMs: 1,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow("did not become reachable");
  });

  test("fails fast for SSH or customized setups", async () => {
    await expect(
      setupHerdr({ guard: { sshHost: "box" }, ping: failingPing }),
    ).rejects.toThrow("only available for the local Herdr server");
  });
});

describe("setupHerdr under launchd", () => {
  const handoffPing = () =>
    Promise.resolve({
      version: VERIFIED_HERDR_VERSION,
      protocol: 22,
      capabilities: { live_handoff: true },
    });
  const supervised = {
    adopt: true,
    server: { pid: 200, state: "running" as const, alive: true },
    supervisor_pid: 100,
  };
  const unsupervised = { adopt: true, server: null, supervisor_pid: null };

  function herdrOnPath(): string {
    const pathDir = scratch();
    writeFileSync(join(pathDir, "herdr"), "");
    return pathDir;
  }

  test("adopts a running server launchd does not supervise", async () => {
    const pathDir = herdrOnPath();
    const installs: Array<{ path: string; adopt?: boolean }> = [];
    let probes = 0;
    const result = await setupHerdr({
      platform: "darwin",
      adopt: true,
      pathEnv: pathDir,
      ping: handoffPing,
      launchdServiceLoaded: () => false,
      probeSupervision: () => {
        probes += 1;
        // Supported before install; supervising a successor two polls later.
        return probes < 3 ? unsupervised : supervised;
      },
      installService: (path, options) => {
        installs.push({ path, adopt: options?.adopt });
      },
      sleep: () => Promise.resolve(),
    });
    expect(result).toEqual({
      outcome: "adopted",
      binaryPath: join(pathDir, "herdr"),
      version: VERIFIED_HERDR_VERSION,
      protocol: 22,
    });
    expect(installs).toEqual([{ path: join(pathDir, "herdr"), adopt: true }]);
  });

  test("leaves a supervised or unadoptable server alone", async () => {
    const pathDir = herdrOnPath();
    let installs = 0;
    const base = {
      platform: "darwin",
      pathEnv: pathDir,
      installService: () => {
        installs += 1;
      },
      probeSupervision: () => unsupervised,
    };
    const loaded = await setupHerdr({
      ...base,
      adopt: true,
      ping: handoffPing,
      launchdServiceLoaded: () => true,
    });
    expect(loaded).toEqual({
      outcome: "already-running",
      version: VERIFIED_HERDR_VERSION,
      protocol: 22,
    });

    const notRequested = await setupHerdr({
      ...base,
      ping: handoffPing,
      launchdServiceLoaded: () => false,
    });
    expect(notRequested).toMatchObject({ outcome: "already-running" });
    expect(notRequested).toHaveProperty("unsupervised");

    const stockServer = await setupHerdr({
      ...base,
      adopt: true,
      ping: reachablePing,
      launchdServiceLoaded: () => false,
    });
    expect(stockServer).toMatchObject({ outcome: "already-running" });
    expect((stockServer as { unsupervised: string }).unsupervised).toContain(
      "live handoff",
    );

    const oldBinary = await setupHerdr({
      ...base,
      adopt: true,
      ping: handoffPing,
      launchdServiceLoaded: () => false,
      probeSupervision: () => null,
    });
    expect((oldBinary as { unsupervised: string }).unsupervised).toContain(
      "--adopt",
    );
    expect(installs).toBe(0);
  });

  test("reports an adoption that never completes", async () => {
    await expect(
      setupHerdr({
        platform: "darwin",
        adopt: true,
        pathEnv: herdrOnPath(),
        ping: handoffPing,
        launchdServiceLoaded: () => false,
        probeSupervision: () => unsupervised,
        installService: () => {},
        adoptTimeoutMs: 1,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow("did not adopt the running Herdr server");
  });

  test("a cold start uses --adopt only when the binary supports it", async () => {
    for (const [support, expected] of [
      [unsupervised, true],
      [null, false],
    ] as const) {
      const pathDir = herdrOnPath();
      const adopts: Array<boolean | undefined> = [];
      let pings = 0;
      await setupHerdr({
        platform: "darwin",
        pathEnv: pathDir,
        homeDir: scratch(),
        ping: () => {
          pings += 1;
          return pings < 2 ? failingPing() : reachablePing();
        },
        probeSupervision: () => support,
        installService: (_path, options) => {
          adopts.push(options?.adopt);
        },
        sleep: () => Promise.resolve(),
      });
      expect(adopts).toEqual([expected]);
    }
  });
});
