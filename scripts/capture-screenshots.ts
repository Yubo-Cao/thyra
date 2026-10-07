#!/usr/bin/env bun
/**
 * Regenerate every product screenshot used by the README, docs, and website.
 *
 *   bun run build:web
 *   bun scripts/capture-screenshots.ts [--only name,...] [--port 8820]
 *     [--serve] [--keep-raw <dir>] [--debug]
 *
 * Starts a throwaway Herdr server (own HOME and XDG_CONFIG_HOME, every
 * inherited HERDR_* and THYRA_* variable removed, so it never attaches to a
 * live server), seeds the demo fixture from `scripts/demo/`, runs Thyra from
 * this checkout on a spare loopback port, captures the shots with Playwright
 * WebKit (GPU terminal renderer, Safari look), writes optimized images to the
 * paths the docs and site use, and stops everything it started. `--serve`
 * keeps the demo running for manual inspection instead of capturing.
 *
 * When bubblewrap is installed, Herdr and Thyra run in a private mount and PID
 * namespace where the demo home is `/home/demo`, so shots show neutral paths
 * and every demo process ends with its namespace. Requires `vips` for image
 * optimization and the root playwright-core devDependency with its WebKit
 * build (PLAYWRIGHT_CORE_PATH selects another playwright-core directory).
 */
import { spawn, type Subprocess } from "bun";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadPlaywrightCore } from "./playwright-core";
import zhCN from "../web/src/locales/zh-CN";
import {
  CLAUDE_API_SESSION_ID,
  CLAUDE_DOCS_SESSION_ID,
  CODEX_WEB_SESSION_ID,
  claudeApiSession,
  claudeDocsSession,
  codexWebSession,
  DEMO_EXTRA_FOLDERS,
  DEMO_LAUNCHER,
  DEMO_PROJECTS,
  DEMO_TIME,
  DEMO_TIME_ZONE,
} from "./demo/fixture";

/** Production Thyra and a long-running local instance. */
const RESERVED_PORTS = new Set([8787, 8799]);
const DEMO_HOME = "/home/demo";

const { values: options } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string", default: "8820" },
    only: { type: "string" },
    serve: { type: "boolean", default: false },
    "keep-raw": { type: "string" },
    debug: { type: "boolean", default: false },
  },
});

const repositoryRoot = resolve(import.meta.dir, "..");
const port = Number(options.port);
if (!Number.isInteger(port) || port <= 0 || RESERVED_PORTS.has(port)) {
  throw new Error(`Port ${options.port} is reserved or invalid`);
}
const baseUrl = `http://127.0.0.1:${port}/`;
const bun = process.execPath;

function log(message: string) {
  console.error(`[capture] ${message}`);
}

function debug(message: string) {
  if (options.debug) log(message);
}

// ---------------------------------------------------------------------------
// Isolated environment

interface Environment {
  /** Host temporary directory holding everything this run creates. */
  root: string;
  /** The demo home on the host. */
  hostHome: string;
  /** The demo home as Herdr, Thyra, and pane processes see it. */
  home: string;
  /** Command prefix entering the private namespace, or empty. */
  sandbox: string[];
  controlSocket: string;
  clientSocket: string;
  herdrEnv: Record<string, string>;
  herdr?: Subprocess;
  bridge?: Subprocess;
}

function which(command: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const path = join(dir, command);
    if (dir && existsSync(path)) return path;
  }
  return null;
}

/**
 * bubblewrap argv that mounts the demo home at /home/demo (keeping every real
 * home directory visible, so tools installed there still run) with private
 * PID and /proc namespaces: stopping the sandbox ends every process in it.
 */
function sandboxPrefix(hostHome: string): string[] {
  if (!which("bwrap") || existsSync(DEMO_HOME)) return [];
  const homes = readdirSync("/home").flatMap((entry) => [
    "--dev-bind-try",
    `/home/${entry}`,
    `/home/${entry}`,
  ]);
  return [
    "bwrap",
    "--dev-bind",
    "/",
    "/",
    "--tmpfs",
    "/home",
    ...homes,
    "--bind",
    hostHome,
    DEMO_HOME,
    "--unshare-pid",
    "--proc",
    "/proc",
    "--die-with-parent",
    "--",
  ];
}

/** Environment without any inherited Herdr, Thyra, Git, or XDG settings. */
function isolatedEnv(env: Environment, extra: Record<string, string> = {}) {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(HERDR|THYRA|GIT|XDG)_/.test(key)) continue;
    inherited[key] = value;
  }
  return {
    ...inherited,
    HOME: env.home,
    XDG_CONFIG_HOME: join(env.root, "xdg"),
    XDG_DATA_HOME: join(env.home, ".local/share"),
    XDG_STATE_HOME: join(env.home, ".local/state"),
    XDG_CACHE_HOME: join(env.home, ".cache"),
    LANG: "en_US.UTF-8",
    TZ: DEMO_TIME_ZONE,
    ...extra,
  };
}

async function run(
  argv: string[],
  { cwd, env }: { cwd?: string; env: Record<string, string> },
): Promise<string> {
  const child = spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${argv.join(" ")}: ${err || out}`);
  return out;
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value as T;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function write(path: string, content: string, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

/** Git repositories under ~/code with fixed authors and dates. */
async function seedProjects(env: Environment) {
  const gitEnv = isolatedEnv(env, {
    HOME: env.hostHome,
    GIT_AUTHOR_NAME: "Demo",
    GIT_AUTHOR_EMAIL: "demo@example.com",
    GIT_COMMITTER_NAME: "Demo",
    GIT_COMMITTER_EMAIL: "demo@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const git = (cwd: string, minutesAgo: number, ...args: string[]) => {
    const date = new Date(DEMO_TIME - minutesAgo * 60_000).toISOString();
    return run(["git", ...args], {
      cwd,
      env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };
  for (const project of DEMO_PROJECTS) {
    const dir = join(env.hostHome, "code", project.name);
    mkdirSync(dir, { recursive: true });
    await git(dir, 0, "init", "-q", "-b", "main");
    for (const [path, content] of Object.entries(project.files)) {
      write(join(dir, path), content);
    }
    await git(dir, 0, "add", "-A");
    await git(dir, 60 * 24 * 3, "commit", "-q", "-m", "Initial commit");
    if (project.branch) {
      await git(dir, 0, "switch", "-q", "-c", project.branch.name);
      for (const [path, content] of Object.entries(project.branch.files)) {
        write(join(dir, path), content);
      }
      await git(dir, 0, "add", "-A");
      await git(dir, 90, "commit", "-q", "-m", project.branch.message);
    }
    for (const [path, content] of Object.entries(project.working ?? {})) {
      if (content === null) rmSync(join(dir, path), { force: true });
      else write(join(dir, path), content);
    }
  }
  for (const folder of DEMO_EXTRA_FOLDERS) {
    mkdirSync(join(env.hostHome, folder), { recursive: true });
  }
}

/** Claude Code and Codex transcripts where the real agents keep them. */
function writeSessions(env: Environment) {
  const cwd = (name: string) => join(env.home, "code", name);
  const claudeDir = (name: string) =>
    join(env.hostHome, ".claude/projects", cwd(name).replace(/[/.]/g, "-"));
  const files = {
    api: join(claudeDir("api"), `${CLAUDE_API_SESSION_ID}.jsonl`),
    docs: join(claudeDir("docs"), `${CLAUDE_DOCS_SESSION_ID}.jsonl`),
    web: join(
      env.hostHome,
      ".codex/sessions/2026/06/12",
      `rollout-2026-06-12T09-35-00-${CODEX_WEB_SESSION_ID}.jsonl`,
    ),
  };
  const jsonl = (records: unknown[]) =>
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  write(files.api, jsonl(claudeApiSession(cwd("api"))));
  write(files.docs, jsonl(claudeDocsSession(cwd("docs"))));
  write(files.web, jsonl(codexWebSession(cwd("web"))));
  const at = (minutesAgo: number) => new Date(DEMO_TIME - minutesAgo * 60_000);
  utimesSync(files.api, at(8), at(8));
  utimesSync(files.web, at(3), at(3));
  utimesSync(files.docs, at(40), at(40));
}

/** Pane shell, fake agents, fake ssh, Herdr config, and Thyra settings. */
function writeTools(env: Environment) {
  const bin = join(env.root, "bin");
  const screen = join(repositoryRoot, "scripts/demo/agent-screen.ts");
  const prompt = "❯";
  write(
    join(env.root, "bashrc"),
    [
      `export PATH=${bin}:$PATH`,
      "unset PROMPT_COMMAND",
      "export HISTFILE=/dev/null USER=demo LOGNAME=demo HOSTNAME=devbox",
      "export GIT_PAGER=cat",
      // Fixed prompt: window title, directory, Git branch, and a chevron.
      "__demo_branch() { git branch --show-current 2>/dev/null; }",
      `PS1='\\[\\e]0;\\w\\a\\]\\[\\e[38;5;75m\\]\\w\\[\\e[0m\\] \\[\\e[38;5;141m\\]$(__demo_branch)\\[\\e[0m\\]\\n\\[\\e[38;5;114m\\]${prompt}\\[\\e[0m\\] '`,
      "",
    ].join("\n"),
  );
  write(
    join(bin, "demo-shell"),
    `#!/bin/bash\nexec /bin/bash --noprofile --rcfile ${join(env.root, "bashrc")} -i\n`,
    0o755,
  );
  // Herdr recognizes an agent by its process name, so the stand-ins are
  // named after the real CLIs. Like the real agents' Herdr hooks, they
  // report their lifecycle and session from inside the pane. They redraw on
  // every resize and never exit.
  for (const agent of ["claude", "codex"]) {
    write(
      join(bin, agent),
      [
        "#!/bin/bash",
        `key="${agent}-$(basename "$PWD")"`,
        `. "${join(env.root, "agents")}/$key.env"`,
        `draw() { ${bun} ${screen} "$key" "$(tput cols)"; }`,
        "trap draw WINCH",
        "stty -echo -icanon 2>/dev/null",
        "draw",
        // Lifecycle first: once Herdr holds a session identity from its own
        // integration source, it keeps the screen-detected state instead.
        "sleep 1",
        "for state in $STATES; do",
        `  herdr pane report-agent "$HERDR_PANE_ID" --source demo --agent ${agent} --state "$state" >/dev/null`,
        "  sleep 1",
        "done",
        `[ -z "$SESSION" ] || herdr pane report-agent-session "$HERDR_PANE_ID" --source herdr:${agent} --agent ${agent} --agent-session-id "$SESSION" >/dev/null`,
        "while :; do sleep 60 & wait $!; done",
        "",
      ].join("\n"),
      0o755,
    );
  }
  // Finishing while unfocused leaves the docs agent "done" (unseen). A
  // session report would reset that to idle.
  const agents = {
    "claude-api": [CLAUDE_API_SESSION_ID, "working"],
    "codex-web": [CODEX_WEB_SESSION_ID, "blocked"],
    "claude-docs": ["", "working idle"],
  };
  for (const [key, [session, states]] of Object.entries(agents)) {
    write(
      join(env.root, "agents", `${key}.env`),
      `SESSION=${session}\nSTATES="${states}"\n`,
    );
  }
  write(
    join(env.root, "thyra-bin/ssh"),
    `#!/bin/sh\nexec ${bun} ${join(repositoryRoot, "scripts/demo/fake-ssh.ts")} "$@"\n`,
    0o755,
  );
  write(
    join(env.root, "xdg/herdr/config.toml"),
    `onboarding = false\n\n[terminal]\ndefault_shell = "${join(bin, "demo-shell")}"\n`,
  );
  const expand = (path: string) => path.replace(/^~/, env.home);
  const launcher = {
    pinned: DEMO_LAUNCHER.pinned.map(expand),
    commands: {},
    history: DEMO_LAUNCHER.history.map((entry) => ({
      path: expand(entry.path),
      count: entry.count,
      last_used_at: Date.now() - entry.minutesAgo * 60_000,
    })),
  };
  write(
    join(env.hostHome, ".config/thyra/settings.json"),
    JSON.stringify({
      version: 1,
      launcher: { local: launcher, workbox: launcher },
      custom: {},
    }),
  );
}

async function herdrCli(env: Environment, ...args: string[]) {
  const out = await run([...env.sandbox, "herdr", ...args], {
    env: env.herdrEnv,
  });
  return out.trim() ? JSON.parse(out) : null;
}

/** One request over Herdr's control socket (newline-delimited JSON). */
function herdrRpc(
  env: Environment,
  method: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection(env.controlSocket);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${method} timed out`));
    }, 5000);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      const reply = JSON.parse(buffer.slice(0, newline));
      if (reply.error) reject(new Error(`${method}: ${reply.error.message}`));
      else resolvePromise(reply.result);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(`${JSON.stringify({ id: "capture", method, params })}\n`);
  });
}

async function collaborators(env: Environment): Promise<string[]> {
  const list = await herdrRpc(env, "collaboration.list").catch(() => null);
  return (list?.snapshot?.participants ?? []).map(
    (participant: { participant_id: string }) => participant.participant_id,
  );
}

/**
 * Each page registers as a collaborator until its lease expires. Release the
 * leases of pages closed before this shot so it shows only its own session.
 * (Clients still attached register again at once.)
 */
async function releaseCollaborators(env: Environment, ids: string[]) {
  for (const id of ids) {
    await herdrRpc(env, "collaboration.leave", { participant_id: id }).catch(
      () => {},
    );
  }
}

/** Workspaces, tabs, and panes with agents in three different states. */
async function buildLayout(env: Environment) {
  const cwd = (name: string) => join(env.home, "code", name);
  const workspace = async (name: string, focus: boolean) => {
    const created = await herdrCli(
      env,
      "workspace",
      "create",
      "--cwd",
      cwd(name),
      "--label",
      name,
      focus ? "--focus" : "--no-focus",
    );
    return {
      id: created.result.workspace.workspace_id as string,
      pane: created.result.root_pane.pane_id as string,
      tab: created.result.root_pane.tab_id as string,
    };
  };
  const api = await workspace("api", true);
  const web = await workspace("web", false);
  const docs = await workspace("docs", false);
  const split = await herdrCli(
    env,
    "pane",
    "split",
    api.pane,
    "--direction",
    "down",
    "--ratio",
    "0.68",
    "--cwd",
    cwd("api"),
  );
  const apiShell = split.result.pane.pane_id as string;
  await herdrCli(env, "tab", "rename", api.tab, "rate limiter");
  await herdrCli(env, "tab", "rename", web.tab, "dates");
  await herdrCli(env, "tab", "rename", docs.tab, "translate");
  const server = await herdrCli(
    env,
    "tab",
    "create",
    "--workspace",
    api.id,
    "--cwd",
    cwd("api"),
    "--label",
    "dev server",
    "--no-focus",
  );
  const serverPane = server.result.root_pane.pane_id as string;
  const type = async (pane: string, text: string) => {
    await herdrCli(env, "pane", "send-text", pane, text);
    await herdrCli(env, "pane", "send-keys", pane, "enter");
  };
  await type(api.pane, "clear; claude");
  await type(web.pane, "clear; codex");
  await type(docs.pane, "clear; claude");
  await type(
    apiShell,
    "clear; git status -sb; git log --oneline --decorate -3",
  );
  await type(serverPane, "clear; ls src; git log --oneline --graph --all");
}

/** Wait until the fake agents have reported the demo's three states. */
async function waitForAgents(env: Environment) {
  const expected: Record<string, string> = {
    "code/api": "working",
    "code/web": "blocked",
    "code/docs": "done",
  };
  let agents: any[] = [];
  await waitFor("fake agent states", async () => {
    const list = await herdrCli(env, "agent", "list");
    agents = list?.result?.agents ?? [];
    return Object.entries(expected).every(([dir, status]) =>
      agents.some(
        (agent) =>
          agent.cwd === join(env.home, dir) &&
          agent.agent_status === status &&
          (status === "done" || agent.agent_session),
      ),
    );
  }).catch((error) => {
    const seen = agents.map((a) => `${a.cwd}: ${a.agent} ${a.agent_status}`);
    throw new Error(`${error.message} (${seen.join("; ") || "no agents"})`);
  });
}

async function portInUse(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => resolvePromise(false));
  });
}

async function startEnvironment(): Promise<Environment> {
  if (await portInUse()) {
    throw new Error(`Port ${port} is busy; pass --port <free port>`);
  }
  const root = mkdtempSync(join(tmpdir(), "thyra-shots-"));
  const hostHome = join(root, "home");
  const sandbox = sandboxPrefix(hostHome);
  const env: Environment = {
    root,
    hostHome,
    home: sandbox.length ? DEMO_HOME : hostHome,
    sandbox,
    controlSocket: join(root, "xdg/herdr/herdr.sock"),
    clientSocket: join(root, "xdg/herdr/herdr-client.sock"),
    herdrEnv: {},
  };
  if (!sandbox.length) {
    log("bubblewrap unavailable: shots will show the temporary home path");
  }
  env.herdrEnv = isolatedEnv(env);
  try {
    mkdirSync(hostHome, { recursive: true });
    await seedProjects(env);
    writeSessions(env);
    writeTools(env);
    env.herdr = spawn([...sandbox, "herdr", "server"], {
      cwd: hostHome,
      env: env.herdrEnv,
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor("isolated Herdr sockets", () =>
      existsSync(env.controlSocket) && existsSync(env.clientSocket)
        ? true
        : null,
    );
    await buildLayout(env);
    await waitForAgents(env);

    const registry = join(root, "connections.json");
    write(
      registry,
      JSON.stringify({
        version: 2,
        default_connection_id: "local",
        profiles: [
          {
            id: "local",
            label: "Local",
            type: "local",
            control_socket_path: env.controlSocket,
            client_socket_path: env.clientSocket,
            auto_connect: true,
          },
          {
            // Reached through scripts/demo/fake-ssh.ts, which forwards to
            // the same isolated Herdr.
            id: "workbox",
            label: "Workbox",
            type: "ssh",
            ssh_destination: "workbox",
            remote_control_socket_path: env.controlSocket,
            remote_client_socket_path: env.clientSocket,
            auto_connect: true,
          },
        ],
      }),
      // Thyra refuses a registry other users can read.
      0o600,
    );
    const bridgeEnv = isolatedEnv(env, {
      PATH: `${join(root, "thyra-bin")}:${process.env.PATH ?? ""}`,
      HOST: "127.0.0.1",
      PORT: String(port),
      // The registry is the only route to Herdr: an explicit HERDR_SOCKET_PATH
      // would add Thyra's synthetic "Default" profile. Default socket paths
      // resolve under the isolated XDG_CONFIG_HOME as well.
      THYRA_CONNECTIONS_PATH: registry,
      THYRA_DISABLE_UPDATE_CHECK: "1",
      THYRA_LOG_LEVEL: options.debug ? "info" : "warn",
    });
    env.bridge = spawn([...sandbox, bun, "server/src/index.ts"], {
      cwd: repositoryRoot,
      env: bridgeEnv,
      stdout: "ignore",
      stderr: options.debug ? "inherit" : "ignore",
    });
    await waitFor("Thyra health", async () => {
      try {
        return (await fetch(`${baseUrl}health`)).ok;
      } catch {
        return null;
      }
    });
    return env;
  } catch (error) {
    await stopEnvironment(env);
    throw error;
  }
}

/** Stop exactly the processes this run started, then delete its files. */
async function stopEnvironment(env: Environment) {
  if (env.bridge) {
    env.bridge.kill("SIGTERM");
    await Promise.race([env.bridge.exited, Bun.sleep(5000)]);
    if (env.bridge.exitCode === null) env.bridge.kill("SIGKILL");
  }
  if (env.herdr) {
    await run([...env.sandbox, "herdr", "server", "stop"], {
      env: env.herdrEnv,
    }).catch(() => {});
    await Promise.race([env.herdr.exited, Bun.sleep(5000)]);
    if (env.herdr.exitCode === null) env.herdr.kill("SIGKILL");
  }
  rmSync(env.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Browser

type Device = "desktop" | "phone";
type Locale = "en-US" | "zh-CN";

const DEVICES = {
  // A 14-inch laptop window.
  desktop: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
  },
  // iPhone 15-sized phone.
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
} as const;

/** Runs before any page script. */
const INIT_SCRIPT = (theme: string) => `(() => {
  // Playwright's Linux WebKit has no push service: getSubscription() never
  // settles. Report "not subscribed" as a browser would.
  if (window.PushManager) PushManager.prototype.getSubscription = async () => null;
  localStorage.setItem("thyra:theme", ${JSON.stringify(theme)});
  localStorage.setItem("thyra:collaborationProfile",
    JSON.stringify({ displayName: "Alex Chen", color: "#0969da" }));
})();`;

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

class Ui {
  constructor(
    readonly page: any,
    readonly locale: Locale,
  ) {}

  /** Interface text in the page's language (English is the catalog key). */
  t(text: string): string {
    return this.locale === "zh-CN"
      ? ((zhCN as Record<string, string>)[text] ?? text)
      : text;
  }

  button(label: string, { exact = true } = {}) {
    const name = this.t(label);
    return this.page
      .getByRole("button", {
        name: exact ? name : new RegExp(`^${escapeRegExp(name)}`),
        exact,
      })
      .first();
  }

  async click(label: string, options?: { exact?: boolean }) {
    await this.button(label, options).click();
    await this.settle(600);
  }

  async tab(label: string) {
    await this.page
      .getByRole("tab", { name: this.t(label), exact: true })
      .first()
      .click();
    await this.settle(800);
  }

  async text(text: string) {
    await this.page.getByText(text, { exact: true }).first().click();
    await this.settle(800);
  }

  async settle(ms = 400) {
    await this.page.waitForTimeout(ms);
  }

  /** Bounding box of the first match, grown by `pad` and kept on screen. */
  async box(target: string | any, pad = 0): Promise<Clip> {
    const locator =
      typeof target === "string" ? this.page.locator(target) : target;
    const box = await locator.first().boundingBox();
    if (!box) throw new Error(`No box for ${target}`);
    return grow(box, pad, this.page.viewportSize());
  }
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function grow(
  box: Clip,
  pad: number,
  viewport: { width: number; height: number },
): Clip {
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  return {
    x,
    y,
    width: Math.min(viewport.width, Math.ceil(box.x + box.width + pad)) - x,
    height: Math.min(viewport.height, Math.ceil(box.y + box.height + pad)) - y,
  };
}

/** Wait for the workspace list, terminal output, and web fonts. */
async function waitForApp(ui: Ui, device: Device) {
  const { page } = ui;
  await page.waitForSelector(".terminal-engine-screen", { timeout: 60_000 });
  // The GPU engine replaces the text preview once it draws.
  await page.waitForSelector(".terminal-engine-preview", {
    state: "detached",
    timeout: 60_000,
  });
  if (device === "desktop") {
    await page
      .getByText("translate", { exact: true })
      .first()
      .waitFor({ timeout: 60_000 });
  }
  await page.evaluate(() => document.fonts.ready);
  await ui.settle(2500);
}

/**
 * WebKit's GPU renderer paints a terminal that has not been focused only
 * after its next update; focusing each visible terminal once paints them all.
 * Focus returns to the first (agent) terminal.
 */
async function paintTerminals(ui: Ui) {
  const screens = ui.page.locator(".terminal-engine-screen");
  const count = await screens.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const screen = screens.nth(index);
    if (!(await screen.isVisible())) continue;
    await screen.click({ position: { x: 40, y: 20 } });
    await ui.settle(500);
  }
  await ui.settle(800);
}

interface Shot {
  /** Output path relative to the repository root. */
  out: string;
  device: Device;
  locale?: Locale;
  theme?: "dark" | "light";
  /** Prepare the page; return a clip to capture part of the viewport. */
  run(ui: Ui): Promise<Clip | undefined | void>;
  /** Extra AVIF renditions (width in pixels -> path). */
  avif?: Record<number, string>;
}

async function openInspector(ui: Ui, tab: "Files" | "Changes") {
  await ui.click("Inspector", { exact: false });
  await ui.tab(tab);
}

async function desktopChanges(ui: Ui) {
  await paintTerminals(ui);
  await openInspector(ui, "Changes");
  await ui.text("rate-limit.ts");
  await ui.settle(1500);
}

async function desktopFiles(ui: Ui) {
  await paintTerminals(ui);
  await openInspector(ui, "Files");
  await ui.click("Expand Inspector");
  await ui.text("src");
  await ui.text("README.md");
  await ui.settle(2500);
}

async function mobileTerminal(ui: Ui) {
  await ui.click("Show terminal shortcuts");
  // The Ctrl latch: the next key typed or tapped gets Ctrl.
  await ui.page
    .locator("button[aria-pressed]", { hasText: /^Ctrl$/ })
    .first()
    .click();
  await ui.settle(800);
}

async function mobileLauncher(ui: Ui) {
  await ui.click("Launch agent in a folder");
  await ui.page.getByRole("button", { name: /^api/ }).first().click();
  await ui.settle(1200);
}

async function mobileChanges(ui: Ui) {
  await ui.click("Show workspace changes");
  await ui.text("rate-limit.ts");
  await ui.click("Hide mobile controls");
  await ui.settle(1200);
}

const HERO_AVIF = {
  720: "site/assets/thyra-hero-720.avif",
  1200: "site/assets/thyra-hero-1200.avif",
  2400: "site/assets/thyra-hero-2400.avif",
};

const SHOTS: Record<string, Shot> = {
  "desktop-changes": {
    out: "docs/images/thyra-desktop-changes.png",
    device: "desktop",
    run: desktopChanges,
    avif: HERO_AVIF,
  },
  "desktop-changes-zh": {
    out: "docs/images/thyra-desktop-changes-zh.png",
    device: "desktop",
    locale: "zh-CN",
    run: desktopChanges,
  },
  "desktop-files": {
    out: "docs/images/thyra-desktop-files.png",
    device: "desktop",
    theme: "light",
    run: desktopFiles,
  },
  "desktop-files-zh": {
    out: "docs/images/thyra-desktop-files-zh.png",
    device: "desktop",
    locale: "zh-CN",
    theme: "light",
    run: desktopFiles,
  },
  "desktop-settings": {
    out: "docs/images/thyra-desktop-settings.png",
    device: "desktop",
    async run(ui) {
      await paintTerminals(ui);
      await ui.click("Menu");
      await ui.click("Configuration", { exact: false });
      await ui.settle(1200);
      return ui.box(
        ui.page.getByRole("dialog", { name: ui.t("Configuration") }),
      );
    },
  },
  "multi-connection-selector": {
    out: "docs/screenshots/multi-connection-selector.png",
    device: "desktop",
    async run(ui) {
      const trigger = ui.page
        .getByRole("button", { name: /^Local, Local/ })
        .first();
      await trigger.click();
      await ui.settle(1200);
      return ui.box(".dropdown__popover");
    },
  },
  "mobile-terminal": {
    out: "docs/images/thyra-mobile-terminal.png",
    device: "phone",
    run: mobileTerminal,
  },
  "mobile-launcher": {
    out: "docs/images/thyra-mobile-launcher.png",
    device: "phone",
    run: mobileLauncher,
  },
  "mobile-changes": {
    out: "docs/images/thyra-mobile-changes.png",
    device: "phone",
    run: mobileChanges,
  },
  "mobile-terminal-zh": {
    out: "docs/images/thyra-mobile-terminal-zh.png",
    device: "phone",
    locale: "zh-CN",
    run: mobileTerminal,
  },
  "mobile-launcher-zh": {
    out: "docs/images/thyra-mobile-launcher-zh.png",
    device: "phone",
    locale: "zh-CN",
    run: mobileLauncher,
  },
  "mobile-changes-zh": {
    out: "docs/images/thyra-mobile-changes-zh.png",
    device: "phone",
    locale: "zh-CN",
    run: mobileChanges,
  },
};

async function capture(env: Environment, rawDir: string) {
  const playwright = await loadPlaywrightCore();
  const browser = await playwright.webkit.launch({ headless: true });
  const selected = options.only
    ? options.only.split(",").map((name) => name.trim())
    : Object.keys(SHOTS);
  for (const name of selected) {
    if (!SHOTS[name]) throw new Error(`Unknown shot ${name}`);
  }
  try {
    for (const name of selected) {
      const shot = SHOTS[name]!;
      const locale = shot.locale ?? "en-US";
      log(`${name} (${shot.device}, ${locale}, ${shot.theme ?? "dark"})`);
      const stale = await collaborators(env);
      await releaseCollaborators(env, stale);
      const context = await browser.newContext({
        ...DEVICES[shot.device],
        locale,
        timezoneId: DEMO_TIME_ZONE,
        colorScheme: shot.theme ?? "dark",
        reducedMotion: "reduce",
        serviceWorkers: "block",
      });
      try {
        await context.addInitScript(INIT_SCRIPT(shot.theme ?? "dark"));
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error: Error) => errors.push(error.message));
        await page.goto(baseUrl);
        const ui = new Ui(page, locale);
        await waitForApp(ui, shot.device);
        // Closed pages' clients may have renewed their leases meanwhile.
        await releaseCollaborators(env, stale);
        const clip = (await shot.run(ui)) ?? undefined;
        await ui.settle(1000);
        const raw = join(rawDir, `${name}.png`);
        await page.screenshot({ path: raw, clip, animations: "disabled" });
        const text = await page.evaluate(() => document.body.innerText);
        const problems = [
          ...errors,
          ...["502", "Update check failed", "/tmp/", "thyra-shots"].filter(
            (needle) => text.includes(needle),
          ),
        ];
        if (problems.length) log(`  warning: ${problems.join("; ")}`);
        await optimize(raw, join(repositoryRoot, shot.out));
        for (const [width, path] of Object.entries(shot.avif ?? {})) {
          await avif(raw, join(repositoryRoot, path), Number(width));
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Images

async function vips(...args: string[]) {
  await run(["vips", ...args], { env: { ...process.env } as any });
}

/** Palette PNG (libimagequant): about a third of a lossless screenshot. */
async function optimize(raw: string, out: string) {
  mkdirSync(dirname(out), { recursive: true });
  await vips("copy", raw, `${out}[palette,Q=90,effort=10,strip]`);
  debug(`${out}: ${statSync(out).size} bytes`);
}

async function avif(raw: string, out: string, width: number) {
  await vips("thumbnail", raw, `${out}[Q=55,effort=6,strip]`, String(width));
}

// ---------------------------------------------------------------------------

async function main() {
  if (!which("vips") && !options.serve) {
    throw new Error("vips is required to optimize screenshots");
  }
  const env = await startEnvironment();
  let stopping: Promise<void> | null = null;
  const stop = () => (stopping ??= stopEnvironment(env));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stop().finally(() => process.exit(130));
    });
  }
  try {
    if (options.serve) {
      console.log(`Demo running at ${baseUrl} (Ctrl+C stops)`);
      console.log(`Root: ${env.root}`);
      await new Promise(() => {});
    }
    const rawDir = options["keep-raw"]
      ? resolve(options["keep-raw"])
      : join(env.root, "raw");
    mkdirSync(rawDir, { recursive: true });
    await capture(env, rawDir);
  } finally {
    await stop();
  }
}

if (import.meta.main) await main();
