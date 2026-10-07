import { sshCommandArgv } from "../bridge/ssh-command";
import {
  GIT_DIFF_MAX_BYTES,
  GIT_DIFF_TIMEOUT_MS,
  GIT_PULL_TIMEOUT_MS,
  GIT_UNTRACKED_NUMSTAT_CONCURRENCY,
  PREVIEW_IMAGE_MAX_BYTES,
} from "./file-constants";
import { imageMimeForPath } from "../../../shared/filePreview";
import { sanitizeExplorerPath } from "./file-paths";
import type {
  GitDiffEntry,
  GitDiffKind,
  GitDiffMode,
  RunProcessWithCodeTimeout,
} from "./file-types";

// Read-only Git views behind the Changes inspector and the MCP Git tools.
// Every listing uses `-z`, so paths arrive unquoted and NUL-separated.

type GitContext = {
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
};

type Stats = Map<string, { additions: number; deletions: number }>;

function runShell(context: GitContext, command: string) {
  return context.runProcessWithCodeTimeout(
    context.host
      ? sshCommandArgv(context.host, command)
      : ["sh", "-lc", command],
    GIT_DIFF_TIMEOUT_MS,
  );
}

function runGit(context: GitContext, command: string) {
  return runShell(
    context,
    `git -C ${context.shQuote(context.root)} -c core.quotepath=false ${command}`,
  );
}

/**
 * One side of an image change as a data URL: a Git object (`rev:path`, `:path`
 * for the index) or, for `null`, the working-tree file. Missing or oversized
 * images are omitted.
 */
async function readImage(
  context: GitContext,
  path: string,
  object: string | null,
) {
  const mime = imageMimeForPath(path);
  const q = context.shQuote;
  const source =
    object === null
      ? `cat -- ${q(`${context.root}/${path}`)}`
      : `git -C ${q(context.root)} cat-file blob ${q(object)}`;
  const result = await runShell(
    context,
    `${source} 2>/dev/null | head -c ${PREVIEW_IMAGE_MAX_BYTES + 1} | base64 | tr -d '\\n'`,
  );
  const data = result.stdout.trim();
  if (!mime || !data || data.length > ((PREVIEW_IMAGE_MAX_BYTES + 2) / 3) * 4)
    return undefined;
  return `data:${mime};base64,${data}`;
}

function gitError(
  result: { code: number; stdout: string; stderr: string },
  fallback: string,
) {
  return new Error(
    (result.stderr || result.stdout || `${fallback} exited ${result.code}`)
      .trim()
      .slice(0, 1000),
  );
}

export function statusLabel(code: string, kind: GitDiffKind) {
  if (kind === "untracked" || kind === "conflicted") return kind;
  const labels: Record<string, string> = {
    A: "added",
    D: "deleted",
    R: "renamed",
    C: "copied",
    T: "type changed",
  };
  return labels[code] ?? "modified";
}

function isConflictedStatus(x: string, y: string) {
  return x === "U" || y === "U" || (x === y && (x === "A" || x === "D"));
}

const byPath = (a: GitDiffEntry, b: GitDiffEntry) =>
  a.path.localeCompare(b.path, undefined, { sensitivity: "base" }) ||
  a.kind.localeCompare(b.kind);

/** Parses `git status --porcelain=v1 -z`. */
export function parseStatusSummary(output: string): GitDiffEntry[] {
  const entries: GitDiffEntry[] = [];
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index] ?? "";
    if (record.length < 4) continue;
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    const path = record.slice(3);
    // A rename or copy is followed by its source path.
    const old_path =
      x === "R" || x === "C" || y === "R" || y === "C"
        ? fields[(index += 1)] || undefined
        : undefined;
    if (x === "?" && y === "?") {
      entries.push({ path, kind: "untracked", status: "untracked" });
    } else if (isConflictedStatus(x, y)) {
      entries.push({
        path,
        old_path,
        kind: "conflicted",
        status: "conflicted",
      });
    } else {
      if (x !== " ") {
        entries.push({
          path,
          old_path,
          kind: "staged",
          status: statusLabel(x, "staged"),
        });
      }
      if (y !== " ") {
        entries.push({
          path,
          old_path,
          kind: "unstaged",
          status: statusLabel(y, "unstaged"),
        });
      }
    }
  }
  return entries.sort(byPath);
}

/** Parses `git diff --name-status -z`. */
export function parseBranchSummary(output: string): GitDiffEntry[] {
  const entries: GitDiffEntry[] = [];
  const fields = output.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const code = fields[index]?.[0];
    if (!code) continue;
    const renamed = code === "R" || code === "C";
    const old_path = renamed ? fields[index + 1] : undefined;
    if (renamed) index += 1;
    const path = fields[index + 1] ?? "";
    if (path) {
      entries.push({
        path,
        old_path,
        kind: "branch",
        status: statusLabel(code, "branch"),
      });
    }
  }
  return entries.sort(byPath);
}

/** Parses `git diff --numstat -z`; binary files count as zero lines. */
export function parseNumstat(output: string): Stats {
  const stats: Stats = new Map();
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const [added = "", deleted = "", ...rest] = (fields[index] ?? "").split(
      "\t",
    );
    if (!rest.length) continue;
    // An empty path is a rename: the source and destination follow.
    let path = rest.join("\t");
    if (!path) {
      path = fields[index + 2] ?? "";
      index += 2;
    }
    if (path) {
      stats.set(path, {
        additions: Number.parseInt(added, 10) || 0,
        deletions: Number.parseInt(deleted, 10) || 0,
      });
    }
  }
  return stats;
}

async function numstat(context: GitContext, command: string) {
  const result = await runGit(context, `diff --numstat -z ${command}`);
  return result.code === 0 || result.code === 1
    ? parseNumstat(result.stdout)
    : (new Map() as Stats);
}

/** Line counts keyed by `kind:path`. */
async function collectStats(
  context: GitContext,
  entries: GitDiffEntry[],
  base: string | undefined,
) {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const add = (kinds: GitDiffKind[], values: Stats) => {
    for (const [path, value] of values) {
      for (const kind of kinds) stats.set(`${kind}:${path}`, value);
    }
  };
  if (base) {
    add(
      ["branch"],
      await numstat(context, `--find-renames ${context.shQuote(base)}...HEAD`),
    );
    return stats;
  }
  const [staged, unstaged] = await Promise.all([
    numstat(context, "--cached --find-renames"),
    numstat(context, "--find-renames"),
  ]);
  add(["staged"], staged);
  add(["unstaged", "conflicted"], unstaged);
  const untracked = entries.filter((entry) => entry.kind === "untracked");
  let cursor = 0;
  const worker = async () => {
    while (cursor < untracked.length) {
      const { path } = untracked[cursor++]!;
      add(
        ["untracked"],
        await numstat(
          context,
          `--no-ext-diff --no-index -- /dev/null ${context.shQuote(path)}`,
        ),
      );
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(GIT_UNTRACKED_NUMSTAT_CONCURRENCY, untracked.length),
      },
      worker,
    ),
  );
  return stats;
}

async function resolveMainBase(context: GitContext) {
  const command = `
set -eu
for ref in main refs/heads/main origin/main refs/remotes/origin/main; do
  if git -C ${context.shQuote(context.root)} rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    printf '%s' "$ref"
    exit 0
  fi
done
exit 1
`;
  const result = await context.runProcessWithCodeTimeout(
    context.host
      ? sshCommandArgv(context.host, command)
      : ["sh", "-lc", command],
    GIT_DIFF_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "main branch was not found")
        .trim()
        .slice(0, 1000),
    );
  }
  return result.stdout.trim();
}

function diffMode(params: Record<string, unknown>): GitDiffMode {
  return params.mode === "branch-main" ? "branch-main" : "working";
}

type DiffRequest = GitContext & {
  workspaceId: string;
  params: Record<string, unknown>;
};

export async function readDiffSummary({
  workspace,
  workspaceId,
  params,
  ...context
}: DiffRequest & { workspace: any }) {
  const mode = diffMode(params);
  const base =
    mode === "branch-main" ? await resolveMainBase(context) : undefined;
  const result = await runGit(
    context,
    base
      ? `diff --name-status -z --find-renames ${context.shQuote(base)}...HEAD`
      : "status --porcelain=v1 -z --untracked-files=all",
  );
  if (result.code !== 0)
    throw gitError(result, base ? "git diff" : "git status");
  const entries = base
    ? parseBranchSummary(result.stdout)
    : parseStatusSummary(result.stdout);
  const stats = await collectStats(context, entries, base);
  return {
    workspace_id: workspaceId,
    repo_name: workspace?.worktree?.repo_name ?? workspace?.label ?? "",
    root: context.root,
    mode,
    base,
    entries: entries.map((entry) => ({
      ...entry,
      ...stats.get(`${entry.kind}:${entry.path}`),
    })),
  };
}

export async function readDiffFile({
  workspaceId,
  params,
  ...context
}: DiffRequest) {
  const path = sanitizeExplorerPath(params.path);
  if (!path) throw new Error("git.diff_file requires path");
  const oldPath = sanitizeExplorerPath(params.old_path);
  const pathspec = (oldPath && oldPath !== path ? [oldPath, path] : [path])
    .map(context.shQuote)
    .join(" ");
  const mode = diffMode(params);
  const kind: GitDiffKind =
    mode === "branch-main"
      ? "branch"
      : params.kind === "staged" ||
          params.kind === "untracked" ||
          params.kind === "conflicted"
        ? params.kind
        : "unstaged";
  const base = kind === "branch" ? await resolveMainBase(context) : undefined;
  const commands: Record<GitDiffKind, string> = {
    branch: `diff --no-ext-diff --find-renames ${context.shQuote(base ?? "")}...HEAD -- ${pathspec}`,
    staged: `diff --cached --no-ext-diff -- ${pathspec}`,
    untracked: `diff --no-ext-diff --no-index -- /dev/null ${context.shQuote(path)}`,
    conflicted: `diff --cc --no-ext-diff -- ${pathspec}`,
    unstaged: `diff --no-ext-diff -- ${pathspec}`,
  };
  const result = await runGit(context, commands[kind]);
  // `--no-index` exits 1 when the files differ.
  if (result.code !== 0 && !(kind === "untracked" && result.code === 1)) {
    throw gitError(result, "git diff");
  }
  const truncated = Buffer.byteLength(result.stdout) > GIT_DIFF_MAX_BYTES;
  // `images` asks for both sides of a binary image change.
  let images: { old_image?: string; new_image?: string } = {};
  if (
    params.images === true &&
    imageMimeForPath(path) &&
    (!result.stdout || /^(Binary files|GIT binary patch)/m.test(result.stdout))
  ) {
    const before = oldPath || path;
    const mergeBase = base
      ? (
          await runGit(context, `merge-base ${context.shQuote(base)} HEAD`)
        ).stdout.trim()
      : "";
    const sides: Record<
      GitDiffKind,
      [string | null | undefined, string | null]
    > = {
      branch: [`${mergeBase}:${before}`, `HEAD:${path}`],
      staged: [`HEAD:${before}`, `:${path}`],
      untracked: [undefined, null],
      conflicted: [`HEAD:${before}`, null],
      unstaged: [`:${before}`, null],
    };
    const [oldSide, newSide] = sides[kind];
    const [old_image, new_image] = await Promise.all([
      oldSide === undefined ? undefined : readImage(context, before, oldSide),
      readImage(context, path, newSide),
    ]);
    images = { old_image, new_image };
  }
  return {
    ...images,
    workspace_id: workspaceId,
    root: context.root,
    path,
    kind,
    diff: truncated
      ? result.stdout.slice(0, GIT_DIFF_MAX_BYTES)
      : result.stdout,
    truncated,
  };
}

export async function pullGit({
  workspaceId,
  root,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: GitContext & { workspaceId: string }) {
  const command = `GIT_TERMINAL_PROMPT=0 git -C ${shQuote(root)} -c core.quotepath=false pull --ff-only`;
  const result = await runProcessWithCodeTimeout(
    host ? sshCommandArgv(host, command) : ["sh", "-lc", command],
    GIT_PULL_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `git pull exited ${result.code}`)
        .trim()
        .slice(0, 2000),
    );
  }
  return {
    workspace_id: workspaceId,
    root,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}
