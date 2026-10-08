import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, rm, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { type RunHostScript, b64, runHostScript } from "./file-host";
import {
  FileConflictError,
  TRANSFER_MAX_PATHS,
  assertTransferable,
  exists,
  freeName,
  moveLocal,
  runRemote,
} from "./file-manager";

/**
 * Delete to the trash, and Undo. Linux and the BSDs use the freedesktop.org
 * trash (the home trash, or `$topdir/.Trash-$uid` on another mount), macOS
 * `~/.Trash`, and other hosts a Thyra trash folder. SSH hosts run one bash
 * script per request with the same rules.
 */

export type TrashMethod = "freedesktop" | "macos" | "thyra";
export type TrashedEntry = {
  original: string;
  trashed: string;
  /** freedesktop `.trashinfo` file to remove on restore. */
  info?: string;
  method: TrashMethod;
};

/** Percent-encode a path for a freedesktop `.trashinfo` `Path=` line. */
export function trashInfoPath(path: string) {
  return Array.from(Buffer.from(path, "utf8"))
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /[A-Za-z0-9/._~-]/.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

function trashDate(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function mountTop(path: string) {
  let top = dirname(path);
  const device = (await stat(top)).dev;
  while (dirname(top) !== top) {
    const parent = await stat(dirname(top)).catch(() => null);
    if (!parent || parent.dev !== device) break;
    top = dirname(top);
  }
  return top;
}

/**
 * Freedesktop trash directory for a file: the home trash on its own device,
 * else `$topdir/.Trash-$uid` on the file's mount (spec section "Trash
 * directories"), else the home trash (a cross-device copy).
 */
async function freedesktopTrash(path: string, env = process.env) {
  const home = join(
    env.XDG_DATA_HOME || join(homedir(), ".local/share"),
    "Trash",
  );
  await mkdir(join(home, "files"), { recursive: true, mode: 0o700 });
  await mkdir(join(home, "info"), { recursive: true, mode: 0o700 });
  const [fileDevice, homeDevice] = await Promise.all([
    lstat(path).then((info) => info.dev),
    stat(home).then((info) => info.dev),
  ]);
  if (fileDevice === homeDevice) return { root: home, top: null };
  try {
    const top = await mountTop(path);
    const root = join(top, `.Trash-${userInfo().uid}`);
    await mkdir(join(root, "files"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "info"), { recursive: true, mode: 0o700 });
    return { root, top };
  } catch {
    return { root: home, top: null };
  }
}

function localTrashMethod(): TrashMethod {
  if (process.platform === "darwin") return "macos";
  return process.platform === "win32" ? "thyra" : "freedesktop";
}

export function thyraTrashDir(env = process.env) {
  return process.platform === "win32" && env.LOCALAPPDATA
    ? join(env.LOCALAPPDATA, "thyra", "trash")
    : join(env.XDG_DATA_HOME || join(homedir(), ".local/share"), "thyra/trash");
}

async function trashLocal(path: string): Promise<TrashedEntry> {
  const method = localTrashMethod();
  const name = basename(path);
  if (method !== "freedesktop") {
    const directory =
      method === "macos" ? join(homedir(), ".Trash") : thyraTrashDir();
    await mkdir(directory, { recursive: true });
    const isDirectory = (await lstat(path)).isDirectory();
    let target = join(directory, name);
    if (await exists(target)) {
      target = await freeName(directory, name, "number", isDirectory);
    }
    await moveLocal(path, target);
    return { original: path, trashed: target, method };
  }
  const { root, top } = await freedesktopTrash(path);
  const original = top ? path.slice(top.replace(/\/$/, "").length + 1) : path;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const entry = attempt ? `${name}.${attempt + 1}` : name;
    const info = join(root, "info", `${entry}.trashinfo`);
    let handle;
    try {
      handle = await open(info, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await handle.writeFile(
        `[Trash Info]\nPath=${trashInfoPath(original)}\nDeletionDate=${trashDate()}\n`,
      );
    } finally {
      await handle.close();
    }
    const trashed = join(root, "files", entry);
    try {
      if (await exists(trashed)) throw new Error("trash entry exists");
      await moveLocal(path, trashed);
    } catch (error) {
      await rm(info, { force: true });
      throw error;
    }
    return { original: path, trashed, info, method };
  }
  throw new Error("could not find a free trash name");
}

async function restoreLocal(entry: TrashedEntry) {
  if (await exists(entry.original)) throw new FileConflictError(entry.original);
  await mkdir(dirname(entry.original), { recursive: true });
  await moveLocal(entry.trashed, entry.original);
  if (entry.info) await rm(entry.info, { force: true });
}

const TRASH_SCRIPT = `
os=$(uname -s 2>/dev/null || echo unknown)
dev() { stat -c %d "$1" 2>/dev/null || stat -f %d "$1"; }
enc() {
  LC_ALL=C; s=$1; out=
  while [ -n "$s" ]; do
    c=\${s%"\${s#?}"}; s=\${s#?}
    case "$c" in [A-Za-z0-9/._~-]) out=$out$c ;; *) out=$out$(printf '%%%02X' "'$c") ;; esac
  done
  printf '%s' "$out"
}
data=\${XDG_DATA_HOME:-$HOME/.local/share}
while IFS= read -r src64; do
  [ -n "$src64" ] || continue
  src=$(dec "$src64")
  [ -e "$src" ] || [ -L "$src" ] || fail "file does not exist: $src" 14
  name=\${src##*/}
  case "$os" in
    Darwin|Linux|*BSD|DragonFly|SunOS)
      if [ "$os" = Darwin ]; then
        dir="$HOME/.Trash"; mkdir -p "$dir"
        target="$dir/$name"
        if [ -e "$target" ] || [ -L "$target" ]; then
          isdir=0; [ -d "$src" ] && [ ! -L "$src" ] && isdir=1
          target=$(uniq_name "$dir" "$name" number "$isdir")
        fi
        mv -- "$src" "$target"
        printf 'OK\\t%s\\t%s\\t\\tmacos\\n' "$src64" "$(enc64 "$target")"
        continue
      fi
      root="$data/Trash"; top=
      mkdir -p "$root/files" "$root/info"; chmod 700 "$root" 2>/dev/null || true
      parent=\${src%/*}; [ -n "$parent" ] || parent=/
      if [ "$(dev "$parent")" != "$(dev "$root")" ]; then
        top=$parent; d=$(dev "$top")
        while [ "$top" != / ] && [ "$(dev "\${top%/*}/" 2>/dev/null)" = "$d" ]; do
          top=\${top%/*}; [ -n "$top" ] || top=/
        done
        if mkdir -p "$top/.Trash-$(id -u)/files" "$top/.Trash-$(id -u)/info" 2>/dev/null; then
          root="$top/.Trash-$(id -u)"; chmod 700 "$root" 2>/dev/null || true
        else
          top=
        fi
      fi
      original=$src
      if [ -n "$top" ]; then original=\${src#"\${top%/}/"}; fi
      attempt=1; entry=$name
      while :; do
        info="$root/info/$entry.trashinfo"
        if (set -C; printf '[Trash Info]\\nPath=%s\\nDeletionDate=%s\\n' "$(enc "$original")" "$(date +%Y-%m-%dT%H:%M:%S)" > "$info") 2>/dev/null; then break; fi
        attempt=$((attempt + 1)); entry="$name.$attempt"
        [ "$attempt" -lt 1000 ] || fail "could not find a free trash name"
      done
      if ! mv -- "$src" "$root/files/$entry"; then rm -f -- "$info"; fail "could not move to the trash: $src"; fi
      printf 'OK\\t%s\\t%s\\t%s\\tfreedesktop\\n' "$src64" "$(enc64 "$root/files/$entry")" "$(enc64 "$info")"
      ;;
    *)
      dir="$data/thyra/trash"; mkdir -p "$dir"
      target=$(uniq_name "$dir" "$name" number 0)
      mv -- "$src" "$target"
      printf 'OK\\t%s\\t%s\\t\\tthyra\\n' "$src64" "$(enc64 "$target")"
      ;;
  esac
done
`;

const RESTORE_SCRIPT = `
tab=$(printf '\\t')
while IFS= read -r line; do
  [ -n "$line" ] || continue
  trashed=$(dec "\${line%%"$tab"*}"); rest=\${line#*"$tab"}
  original=$(dec "\${rest%%"$tab"*}"); info=$(dec "\${rest#*"$tab"}")
  if [ -e "$original" ] || [ -L "$original" ]; then
    printf 'CONFLICT\\t%s\\n' "$(enc64 "$original")" >&2; exit 17
  fi
  mkdir -p -- "\${original%/*}"
  mv -- "$trashed" "$original"
  if [ -n "$info" ]; then rm -f -- "$info"; fi
  printf 'OK\\t%s\\n' "$(enc64 "$original")"
done
`;

/** Trash and restore on the host that owns the files. */
export function createTrash(run: RunHostScript = runHostScript) {
  return {
    async trash(
      host: string | undefined,
      paths: string[],
      protectedPaths: Set<string>,
    ): Promise<TrashedEntry[]> {
      assertTransferable(paths, protectedPaths);
      if (!host) {
        const entries: TrashedEntry[] = [];
        for (const path of paths) entries.push(await trashLocal(path));
        return entries;
      }
      const rows = await runRemote(
        run,
        host,
        TRASH_SCRIPT,
        `${paths.map(b64).join("\n")}\n`,
      );
      return rows.map(([original = "", trashed = "", info = "", method]) => ({
        original,
        trashed,
        ...(info ? { info } : {}),
        method:
          method === "macos" || method === "thyra" ? method : "freedesktop",
      }));
    },

    async restore(host: string | undefined, entries: TrashedEntry[]) {
      if (!host) {
        for (const entry of entries) await restoreLocal(entry);
        return entries.map((entry) => entry.original);
      }
      const rows = await runRemote(
        run,
        host,
        RESTORE_SCRIPT,
        entries
          .map((entry) =>
            [entry.trashed, entry.original, entry.info ?? ""]
              .map(b64)
              .join("\t"),
          )
          .join("\n") + "\n",
      );
      return rows.map(([path = ""]) => path);
    },
  };
}

const TRASH_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const TRASH_TOKEN_LIMIT = 2000;

/**
 * Trashed entries the browser may restore (Undo), by opaque token. A token
 * restores only into the workspace and scope that trashed it.
 */
export function createTrashRegistry() {
  const entries = new Map<
    string,
    TrashedEntry & {
      host: string | undefined;
      workspaceId: string;
      filesystem: boolean;
      at: number;
    }
  >();
  return {
    add(
      entry: TrashedEntry,
      context: {
        host: string | undefined;
        workspaceId: string;
        filesystem: boolean;
      },
    ) {
      const now = Date.now();
      for (const [token, value] of entries) {
        if (
          entries.size < TRASH_TOKEN_LIMIT &&
          now - value.at < TRASH_TOKEN_TTL_MS
        )
          break;
        entries.delete(token);
      }
      const token = randomBytes(12).toString("base64url");
      entries.set(token, { ...entry, ...context, at: now });
      return token;
    },
    take(
      tokens: unknown,
      context: {
        host: string | undefined;
        workspaceId: string;
        filesystem: boolean;
      },
    ) {
      const list = Array.isArray(tokens)
        ? tokens.slice(0, TRANSFER_MAX_PATHS)
        : [];
      const found = list.map((token) => {
        const entry =
          typeof token === "string" ? entries.get(token) : undefined;
        if (
          !entry ||
          entry.host !== context.host ||
          entry.workspaceId !== context.workspaceId ||
          entry.filesystem !== context.filesystem
        ) {
          throw new Error("this deletion can no longer be undone");
        }
        return entry;
      });
      for (const token of list) entries.delete(token as string);
      return found;
    },
  };
}
