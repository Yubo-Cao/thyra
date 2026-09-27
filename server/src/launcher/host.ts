import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sshCommandArgv } from "../bridge/ssh-command";
import type { RunProcessWithCodeTimeout } from "../workspace/file-types";
import { normalizeFolderPath, parseZoxideOutput } from "./folders";

export const MAX_BROWSE_ENTRIES = 500;
const PROBE_TIMEOUT_MS = 8000;
const ZOXIDE_TIMEOUT_MS = 2000;
const MAX_ZOXIDE_LINES = 200;

export type HostProbe = {
  home: string;
  /** The requested paths that are directories on the host. */
  directories: Set<string>;
  /** zoxide's list (existing directories only), or null when unavailable. */
  zoxide: Array<{ path: string; score: number }> | null;
};

export type HostDirectoryListing = {
  path: string;
  directories: string[];
  truncated: boolean;
};

/** Filesystem questions the launcher asks the connection's host. */
export type LauncherHost = {
  probe(paths: string[], options: { zoxide: boolean }): Promise<HostProbe>;
  listDirectories(
    path: string,
    showHidden: boolean,
  ): Promise<HostDirectoryListing>;
};

function sortNames(names: string[]) {
  return names.sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
  );
}

function visibleName(name: string, showHidden: boolean) {
  return showHidden || !name.startsWith(".");
}

export function createLocalLauncherHost(
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout,
): LauncherHost {
  const isDirectory = (path: string) =>
    stat(path).then(
      (info) => info.isDirectory(),
      () => false,
    );
  return {
    async probe(paths, options) {
      const checks = await Promise.all(
        paths.map(async (path) => [path, await isDirectory(path)] as const),
      );
      let zoxide: HostProbe["zoxide"] = null;
      if (options.zoxide && Bun.which("zoxide")) {
        const result = await runProcessWithCodeTimeout(
          ["zoxide", "query", "--list", "--score"],
          ZOXIDE_TIMEOUT_MS,
        ).catch(() => null);
        if (result?.code === 0)
          zoxide = parseZoxideOutput(
            result.stdout.split("\n").slice(0, MAX_ZOXIDE_LINES).join("\n"),
          );
      }
      return {
        home: homedir(),
        directories: new Set(
          checks.filter(([, exists]) => exists).map(([path]) => path),
        ),
        zoxide,
      };
    },
    async listDirectories(path, showHidden) {
      const entries = await readdir(path, { withFileTypes: true });
      const names: string[] = [];
      for (const entry of entries) {
        if (!visibleName(entry.name, showHidden)) continue;
        if (
          entry.isDirectory() ||
          (entry.isSymbolicLink() &&
            (await isDirectory(join(path, entry.name))))
        )
          names.push(entry.name);
      }
      sortNames(names);
      return {
        path,
        directories: names.slice(0, MAX_BROWSE_ENTRIES),
        truncated: names.length > MAX_BROWSE_ENTRIES,
      };
    },
  };
}

/** Parse NUL-separated `TAG\0value\0` records; ZOXIDE takes the rest verbatim. */
export function parseProbeOutput(stdout: string): HostProbe {
  const fields = stdout.split("\0");
  let home = "";
  const directories = new Set<string>();
  let zoxide: HostProbe["zoxide"] = null;
  for (let index = 0; index + 1 < fields.length; index += 2) {
    // A login-shell banner can precede the first tag on its own lines.
    const tag = fields[index].slice(fields[index].lastIndexOf("\n") + 1);
    const value = fields[index + 1];
    if (tag === "HOME") home = value;
    else if (tag === "DIR") directories.add(value);
    else if (tag === "ZOXIDE") {
      zoxide = parseZoxideOutput(
        value.split("\n").slice(0, MAX_ZOXIDE_LINES).join("\n"),
      );
      break;
    }
  }
  if (!normalizeFolderPath(home))
    throw new Error("unable to resolve the remote home directory");
  return { home, directories, zoxide };
}

export function parseListingOutput(stdout: string): HostDirectoryListing {
  const fields = stdout.split("\0");
  let path = "";
  const directories: string[] = [];
  let truncated = false;
  for (let index = 0; index < fields.length; index += 1) {
    const tag = fields[index].slice(fields[index].lastIndexOf("\n") + 1);
    if (tag === "TRUNCATED") truncated = true;
    else if (tag === "PWD") path = fields[++index] ?? "";
    else if (tag === "D") directories.push(fields[++index] ?? "");
  }
  if (!normalizeFolderPath(path)) throw new Error("unable to list the folder");
  return {
    path,
    directories: sortNames(directories.filter(Boolean)),
    truncated,
  };
}

const PROBE_SCRIPT = `
want_zoxide="$1"; shift
printf 'HOME\\0%s\\0' "$HOME"
for p in "$@"; do
  if [ -d "$p" ]; then printf 'DIR\\0%s\\0' "$p"; fi
done
if [ "$want_zoxide" = 1 ] && command -v zoxide >/dev/null 2>&1; then
  printf 'ZOXIDE\\0'
  zoxide query --list --score 2>/dev/null | head -n ${MAX_ZOXIDE_LINES}
  printf '\\0'
fi
`;

const LIST_SCRIPT = `
shopt -s nullglob dotglob
cd -- "$1" 2>/dev/null || { echo "not a directory: $1" >&2; exit 3; }
printf 'PWD\\0%s\\0' "$PWD"
n=0
for e in *; do
  [ -d "$e" ] || continue
  if [ "$2" != 1 ]; then case "$e" in .*) continue ;; esac; fi
  n=$((n + 1))
  if [ "$n" -gt ${MAX_BROWSE_ENTRIES} ]; then printf 'TRUNCATED\\0'; break; fi
  printf 'D\\0%s\\0' "$e"
done
`;

export function createSshLauncherHost(args: {
  host: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}): LauncherHost {
  const run = async (script: string, scriptArgs: string[]) => {
    const command = [
      "bash",
      "-lc",
      args.shQuote(script),
      "thyra-launcher",
      ...scriptArgs.map(args.shQuote),
    ].join(" ");
    const result = await args.runProcessWithCodeTimeout(
      sshCommandArgv(args.host, command),
      PROBE_TIMEOUT_MS,
    );
    if (result.code !== 0)
      throw new Error(
        (result.stderr || `remote command exited ${result.code}`)
          .trim()
          .slice(0, 500),
      );
    return result.stdout;
  };
  return {
    async probe(paths, options) {
      return parseProbeOutput(
        await run(PROBE_SCRIPT, [options.zoxide ? "1" : "0", ...paths]),
      );
    },
    async listDirectories(path, showHidden) {
      return parseListingOutput(
        await run(LIST_SCRIPT, [path, showHidden ? "1" : "0"]),
      );
    },
  };
}
