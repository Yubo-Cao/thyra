#!/usr/bin/env bun
/**
 * Measure cold and warm page loads of a production build over a throttled link.
 *
 * Not part of CI or the test suite. It starts a throwaway Herdr server with its
 * own XDG_CONFIG_HOME (every inherited HERDR_* variable removed, so it can
 * never attach to a live server), runs Thyra from source against the built
 * `server/public` on a spare loopback port, and puts a bandwidth- and
 * latency-shaping TCP proxy in front of it. Both Chromium and WebKit reach
 * the app through that proxy, so throttling covers documents, assets,
 * service-worker fetches and the WebSocket alike.
 *
 *   bun run build:web
 *   bun scripts/measure-first-load.ts [--browser chromium,webkit]
 *     [--profile 10k,3g] [--runs 1] [--server-root <checkout>] [--json out.json]
 *     [--public-dir <build>] [--next-public-dir <build>] [--waterfall] [--debug]
 *
 * Each browser loads the app cold (fresh profile), warm (same profile), after
 * a deploy of `--next-public-dir` (same profile, restarted bridge) and, in
 * Chromium, "evicted" (HTTP cache cleared, service-worker storage kept).
 * `--server-root` runs the bridge from another checkout (with its own built
 * `server/public`) for before/after comparisons. Page timings are sensitive
 * to host CPU load; compare runs taken back to back and read the wire bytes.
 *
 * Metrics per run (milliseconds from navigation start):
 *   fcp       first contentful paint
 *   switcher  the second workspace's label is visible (agent list usable)
 *   terminal  the pre-printed marker line has reached the mounted terminal
 *   wire      bytes through the proxy (down/up) until the terminal showed
 *             output, and after the network went idle
 */
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadPlaywrightCore } from "./playwright-core";

const MARKER = "THYRA_PERF_MARKER";
const SWITCHER_LABEL = "perf-second";
const PRODUCTION_PORT = 8787;

interface NetworkProfile {
  name: string;
  downBytesPerSecond: number;
  upBytesPerSecond: number;
  rttMs: number;
}

export const PROFILES: Record<string, NetworkProfile> = {
  "10k": {
    name: "10k",
    downBytesPerSecond: 10 * 1024,
    upBytesPerSecond: 10 * 1024,
    rttMs: 300,
  },
  // Roughly Chrome DevTools' "Fast 3G".
  "3g": {
    name: "3g",
    downBytesPerSecond: 180 * 1024,
    upBytesPerSecond: 84 * 1024,
    rttMs: 560,
  },
};

const { values: options } = parseArgs({
  args: import.meta.main ? process.argv.slice(2) : [],
  options: {
    browser: { type: "string", default: "chromium,webkit" },
    profile: { type: "string", default: "10k" },
    runs: { type: "string", default: "1" },
    port: { type: "string", default: "8799" },
    "proxy-port": { type: "string", default: "8798" },
    "server-root": { type: "string" },
    "public-dir": { type: "string" },
    "next-public-dir": { type: "string" },
    "timeout-seconds": { type: "string", default: "240" },
    json: { type: "string" },
    label: { type: "string", default: "" },
    waterfall: { type: "boolean", default: false },
    debug: { type: "boolean", default: false },
  },
});

const repositoryRoot = resolve(import.meta.dir, "..");
const serverRoot = resolve(options["server-root"] ?? repositoryRoot);
const bridgePort = Number(options.port);
const proxyPort = Number(options["proxy-port"]);
if ([bridgePort, proxyPort].includes(PRODUCTION_PORT)) {
  throw new Error(`Port ${PRODUCTION_PORT} is reserved for production Thyra`);
}
const runTimeoutMs = Number(options["timeout-seconds"]) * 1000;

// ---------------------------------------------------------------------------
// Isolated Herdr + Thyra

/** Environment without any inherited Herdr or Thyra configuration. */
function isolatedEnv(root: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("HERDR_") || key.startsWith("THYRA_")) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg"),
    ...extra,
  };
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value as T;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

interface Environment {
  root: string;
  herdr: Subprocess;
  bridge: Subprocess;
  herdrCli(...args: string[]): Promise<string>;
  /** Start the bridge serving `publicDir` (default: the built frontend). */
  startBridge(publicDir?: string): Promise<void>;
}

/** Replace the running bridge, as a deploy does. */
async function restartBridge(environment: Environment, publicDir?: string) {
  environment.bridge.kill("SIGTERM");
  await Promise.race([environment.bridge.exited, Bun.sleep(5000)]);
  environment.bridge.kill("SIGKILL");
  await environment.startBridge(publicDir);
}

export async function startEnvironment(
  root_ = serverRoot,
  publicDir = options["public-dir"],
): Promise<Environment> {
  const root = mkdtempSync(join(tmpdir(), "thyra-measure-"));
  for (const dir of ["home", "xdg", "work"]) {
    Bun.spawnSync(["mkdir", "-p", join(root, dir)]);
  }
  const herdrEnv = isolatedEnv(root);
  const controlSocket = join(root, "xdg/herdr/herdr.sock");
  const clientSocket = join(root, "xdg/herdr/herdr-client.sock");
  const herdr = spawn(["herdr", "server"], {
    env: herdrEnv,
    stdout: "ignore",
    stderr: "ignore",
  });
  const herdrCli = async (...args: string[]) => {
    const child = spawn(["herdr", ...args], {
      env: herdrEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`herdr ${args.join(" ")}: ${err || out}`);
    return out;
  };
  const environment: Environment = {
    root,
    herdr,
    bridge: null as unknown as Subprocess,
    herdrCli,
    startBridge: async () => {},
  };
  try {
    await waitFor("isolated herdr sockets", () =>
      existsSync(controlSocket) && existsSync(clientSocket) ? true : null,
    );
    const work = join(root, "work");
    const first = JSON.parse(
      await herdrCli(
        "workspace",
        "create",
        "--cwd",
        work,
        "--label",
        "perf-first",
        "--focus",
      ),
    );
    await herdrCli(
      "workspace",
      "create",
      "--cwd",
      work,
      "--label",
      SWITCHER_LABEL,
      "--no-focus",
    );
    const pane = first.result.root_pane.pane_id as string;
    // The typed command must not itself contain the marker text.
    await herdrCli(
      "pane",
      "send-text",
      pane,
      `seq 1 30; printf '%s_%s\\n' THYRA_PERF MARKER`,
    );
    await herdrCli("pane", "send-keys", pane, "enter");

    const registry = join(root, "connections.json");
    writeFileSync(
      registry,
      JSON.stringify({
        version: 1,
        default_connection_id: "local",
        profiles: [
          {
            id: "local",
            label: "Local",
            type: "local",
            control_socket_path: controlSocket,
            client_socket_path: clientSocket,
            auto_connect: true,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const bridgeEnv: Record<string, string> = {
      HOST: "127.0.0.1",
      PORT: String(bridgePort),
      THYRA_CONNECTIONS_PATH: registry,
      HERDR_SOCKET_PATH: controlSocket,
      HERDR_CLIENT_SOCKET_PATH: clientSocket,
      THYRA_DISABLE_UPDATE_CHECK: "1",
      THYRA_LOG_LEVEL: "warn",
    };
    environment.startBridge = async (directory?: string) => {
      const env = { ...bridgeEnv };
      if (directory) env.PUBLIC_DIR = resolve(directory);
      environment.bridge = spawn(["bun", "server/src/index.ts"], {
        cwd: root_,
        env: isolatedEnv(root, env),
        stdout: "ignore",
        stderr: "inherit",
      });
      await waitFor("Thyra health", async () => {
        try {
          return (await fetch(`http://127.0.0.1:${bridgePort}/health`)).ok;
        } catch {
          return null;
        }
      });
    };
    await environment.startBridge(publicDir);
    return environment;
  } catch (error) {
    await stopEnvironment(environment);
    throw error;
  }
}

export async function stopEnvironment(environment: Environment) {
  environment.bridge?.kill("SIGTERM");
  await Promise.race([environment.bridge?.exited, Bun.sleep(5000)]);
  environment.bridge?.kill("SIGKILL");
  await environment.herdrCli("server", "stop").catch(() => {});
  await Promise.race([environment.herdr.exited, Bun.sleep(5000)]);
  environment.herdr.kill("SIGKILL");
  rmSync(environment.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Link shaping

/**
 * One direction of a shared bottleneck link: every connection's bytes wait for
 * the propagation delay, then share the bandwidth round-robin (like several
 * TCP flows through one radio link).
 */
class ShapedDirection {
  bytes = 0;
  lastActivity = Date.now();
  /** Long-lived streams (WebSockets) do not count as page-load activity. */
  readonly background = new WeakSet<net.Socket>();
  private readonly queues = new Map<
    net.Socket,
    { readyAt: number; data: Buffer | null }[]
  >();
  private budget = 0;
  private last = performance.now();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly bytesPerSecond: number,
    private readonly delayMs: number,
  ) {
    this.timer = setInterval(() => this.pump(), 4);
  }

  /** Queue data (or `null` for end-of-stream) toward `target`. */
  send(target: net.Socket, data: Buffer | null, extraDelayMs = 0) {
    let queue = this.queues.get(target);
    if (!queue) {
      queue = [];
      this.queues.set(target, queue);
    }
    queue.push({
      readyAt: performance.now() + this.delayMs + extraDelayMs,
      data,
    });
  }

  drop(target: net.Socket) {
    this.queues.delete(target);
  }

  private pump() {
    const now = performance.now();
    this.budget = Math.min(
      this.budget + ((now - this.last) / 1000) * this.bytesPerSecond,
      this.bytesPerSecond * 0.02 + 1500,
    );
    this.last = now;
    let progressed = true;
    while (this.budget >= 1 && progressed) {
      progressed = false;
      for (const [target, queue] of this.queues) {
        const head = queue[0];
        if (!head || head.readyAt > now) continue;
        if (head.data === null) {
          queue.shift();
          target.end();
          this.queues.delete(target);
          progressed = true;
          continue;
        }
        const size = Math.min(head.data.length, 1460, Math.floor(this.budget));
        if (size <= 0) break;
        const piece = head.data.subarray(0, size);
        head.data = head.data.subarray(size);
        if (head.data.length === 0) queue.shift();
        if (!target.destroyed) target.write(piece);
        this.budget -= size;
        this.bytes += size;
        if (!this.background.has(target)) this.lastActivity = Date.now();
        progressed = true;
      }
    }
  }

  close() {
    clearInterval(this.timer);
  }
}

/**
 * Point a request head's Host, Origin and Referer at the bridge's own port,
 * so the bridge sees direct loopback use (no login) as when the browser runs
 * on the same machine. The ports have the same length, so no byte moves.
 */
function loopbackHeaders(data: Buffer, from: number, to: number): Buffer {
  const text = data.toString("latin1");
  const end = text.indexOf("\r\n\r\n");
  const head = end < 0 ? text : text.slice(0, end);
  const rewritten = head.replace(
    new RegExp(
      `^((?:host|origin|referer):[^\\r\\n]*?127\\.0\\.0\\.1):${from}\\b`,
      "gim",
    ),
    `$1:${to}`,
  );
  if (rewritten === head || String(from).length !== String(to).length)
    return data;
  return Buffer.from(rewritten + text.slice(head.length), "latin1");
}

export class ShapingProxy {
  readonly down: ShapedDirection;
  readonly up: ShapedDirection;
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    profile: NetworkProfile,
    listenPort: number,
    upstreamPort: number,
  ) {
    const oneWay = profile.rttMs / 2;
    this.down = new ShapedDirection(profile.downBytesPerSecond, oneWay);
    this.up = new ShapedDirection(profile.upBytesPerSecond, oneWay);
    this.server = net.createServer((client) => {
      const upstream = net.connect(upstreamPort, "127.0.0.1");
      this.sockets.add(client);
      this.sockets.add(upstream);
      // Charge a TCP + TLS 1.3 handshake (two round trips) to the first bytes.
      let handshake = profile.rttMs * 2;
      // Attribute response bytes to the last request line on the connection.
      let path = "(unknown)";
      client.on("data", (data) => {
        const line = data
          .toString("latin1", 0, 300)
          .match(/^[A-Z]+ (\S+) HTTP\//);
        let forwarded: Buffer = Buffer.from(data);
        if (line) {
          path = line[1]!;
          forwarded = loopbackHeaders(forwarded, listenPort, upstreamPort);
        }
        this.up.send(upstream, forwarded, handshake);
        handshake = 0;
      });
      let firstResponse = true;
      upstream.on("data", (data) => {
        if (
          firstResponse &&
          data.toString("latin1", 0, 12) === "HTTP/1.1 101"
        ) {
          this.down.background.add(client);
          this.up.background.add(upstream);
        }
        firstResponse = false;
        this.bytesByPath.set(
          path,
          (this.bytesByPath.get(path) ?? 0) + data.length,
        );
        this.down.send(client, Buffer.from(data));
      });
      client.on("end", () => this.up.send(upstream, null));
      // Bytes still in flight must reach the browser after the bridge closes.
      let upstreamEnded = false;
      const endUpstream = () => {
        if (upstreamEnded) return;
        upstreamEnded = true;
        this.down.send(client, null);
      };
      upstream.on("end", endUpstream);
      upstream.on("close", endUpstream);
      upstream.on("error", endUpstream);
      const destroy = () => {
        this.up.drop(upstream);
        this.down.drop(client);
        client.destroy();
        upstream.destroy();
        this.sockets.delete(client);
        this.sockets.delete(upstream);
      };
      client.on("error", destroy);
      client.on("close", destroy);
    });
    this.server.listen(listenPort, "127.0.0.1");
  }

  /** Downstream bytes per request path (WebSocket frames count toward /ws). */
  readonly bytesByPath = new Map<string, number>();

  snapshot() {
    return { down: this.down.bytes, up: this.up.bytes };
  }

  idleForMs() {
    return Date.now() - Math.max(this.down.lastActivity, this.up.lastActivity);
  }

  close() {
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
    this.down.close();
    this.up.close();
  }
}

// ---------------------------------------------------------------------------
// Browser runs

/** Installed before any page script: records milestones on `window.__perf`. */
export const INSTRUMENTATION = `(() => {
  // Playwright's Linux WebKit has no push service: getSubscription() never
  // settles and wedges the page. Report "not subscribed" as a browser would.
  if (window.PushManager) PushManager.prototype.getSubscription = async () => null;
  const marks = (window.__perf = {});
  const mark = (name) => {
    if (!(name in marks)) marks[name] = performance.now();
  };
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener("open", () => mark("wsOpen"));
      this.addEventListener("message", (event) => {
        if (typeof event.data === "string" && event.data.includes(${JSON.stringify(MARKER)}))
          mark("terminalData");
      });
    }
  };
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 &&
      box.top < innerHeight && box.left < innerWidth;
  };
  const tick = () => {
    if (!marks.switcher) {
      const found = document.evaluate(
        "//*[normalize-space(text())='${SWITCHER_LABEL}']",
        document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < found.snapshotLength; i++) {
        if (visible(found.snapshotItem(i))) { mark("switcher"); break; }
      }
    }
    const screen = document.querySelector(".terminal-engine");
    if (screen && visible(screen)) mark("xterm");
    if (marks.terminalData !== undefined && marks.xterm !== undefined) mark("terminal");
    // The text shown before the GPU engine has loaded.
    const rows = document.querySelector(".terminal-engine-preview");
    if (rows && rows.textContent.includes(${JSON.stringify(MARKER)})) mark("terminalDomText");
    if (!(marks.switcher && marks.terminal)) {
      if (document.visibilityState === "visible") requestAnimationFrame(tick);
      else setTimeout(tick, 50);
    }
  };
  tick();
})();`;

/**
 * cold: empty profile. warm: same profile again. deploy (with
 * `--next-public-dir`): the bridge restarts serving another build and the same
 * profile loads again. evicted (Chromium only): the HTTP cache is cleared first
 * but service-worker storage survives, as when iOS evicts Safari's cache
 * between visits.
 */
type Phase = "cold" | "warm" | "deploy" | "evicted";

interface ResourceStat {
  count: number;
  bytes: number;
  fromCache: number;
}

interface RunResult {
  browser: string;
  profile: string;
  phase: Phase;
  fcp: number | null;
  switcher: number | null;
  terminal: number | null;
  terminalDomText: number | null;
  wireAtTerminal: { down: number; up: number };
  wireSettled: { down: number; up: number };
  resources: Record<string, ResourceStat>;
  /** Finished requests, times relative to navigation start. */
  waterfall: {
    url: string;
    type: string;
    bytes: number;
    start: number;
    end: number;
    cached: boolean;
  }[];
  serviceWorker: boolean;
  error?: string;
}

function debug(message: string) {
  if (options.debug) console.error(`[measure] ${message}`);
}

/** page.evaluate with a deadline: a busy or wedged page must not stall runs. */
async function evaluate<T>(
  page: any,
  fn: () => T | Promise<T>,
  fallback: T,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate(fn),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          debug("evaluate timed out");
          resolve(fallback);
        }, timeoutMs);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

async function measureRun(
  context: any,
  proxy: ShapingProxy,
  browserName: string,
  profile: NetworkProfile,
  phase: Phase,
): Promise<RunResult> {
  const page = await context.newPage();
  const resources: Record<string, ResourceStat> = {};
  page.on("requestfinished", async (request: any) => {
    try {
      const response = await request.response();
      const sizes = await request.sizes();
      const type = request.resourceType();
      const stat = (resources[type] ??= { count: 0, bytes: 0, fromCache: 0 });
      stat.count += 1;
      const cached =
        response?.fromServiceWorker?.() ||
        (await response?.headerValue?.("x-from-cache")) ||
        false;
      const bytes = cached
        ? 0
        : sizes.responseBodySize + sizes.responseHeadersSize;
      if (cached) stat.fromCache += 1;
      else stat.bytes += bytes;
      const timing = request.timing();
      result.waterfall.push({
        url: request.url().replace(/^https?:\/\/[^/]+/, ""),
        type,
        bytes,
        start: timing.startTime,
        end: timing.startTime + Math.max(timing.responseEnd, 0),
        cached: Boolean(cached),
      });
    } catch {
      // Requests of a closed page cannot report sizes.
    }
  });
  const start = proxy.snapshot();
  const wire = () => {
    const now = proxy.snapshot();
    return { down: now.down - start.down, up: now.up - start.up };
  };
  const result: RunResult = {
    browser: browserName,
    profile: profile.name,
    phase,
    fcp: null,
    switcher: null,
    terminal: null,
    terminalDomText: null,
    wireAtTerminal: { down: 0, up: 0 },
    wireSettled: { down: 0, up: 0 },
    resources,
    waterfall: [],
    serviceWorker: false,
  };
  try {
    await page.goto(`http://127.0.0.1:${proxyPort}/`, {
      waitUntil: "commit",
      timeout: runTimeoutMs,
    });
    const deadline = Date.now() + runTimeoutMs;
    let marks: Record<string, number> = {};
    while (Date.now() < deadline) {
      marks = await evaluate(page, () => (window as any).__perf ?? {}, marks);
      if (marks.switcher !== undefined && marks.terminal !== undefined) break;
      await Bun.sleep(100);
    }
    result.wireAtTerminal = wire();
    debug(`${phase}: marks ${JSON.stringify(marks)}`);
    // Let late work (service worker priming, fonts, lazy chunks) finish so the
    // warm run starts from a settled cache.
    const settleDeadline = Date.now() + Math.min(runTimeoutMs, 120_000);
    while (Date.now() < settleDeadline && proxy.idleForMs() < 4000) {
      await Bun.sleep(250);
    }
    result.wireSettled = wire();
    if (options.debug) {
      const top = [...proxy.bytesByPath]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([path, bytes]) => `${formatKiB(bytes)} ${path}`);
      debug(`${phase}: bytes by path\n  ${top.join("\n  ")}`);
    }
    proxy.bytesByPath.clear();
    debug(`${phase}: settled after ${JSON.stringify(result.wireSettled)}`);
    const paint = await evaluate(
      page,
      () =>
        performance.getEntriesByName("first-contentful-paint")[0]?.startTime ??
        null,
      null,
    );
    result.fcp = paint;
    const origin = await evaluate(page, () => performance.timeOrigin, 0);
    for (const entry of result.waterfall) {
      entry.start -= origin;
      entry.end -= origin;
    }
    result.waterfall.sort((a, b) => a.start - b.start);
    result.switcher = marks.switcher ?? null;
    result.terminal = marks.terminal ?? null;
    result.terminalDomText = marks.terminalDomText ?? null;
    result.serviceWorker = await evaluate(
      page,
      async () =>
        Boolean((await navigator.serviceWorker?.getRegistration("/"))?.active),
      false,
    );
    if (result.switcher === null || result.terminal === null) {
      result.error = `timed out: ${JSON.stringify(marks)}`;
    }
  } catch (error) {
    result.error = (error as Error).message;
  } finally {
    await Promise.race([page.close().catch(() => {}), Bun.sleep(10_000)]);
    debug(`${phase}: done`);
  }
  return result;
}

async function measureBrowser(
  playwright: any,
  browserName: string,
  profile: NetworkProfile,
  proxy: ShapingProxy,
  environment: Environment,
): Promise<RunResult[]> {
  const userDataDir = mkdtempSync(
    join(tmpdir(), `thyra-measure-${browserName}-`),
  );
  try {
    const context = await playwright[browserName].launchPersistentContext(
      userDataDir,
      {
        headless: true,
        // iPad landscape: the workspace list is visible beside the terminal.
        viewport: { width: 1180, height: 820 },
        deviceScaleFactor: 2,
        locale: "en-US",
        hasTouch: true,
        serviceWorkers: "allow",
      },
    );
    try {
      await context.addInitScript(INSTRUMENTATION);
      // Keep the initial blank page open: WebKit ends a persistent context
      // when its last page closes. Each run uses its own page.
      if (!context.pages().length) await context.newPage();
      const cold = await measureRun(
        context,
        proxy,
        browserName,
        profile,
        "cold",
      );
      const warm = await measureRun(
        context,
        proxy,
        browserName,
        profile,
        "warm",
      );
      const results = [cold, warm];
      const nextPublicDir = options["next-public-dir"];
      if (nextPublicDir) {
        // A deploy: the bridge restarts serving another build, and the same
        // profile loads the app again.
        await restartBridge(environment, nextPublicDir);
        try {
          results.push(
            await measureRun(context, proxy, browserName, profile, "deploy"),
          );
        } finally {
          await restartBridge(environment, options["public-dir"]);
        }
      }
      if (browserName !== "chromium") return results;
      const cdp = await context.newCDPSession(context.pages()[0]);
      await cdp.send("Network.clearBrowserCache");
      results.push(
        await measureRun(context, proxy, browserName, profile, "evicted"),
      );
      return results;
    } finally {
      await Promise.race([context.close().catch(() => {}), Bun.sleep(15_000)]);
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

function formatSeconds(ms: number | null) {
  return ms === null ? "-" : `${(ms / 1000).toFixed(1)}s`;
}

function formatKiB(bytes: number) {
  return `${(bytes / 1024).toFixed(0)}K`;
}

function report(results: RunResult[]) {
  const header = [
    "browser",
    "profile",
    "phase",
    "FCP",
    "switcher",
    "terminal",
    "down@term",
    "down total",
    "up total",
    "SW",
  ];
  const rows = results.map((r) => [
    r.browser,
    r.profile,
    r.phase,
    formatSeconds(r.fcp),
    formatSeconds(r.switcher),
    formatSeconds(r.terminal),
    formatKiB(r.wireAtTerminal.down),
    formatKiB(r.wireSettled.down),
    formatKiB(r.wireSettled.up),
    r.serviceWorker ? "yes" : "no",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ");
  console.log(line(header));
  for (const row of rows) console.log(line(row));
  for (const r of results) {
    const types = Object.entries(r.resources)
      .sort(([, a], [, b]) => b.bytes - a.bytes)
      .map(
        ([type, s]) =>
          `${type} ${s.count}x ${formatKiB(s.bytes)}${s.fromCache ? ` (${s.fromCache} from SW)` : ""}`,
      )
      .join(", ");
    console.log(`  ${r.browser}/${r.profile}/${r.phase}: ${types}`);
    if (r.error) console.log(`  ! ${r.error}`);
    if (!options.waterfall) continue;
    for (const entry of r.waterfall) {
      console.log(
        `    ${formatSeconds(entry.start).padStart(6)} -> ${formatSeconds(entry.end).padStart(6)}  ${formatKiB(entry.bytes).padStart(5)}${entry.cached ? " SW" : "   "}  ${entry.type.padEnd(10)} ${entry.url.slice(0, 90)}`,
      );
    }
  }
}

async function main() {
  // Fail fast on a syntax error instead of silently recording nothing.
  new Function(INSTRUMENTATION);
  const playwright = await loadPlaywrightCore();
  const browsers = options.browser.split(",").filter(Boolean);
  const profiles = options.profile.split(",").map((name) => {
    const profile = PROFILES[name];
    if (!profile) throw new Error(`Unknown profile ${name}`);
    return profile;
  });
  const runs = Number(options.runs);
  const environment = await startEnvironment();
  // Never leave the throwaway Herdr and bridge running after an interrupt.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stopEnvironment(environment).finally(() => process.exit(130));
    });
  }
  const results: RunResult[] = [];
  try {
    for (const profile of profiles) {
      const proxy = new ShapingProxy(profile, proxyPort, bridgePort);
      try {
        for (let run = 0; run < runs; run++) {
          for (const browserName of browsers) {
            const measured = await measureBrowser(
              playwright,
              browserName,
              profile,
              proxy,
              environment,
            );
            results.push(...measured);
            if (options.json) {
              writeFileSync(
                options.json,
                JSON.stringify({ label: options.label, results }, null, 2),
              );
            }
            for (const r of measured) {
              console.error(
                `${options.label} ${r.browser} ${r.profile} ${r.phase}: terminal ${formatSeconds(r.terminal)} switcher ${formatSeconds(r.switcher)} down ${formatKiB(r.wireSettled.down)}${r.error ? ` (${r.error})` : ""}`,
              );
            }
          }
        }
      } finally {
        proxy.close();
      }
    }
  } finally {
    await stopEnvironment(environment);
  }
  report(results);
  if (options.json) {
    writeFileSync(
      options.json,
      JSON.stringify({ label: options.label, results }, null, 2),
    );
  }
}

if (import.meta.main) await main();
