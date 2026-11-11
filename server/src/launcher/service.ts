import { dirname } from "node:path";
import { CONNECTION_CHANGED_DURING_REQUEST } from "../connections/protocol";
import type { GuiSettings } from "../config/gui-settings";
import { expandHomePath, isHomeRelativePath } from "../workspace/file-paths";
import {
  agentCommand,
  compactFolderPath,
  emptyLauncherSettings,
  isLauncherAgentId,
  LAUNCHER_AGENTS,
  type LauncherAgentId,
  type LauncherFolder,
  type LauncherSettings,
  liveFolderWeights,
  MAX_PINNED_FOLDERS,
  MAX_RECENT_FOLDERS,
  normalizeFolderPath,
  rankRecentFolders,
  recordLaunch,
  validateAgentCommand,
  workspaceForFolder,
} from "./folders";
import type { LauncherHost } from "./host";

type HerdrCall = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<any>;

type LauncherWorkspaceRef = { workspace_id: string; label: string };

export type LauncherFolderView = LauncherFolder & {
  /** The open workspace a launch here adds a tab to; absent opens a new one. */
  workspace?: LauncherWorkspaceRef;
};

const PROMPT_WAIT_MS = 3000;

export type LauncherView = "gui" | "terminal";

/**
 * The shell text that starts an agent session: the host command, then the
 * arguments of the configured terminal command when that command is the
 * agent's own (`claude --model x` gives `thyra agent claude --model x`).
 * Any other configured command (a wrapper, an alias) contributes nothing;
 * a command that gives no arguments leaves the deployment's `defaultArgs`.
 */
export function agentSessionCommand(
  hostCommand: string,
  agent: LauncherAgentId,
  configured: string,
  defaultArgs = "",
): string {
  const own = new RegExp(`^${agent}(?:\\s+(.*))?$`, "s").exec(
    configured.trim(),
  );
  const extra = own?.[1]?.trim() || defaultArgs.trim();
  return `${hostCommand} agent ${agent}${extra ? ` ${extra}` : ""}`;
}

/**
 * `THYRA_AGENT_CLAUDE_ARGS` and `THYRA_AGENT_CODEX_ARGS`: the arguments a
 * deployment gives agent sessions started from the launcher, as shell text.
 * A value with control characters, or an overlong one, counts as unset.
 */
export function agentSessionDefaultArgs(
  agent: LauncherAgentId,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[`THYRA_AGENT_${agent.toUpperCase()}_ARGS`]?.trim() ?? "";
  return value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value)
    ? ""
    : value;
}
const MAX_PROBE_PATHS = 200;

/**
 * `launcher.*` RPCs for one connection runtime. The browser picks a folder
 * and an agent ID; the command text always comes from server settings.
 */
export function createLauncherService(args: {
  connectionId: string;
  host: LauncherHost;
  herdrCall: HerdrCall;
  readSettings: () => Promise<GuiSettings>;
  updateSettings: (
    update: (current: GuiSettings) => GuiSettings,
    shouldCommit?: () => boolean,
  ) => Promise<GuiSettings>;
  /**
   * Shell text that runs this Thyra executable, for the `gui` view; null
   * where panes cannot host agent sessions (see `agent_session.*`).
   */
  agentHostCommand?: () => string | null;
  /** Arguments for a `gui` launch whose configured command gives none. */
  agentSessionArgs?: (agent: LauncherAgentId) => string;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  let cachedHome: Promise<string> | null = null;

  const launcherSettings = (settings: GuiSettings): LauncherSettings =>
    settings.launcher?.[args.connectionId] ?? emptyLauncherSettings();

  const updateLauncherSettings = (
    update: (current: LauncherSettings) => LauncherSettings,
    shouldCommit?: () => boolean,
  ) =>
    args
      .updateSettings(
        (current) => ({
          ...current,
          launcher: {
            ...current.launcher,
            [args.connectionId]: update(launcherSettings(current)),
          },
        }),
        shouldCommit,
      )
      .then(launcherSettings);

  function home(): Promise<string> {
    if (!cachedHome) {
      const pending = args.host
        .probe([], { zoxide: false })
        .then((probe) => probe.home);
      pending.catch(() => {
        if (cachedHome === pending) cachedHome = null;
      });
      cachedHome = pending;
    }
    return cachedHome;
  }

  /** Accept an absolute path or `~`/`~/...` on the connection's host. */
  async function hostPath(value: unknown): Promise<string> {
    const raw = typeof value === "string" ? value.trim() : "";
    const expanded = isHomeRelativePath(raw)
      ? expandHomePath(raw, await home())
      : raw;
    const path = normalizeFolderPath(expanded);
    if (!path)
      throw new Error("Folder must be an absolute path or start with ~");
    return path;
  }

  async function requireDirectory(path: string) {
    const probe = await args.host.probe([path], { zoxide: false });
    if (!probe.directories.has(path))
      throw new Error(`Folder not found on this connection: ${path}`);
  }

  async function topology() {
    const [workspaces, panes] = await Promise.all([
      args
        .herdrCall("workspace.list", {}, 5000)
        .then((result) =>
          Array.isArray(result?.workspaces) ? result.workspaces : [],
        ),
      args
        .herdrCall("pane.list", {}, 5000)
        .then((result) => (Array.isArray(result?.panes) ? result.panes : [])),
    ]);
    return { workspaces, panes };
  }

  function agentsView(settings: LauncherSettings) {
    return LAUNCHER_AGENTS.map((agent) => ({
      id: agent.id,
      label: agent.label,
      command: agentCommand(settings, agent.id),
      default_command: agent.defaultCommand,
    }));
  }

  function folderView(
    path: string,
    homePath: string,
    extra: Omit<LauncherFolder, "path" | "display">,
    workspaces: any[],
    panes: any[],
  ): LauncherFolderView {
    const workspaceId = workspaceForFolder(path, workspaces, panes);
    const workspace = workspaceId
      ? workspaces.find((entry) => entry?.workspace_id === workspaceId)
      : undefined;
    return {
      path,
      display: compactFolderPath(path, homePath),
      ...extra,
      ...(workspaceId
        ? {
            workspace: {
              workspace_id: workspaceId,
              label: String(workspace?.label || workspaceId),
            },
          }
        : {}),
    };
  }

  async function getFolders() {
    const settings = launcherSettings(await args.readSettings());
    const { workspaces, panes } = await topology().catch(() => ({
      workspaces: [] as any[],
      panes: [] as any[],
    }));
    const live = liveFolderWeights(workspaces, panes);
    const candidates = [
      ...new Set([
        ...settings.pinned,
        ...settings.history.map((entry) => entry.path),
        ...live.keys(),
      ]),
    ].slice(0, MAX_PROBE_PATHS);
    const probed = new Set(candidates);
    const probe = await args.host.probe(candidates, { zoxide: true });
    cachedHome = Promise.resolve(probe.home);
    const recent = rankRecentFolders({
      history: settings.history,
      live,
      zoxide: probe.zoxide ?? [],
      exclude: settings.pinned,
      home: probe.home,
      now: now(),
    })
      // zoxide lists only existing directories; everything else was probed.
      .filter(
        (entry) => !probed.has(entry.path) || probe.directories.has(entry.path),
      )
      .slice(0, MAX_RECENT_FOLDERS);
    return {
      home: probe.home,
      zoxide: probe.zoxide !== null,
      agents: agentsView(settings),
      pinned: settings.pinned.map((path) =>
        folderView(
          path,
          probe.home,
          {
            sources: ["pinned"],
            ...(probe.directories.has(path) ? {} : { missing: true }),
          },
          workspaces,
          panes,
        ),
      ),
      recent: recent.map((entry) =>
        folderView(
          entry.path,
          probe.home,
          { sources: entry.sources },
          workspaces,
          panes,
        ),
      ),
    };
  }

  async function browse(params: Record<string, unknown>) {
    const requested =
      params.path === undefined || params.path === null || params.path === ""
        ? "~"
        : params.path;
    const path = await hostPath(requested);
    const listing = await args.host
      .listDirectories(path, params.show_hidden === true)
      .catch((error: Error) => {
        throw new Error(
          `Cannot open folder ${path}: ${error.message || "unavailable"}`,
        );
      });
    const directory = normalizeFolderPath(listing.path) ?? path;
    const [homePath, { workspaces, panes }] = await Promise.all([
      home(),
      topology().catch(() => ({ workspaces: [] as any[], panes: [] as any[] })),
    ]);
    const { workspace } = folderView(
      directory,
      homePath,
      { sources: [] },
      workspaces,
      panes,
    );
    return {
      path: directory,
      display: compactFolderPath(directory, homePath),
      parent: directory === "/" ? null : dirname(directory),
      truncated: listing.truncated,
      entries: listing.directories.map((name) => ({
        name,
        path: directory === "/" ? `/${name}` : `${directory}/${name}`,
      })),
      ...(workspace ? { workspace } : {}),
    };
  }

  async function setPins(
    params: Record<string, unknown>,
    isCurrent: () => boolean,
  ) {
    if (!Array.isArray(params.pinned))
      throw new Error("launcher.pins.set requires a pinned array");
    if (params.pinned.length > MAX_PINNED_FOLDERS)
      throw new Error(`At most ${MAX_PINNED_FOLDERS} folders can be pinned`);
    const requested: string[] = [];
    for (const value of params.pinned) {
      const path = await hostPath(value);
      if (!requested.includes(path)) requested.push(path);
    }
    const current = launcherSettings(await args.readSettings());
    const added = requested.filter((path) => !current.pinned.includes(path));
    if (added.length) {
      const probe = await args.host.probe(added, { zoxide: false });
      const missing = added.find((path) => !probe.directories.has(path));
      if (missing)
        throw new Error(`Folder not found on this connection: ${missing}`);
    }
    if (!isCurrent()) throw new Error(CONNECTION_CHANGED_DURING_REQUEST);
    const next = await updateLauncherSettings(
      (settings) => ({ ...settings, pinned: requested }),
      isCurrent,
    );
    return { pinned: next.pinned };
  }

  async function setCommands(
    params: Record<string, unknown>,
    isCurrent: () => boolean,
  ) {
    const commands = params.commands;
    if (!commands || typeof commands !== "object" || Array.isArray(commands))
      throw new Error("launcher.commands.set requires a commands object");
    const patch: Record<string, string | null> = {};
    for (const [agent, value] of Object.entries(commands)) {
      if (!isLauncherAgentId(agent))
        throw new Error(`Unknown launcher agent: ${agent}`);
      // Empty or null restores the default command.
      patch[agent] =
        value === null || (typeof value === "string" && !value.trim())
          ? null
          : validateAgentCommand(value);
    }
    const next = await updateLauncherSettings((settings) => {
      const nextCommands = { ...settings.commands };
      for (const agent of LAUNCHER_AGENTS) {
        if (!Object.hasOwn(patch, agent.id)) continue;
        const value = patch[agent.id];
        if (value === null || value === agent.defaultCommand)
          delete nextCommands[agent.id];
        else nextCommands[agent.id] = value;
      }
      return { ...settings, commands: nextCommands };
    }, isCurrent);
    return { agents: agentsView(next) };
  }

  async function launch(
    params: Record<string, unknown>,
    isCurrent: () => boolean,
  ) {
    const agent = params.agent;
    if (!isLauncherAgentId(agent))
      throw new Error("launcher.launch requires a known agent");
    const view = params.view ?? "terminal";
    if (view !== "gui" && view !== "terminal")
      throw new Error('launcher.launch view must be "gui" or "terminal"');
    const hostCommand = view === "gui" ? args.agentHostCommand?.() : null;
    if (view === "gui" && !hostCommand)
      throw new Error(
        "Agent sessions are only available on the default local connection",
      );
    const path = await hostPath(params.path);
    await requireDirectory(path);
    const configured = agentCommand(
      launcherSettings(await args.readSettings()),
      agent,
    );
    const command = hostCommand
      ? agentSessionCommand(
          hostCommand,
          agent,
          configured,
          args.agentSessionArgs?.(agent),
        )
      : configured;
    const { workspaces, panes } = await topology();
    const workspaceId = workspaceForFolder(path, workspaces, panes);
    // Browser-local navigation must not move other clients; the initiating
    // browser selects the result itself.
    if (!isCurrent()) throw new Error(CONNECTION_CHANGED_DURING_REQUEST);
    const created = workspaceId
      ? await args.herdrCall(
          "tab.create",
          { workspace_id: workspaceId, cwd: path, focus: false },
          20_000,
        )
      : await args.herdrCall(
          "workspace.create",
          { cwd: path, focus: false },
          20_000,
        );
    const paneId = created?.root_pane?.pane_id;
    if (typeof paneId !== "string" || !paneId)
      throw new Error("Herdr did not report the new pane");
    // Let the shell draw its prompt first so startup cannot swallow the
    // typed command; send anyway if it stays silent.
    await args
      .herdrCall(
        "pane.wait_for_output",
        {
          pane_id: paneId,
          source: "visible",
          match: { type: "regex", value: "\\S" },
          timeout_ms: PROMPT_WAIT_MS,
        },
        PROMPT_WAIT_MS + 2000,
      )
      .catch(() => undefined);
    let startError: string | undefined;
    try {
      await args.herdrCall(
        "pane.send_input",
        { pane_id: paneId, text: command, keys: ["enter"] },
        5000,
      );
    } catch (error) {
      startError = (error as Error).message || "unable to send the command";
    }
    await updateLauncherSettings((settings) => ({
      ...settings,
      history: recordLaunch(settings.history, path, now()),
    })).catch(() => undefined);
    return {
      ...created,
      path,
      agent,
      view,
      command,
      pane_id: paneId,
      reused_workspace: workspaceId !== null,
      ...(startError ? { start_error: startError } : {}),
    };
  }

  return {
    async call(
      method: string,
      params: Record<string, unknown>,
      isCurrent: () => boolean = () => true,
    ): Promise<unknown> {
      if (method === "launcher.get") return getFolders();
      if (method === "launcher.browse") return browse(params);
      if (method === "launcher.commands.get")
        return {
          agents: agentsView(launcherSettings(await args.readSettings())),
        };
      if (method === "launcher.pins.set") return setPins(params, isCurrent);
      if (method === "launcher.commands.set")
        return setCommands(params, isCurrent);
      if (method === "launcher.launch") return launch(params, isCurrent);
      throw new Error(`unknown launcher method: ${method}`);
    },
  };
}

export type LauncherService = ReturnType<typeof createLauncherService>;
