import { cp, lstat, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type RunHostScript,
  b64,
  hostScriptError,
  runHostScript,
  unb64,
} from "./file-host";
import { sanitizeUploadFilename } from "./file-paths";

/**
 * Rename, move and copy for the file manager. Callers pass
 * absolute host paths that the request scope already confined (see
 * `fileScope` in files.ts); local hosts use node:fs, SSH hosts run one bash
 * script per request.
 */

export const TRANSFER_MAX_PATHS = 1000;
const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;

export type TransferMode = "move" | "copy";
/** What to do when the destination already has an entry of that name. */
export type ConflictPolicy = "fail" | "rename" | "replace";
export type TransferResult = { from: string; path: string };
export class FileConflictError extends Error {
  constructor(readonly path: string) {
    super(`an entry named "${basename(path)}" already exists`);
  }
}

export function validateEntryName(value: unknown) {
  try {
    return sanitizeUploadFilename(value);
  } catch {
    throw new Error("invalid file name");
  }
}

/** `report.txt` -> `report copy.txt`, `report copy 2.txt` (or ` (2)`). */
export function variantName(
  name: string,
  attempt: number,
  style: "copy" | "number",
  directory = false,
) {
  const dot = directory ? -1 : name.lastIndexOf(".");
  const [stem, extension] =
    dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  if (style === "number") return `${stem} (${attempt + 1})${extension}`;
  return `${stem} copy${attempt > 1 ? ` ${attempt}` : ""}${extension}`;
}

export function assertTransferable(
  paths: string[],
  protectedPaths: Set<string>,
) {
  if (!paths.length) throw new Error("no files were named");
  if (paths.length > TRANSFER_MAX_PATHS) {
    throw new Error(`at most ${TRANSFER_MAX_PATHS} files per operation`);
  }
  for (const path of paths) {
    if (protectedPaths.has(path) || path === dirname(path)) {
      throw new Error("refusing to move or delete a root directory");
    }
  }
}

export const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

export async function moveLocal(from: string, to: string) {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyLocal(from, to);
    await rm(from, { recursive: true, force: true });
  }
}

async function copyLocal(from: string, to: string) {
  await cp(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
}

export async function freeName(
  directory: string,
  name: string,
  style: "copy" | "number",
  isDirectory: boolean,
) {
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = join(
      directory,
      variantName(name, attempt, style, isDirectory),
    );
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("could not find a free name");
}

async function renameLocal(path: string, name: string) {
  const target = join(dirname(path), name);
  if (target === path) return path;
  const [source, existing] = await Promise.all([
    lstat(path),
    lstat(target).catch(() => null),
  ]);
  // A case-only rename on a case-insensitive volume finds the source itself.
  if (existing && existing.ino !== source.ino) {
    throw new FileConflictError(target);
  }
  await rename(path, target);
  return target;
}

async function transferLocal(
  paths: string[],
  destination: string,
  mode: TransferMode,
  conflict: ConflictPolicy,
): Promise<TransferResult[]> {
  const destinationInfo = await stat(destination).catch(() => null);
  if (!destinationInfo?.isDirectory()) {
    throw new Error("destination is not a directory");
  }
  const destinationReal = await realpath(destination);
  const results: TransferResult[] = [];
  for (const from of paths) {
    const info = await lstat(from);
    if (info.isDirectory()) {
      const sourceReal = await realpath(from);
      if (
        destinationReal === sourceReal ||
        destinationReal.startsWith(`${sourceReal}/`)
      ) {
        throw new Error("cannot move or copy a folder into itself");
      }
    }
    if (mode === "move" && dirname(from) === destination) {
      results.push({ from, path: from });
      continue;
    }
    let target = join(destination, basename(from));
    if (await exists(target)) {
      if (conflict === "fail") throw new FileConflictError(target);
      if (conflict === "replace") {
        await rm(target, { recursive: true, force: true });
      } else {
        target = await freeName(
          destination,
          basename(from),
          mode === "copy" ? "copy" : "number",
          info.isDirectory(),
        );
      }
    }
    if (mode === "move") await moveLocal(from, target);
    else await copyLocal(from, target);
    results.push({ from, path: target });
  }
  return results;
}

// Shared shell helpers for the SSH scripts. `uniq_name dir name style isdir`
// prints a free sibling name.
const SHELL_HELPERS = `
dec() { printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D; }
enc64() { printf '%s' "$1" | base64 | tr -d '\\n'; }
variant() {
  name=$1; attempt=$2; style=$3; isdir=$4; stem=$name; ext=
  case "$name" in
    ?*.*) if [ "$isdir" != 1 ]; then stem=\${name%.*}; ext=.\${name##*.}; fi ;;
  esac
  if [ "$style" = number ]; then printf '%s (%s)%s' "$stem" "$((attempt + 1))" "$ext"
  elif [ "$attempt" -gt 1 ]; then printf '%s copy %s%s' "$stem" "$attempt" "$ext"
  else printf '%s copy%s' "$stem" "$ext"; fi
}
uniq_name() {
  attempt=1
  while [ "$attempt" -lt 1000 ]; do
    candidate="$1/$(variant "$2" "$attempt" "$3" "$4")"
    if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
    attempt=$((attempt + 1))
  done
  echo "could not find a free name" >&2; exit 17
}
fail() { echo "$1" >&2; exit "\${2:-1}"; }
`;

function remoteScript(body: string) {
  return `set -eu\n${SHELL_HELPERS}\n${body}`;
}

export async function runRemote(
  run: RunHostScript,
  host: string,
  body: string,
  input: string,
) {
  const result = await run(host, remoteScript(body), {
    timeoutMs: SCRIPT_TIMEOUT_MS,
    input,
  });
  if (result.code === 17) {
    const path = unb64(result.stderr.match(/CONFLICT\t(\S*)/)?.[1]);
    if (path) throw new FileConflictError(path);
  }
  if (result.code !== 0) {
    throw new Error(hostScriptError(result, `exited ${result.code}`));
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("OK\t"))
    .map((line) => line.split("\t").slice(1).map(unb64));
}

const RENAME_SCRIPT = `
IFS= read -r src64; IFS= read -r name64
src=$(dec "$src64"); name=$(dec "$name64")
[ -e "$src" ] || [ -L "$src" ] || fail "file does not exist" 14
target="\${src%/*}/$name"
if [ "$target" != "$src" ]; then
  if { [ -e "$target" ] || [ -L "$target" ]; } && ! [ "$target" -ef "$src" ]; then
    printf 'CONFLICT\\t%s\\n' "$(enc64 "$target")" >&2; exit 17
  fi
  mv -- "$src" "$target"
fi
printf 'OK\\t%s\\n' "$(enc64 "$target")"
`;

const TRANSFER_SCRIPT = `
IFS= read -r mode; IFS= read -r conflict; IFS= read -r dest64
dest=$(dec "$dest64")
[ -d "$dest" ] || fail "destination is not a directory" 14
dest_real=$(cd "$dest" && pwd -P)
while IFS= read -r src64; do
  [ -n "$src64" ] || continue
  src=$(dec "$src64")
  [ -e "$src" ] || [ -L "$src" ] || fail "file does not exist: $src" 14
  isdir=0
  if [ -d "$src" ] && [ ! -L "$src" ]; then
    isdir=1
    src_real=$(cd "$src" && pwd -P)
    case "$dest_real/" in "$src_real"/*) fail "cannot move or copy a folder into itself" 13 ;; esac
  fi
  if [ "$mode" = move ] && [ "\${src%/*}" = "$dest" ]; then
    printf 'OK\\t%s\\t%s\\n' "$src64" "$src64"; continue
  fi
  name=\${src##*/}
  target="$dest/$name"
  if [ -e "$target" ] || [ -L "$target" ]; then
    case "$conflict" in
      fail) printf 'CONFLICT\\t%s\\n' "$(enc64 "$target")" >&2; exit 17 ;;
      replace) rm -rf -- "$target" ;;
      *) if [ "$mode" = copy ]; then style=copy; else style=number; fi
         target=$(uniq_name "$dest" "$name" "$style" "$isdir") ;;
    esac
  fi
  if [ "$mode" = move ]; then mv -- "$src" "$target"; else cp -RPp -- "$src" "$target"; fi
  printf 'OK\\t%s\\t%s\\n' "$src64" "$(enc64 "$target")"
done
`;

/** File-manager operations on the host that owns the files. */
export function createFileOperations(run: RunHostScript = runHostScript) {
  return {
    async rename(host: string | undefined, path: string, rawName: unknown) {
      const name = validateEntryName(rawName);
      if (!host) return renameLocal(path, name);
      const [row] = await runRemote(
        run,
        host,
        RENAME_SCRIPT,
        `${b64(path)}\n${b64(name)}\n`,
      );
      return row?.[0] ?? join(dirname(path), name);
    },

    async transfer(
      host: string | undefined,
      {
        paths,
        destination,
        mode,
        conflict,
        protectedPaths,
      }: {
        paths: string[];
        destination: string;
        mode: TransferMode;
        conflict: ConflictPolicy;
        protectedPaths: Set<string>;
      },
    ): Promise<TransferResult[]> {
      if (mode === "move") assertTransferable(paths, protectedPaths);
      else if (!paths.length) throw new Error("no files were named");
      if (!host) return transferLocal(paths, destination, mode, conflict);
      const rows = await runRemote(
        run,
        host,
        TRANSFER_SCRIPT,
        [mode, conflict, b64(destination), ...paths.map(b64)].join("\n") + "\n",
      );
      return rows.map(([from = "", path = ""]) => ({ from, path }));
    },
  };
}

export type FileOperations = ReturnType<typeof createFileOperations>;
