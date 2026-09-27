/**
 * Project launcher data model: agent commands, pinned folders, launch history,
 * and ranking of recent folders. Everything here is pure so the RPC service
 * and the settings normalizer share one definition.
 */

export const LAUNCHER_AGENTS = [
  { id: "claude", label: "Claude", defaultCommand: "claude" },
  { id: "codex", label: "Codex", defaultCommand: "codex" },
] as const;

export type LauncherAgentId = (typeof LAUNCHER_AGENTS)[number]["id"];

export type LauncherHistoryEntry = {
  path: string;
  count: number;
  last_used_at: number;
};

/** Stored per connection profile under `launcher.<connection id>` in settings.json. */
export type LauncherSettings = {
  pinned: string[];
  commands: Partial<Record<LauncherAgentId, string>>;
  history: LauncherHistoryEntry[];
};

export type LauncherFolderSource = "pinned" | "launched" | "open" | "zoxide";

export type LauncherFolder = {
  path: string;
  /** Host path with the home directory shortened to `~`. */
  display: string;
  sources: LauncherFolderSource[];
  /** Pinned folders stay listed when they disappear so they can be unpinned. */
  missing?: boolean;
};

export const MAX_PINNED_FOLDERS = 50;
export const MAX_HISTORY_ENTRIES = 60;
export const MAX_RECENT_FOLDERS = 12;
export const MAX_COMMAND_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;

export function isLauncherAgentId(value: unknown): value is LauncherAgentId {
  return LAUNCHER_AGENTS.some((agent) => agent.id === value);
}

/**
 * Normalize an absolute host path lexically: collapse repeated slashes and
 * drop trailing ones. Returns null for relative, empty, or control-character
 * paths. `~` must be expanded before calling this.
 */
export function normalizeFolderPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.length > MAX_PATH_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  )
    return null;
  const parts = trimmed.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) return null;
  return `/${parts.join("/")}`;
}

/** Show a host path compactly, `~/…` under the host user's home. */
export function compactFolderPath(path: string, home: string): string {
  const base = home.replace(/\/+$/, "");
  if (!base) return path;
  if (path === base) return "~";
  if (path.startsWith(`${base}/`)) return `~${path.slice(base.length)}`;
  return path;
}

/** A configured command is one line of shell text typed into the new pane. */
export function validateAgentCommand(value: unknown): string {
  if (typeof value !== "string") throw new Error("Command must be text");
  const command = value.trim();
  if (!command) throw new Error("Command must not be empty");
  if (command.length > MAX_COMMAND_LENGTH)
    throw new Error(`Command must be at most ${MAX_COMMAND_LENGTH} characters`);
  if (/[\u0000-\u001f\u007f]/.test(command))
    throw new Error("Command must be a single line without control characters");
  return command;
}

export function agentCommand(
  settings: LauncherSettings,
  agent: LauncherAgentId,
): string {
  return (
    settings.commands[agent] ??
    LAUNCHER_AGENTS.find((entry) => entry.id === agent)!.defaultCommand
  );
}

export function emptyLauncherSettings(): LauncherSettings {
  return { pinned: [], commands: {}, history: [] };
}

function uniquePaths(values: unknown[], limit: number): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const path = normalizeFolderPath(value);
    if (path && !seen.has(path)) seen.add(path);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

export function normalizeLauncherSettings(raw: unknown): LauncherSettings {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const commands: LauncherSettings["commands"] = {};
  const rawCommands =
    obj.commands && typeof obj.commands === "object" ? obj.commands : {};
  for (const agent of LAUNCHER_AGENTS) {
    const value = (rawCommands as Record<string, unknown>)[agent.id];
    try {
      if (value !== undefined) commands[agent.id] = validateAgentCommand(value);
    } catch {
      // Invalid stored commands fall back to the default.
    }
  }
  const history: LauncherHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(obj.history) ? obj.history : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const path = normalizeFolderPath(record.path);
    if (!path || seen.has(path)) continue;
    const count = Number(record.count);
    const lastUsedAt = Number(record.last_used_at);
    if (!Number.isFinite(count) || count < 1) continue;
    if (!Number.isFinite(lastUsedAt) || lastUsedAt < 0) continue;
    seen.add(path);
    history.push({
      path,
      count: Math.min(Math.round(count), 1_000_000),
      last_used_at: Math.round(lastUsedAt),
    });
    if (history.length >= MAX_HISTORY_ENTRIES) break;
  }
  return {
    pinned: uniquePaths(
      Array.isArray(obj.pinned) ? obj.pinned : [],
      MAX_PINNED_FOLDERS,
    ),
    commands,
    history,
  };
}

export function normalizeLauncherSettingsMap(
  raw: unknown,
): Record<string, LauncherSettings> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      normalizeLauncherSettings(value),
    ]),
  );
}

/** Record one launch; the oldest entries fall off beyond the cap. */
export function recordLaunch(
  history: LauncherHistoryEntry[],
  path: string,
  now: number,
): LauncherHistoryEntry[] {
  const existing = history.find((entry) => entry.path === path);
  const next = [
    { path, count: (existing?.count ?? 0) + 1, last_used_at: now },
    ...history.filter((entry) => entry.path !== path),
  ];
  return next
    .sort((a, b) => b.last_used_at - a.last_used_at)
    .slice(0, MAX_HISTORY_ENTRIES);
}

const HOUR = 60 * 60 * 1000;

/** zoxide-style frecency: recent use counts more than old use. */
export function launchFrecency(entry: LauncherHistoryEntry, now: number) {
  const age = Math.max(0, now - entry.last_used_at);
  const factor =
    age < HOUR ? 4 : age < 24 * HOUR ? 2 : age < 7 * 24 * HOUR ? 1 : 0.25;
  return entry.count * factor;
}

/** Parse `zoxide query --list --score` output: `<score> <path>` per line. */
export function parseZoxideOutput(
  stdout: string,
): Array<{ path: string; score: number }> {
  const entries: Array<{ path: string; score: number }> = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s+(\/.*)$/.exec(line);
    if (!match) continue;
    const path = normalizeFolderPath(match[2]);
    const score = Number(match[1]);
    if (path && Number.isFinite(score)) entries.push({ path, score });
  }
  return entries;
}

type HerdrPaneLike = {
  workspace_id?: unknown;
  cwd?: unknown;
  foreground_cwd?: unknown;
};

type HerdrWorkspaceLike = {
  workspace_id?: unknown;
  worktree?: { checkout_path?: unknown } | null;
};

/**
 * Working directories Herdr currently knows: checkout roots of open
 * workspaces weigh more than individual pane directories.
 */
export function liveFolderWeights(
  workspaces: HerdrWorkspaceLike[],
  panes: HerdrPaneLike[],
): Map<string, number> {
  const weights = new Map<string, number>();
  const add = (value: unknown, weight: number, cap: number) => {
    const path = normalizeFolderPath(value);
    if (!path) return;
    weights.set(path, Math.min(cap, (weights.get(path) ?? 0) + weight));
  };
  for (const workspace of workspaces)
    add(workspace?.worktree?.checkout_path, 6, 12);
  for (const pane of panes) {
    add(pane?.cwd, 2, 12);
    if (pane?.foreground_cwd !== pane?.cwd) add(pane?.foreground_cwd, 1, 12);
  }
  return weights;
}

/**
 * Pick the workspace a folder belongs to: a workspace whose checkout is the
 * folder, else one whose panes already work there. Null means the launch
 * opens a new workspace rooted at the folder.
 */
export function workspaceForFolder(
  path: string,
  workspaces: HerdrWorkspaceLike[],
  panes: HerdrPaneLike[],
): string | null {
  const ids = new Set(
    workspaces
      .map((workspace) => workspace?.workspace_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  for (const workspace of workspaces) {
    if (
      typeof workspace?.workspace_id === "string" &&
      normalizeFolderPath(workspace.worktree?.checkout_path) === path
    )
      return workspace.workspace_id;
  }
  const counts = new Map<string, number>();
  for (const pane of panes) {
    if (typeof pane?.workspace_id !== "string" || !ids.has(pane.workspace_id))
      continue;
    if (normalizeFolderPath(pane.cwd) !== path) continue;
    counts.set(pane.workspace_id, (counts.get(pane.workspace_id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Rank folder candidates for the Recent list. Launch history dominates,
 * then folders open in Herdr, then zoxide. The home directory and `/` are
 * left out: new shells start there, so they would always win without being
 * a project.
 */
export function rankRecentFolders(input: {
  history: LauncherHistoryEntry[];
  live: Map<string, number>;
  zoxide: Array<{ path: string; score: number }>;
  exclude: Iterable<string>;
  home: string;
  now: number;
}): Array<{ path: string; sources: LauncherFolderSource[]; score: number }> {
  const excluded = new Set(input.exclude);
  const home = normalizeFolderPath(input.home);
  if (home) excluded.add(home);
  excluded.add("/");
  const candidates = new Map<
    string,
    { path: string; sources: LauncherFolderSource[]; score: number }
  >();
  const add = (
    path: string,
    source: LauncherFolderSource,
    score: number,
  ): void => {
    if (excluded.has(path) || score <= 0) return;
    const entry = candidates.get(path) ?? { path, sources: [], score: 0 };
    if (!entry.sources.includes(source)) entry.sources.push(source);
    entry.score += score;
    candidates.set(path, entry);
  };
  for (const entry of input.history)
    add(entry.path, "launched", 10 * launchFrecency(entry, input.now));
  for (const [path, weight] of input.live) add(path, "open", weight);
  // zoxide scores are heavily skewed toward one or two directories; the
  // square root keeps the rest of its list competitive.
  const zoxideMax = Math.max(0, ...input.zoxide.map((entry) => entry.score));
  if (zoxideMax > 0)
    for (const entry of input.zoxide)
      add(entry.path, "zoxide", 6 * Math.sqrt(entry.score / zoxideMax));
  return [...candidates.values()].sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path),
  );
}
