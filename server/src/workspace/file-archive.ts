import { randomBytes } from "node:crypto";
import { shQuote } from "../utils/process-utils";
import {
  type HostTool,
  type HostToolInfo,
  type RunHostScript,
  hostScriptError,
  runHostScript,
  unb64,
} from "./file-host";

/**
 * Archive extraction and compression on the host that owns the files, with
 * standard tools detected per host (tar, bsdtar, unzip, zip, 7z, unrar).
 *
 * Extraction is defensive: the entry list is read first and any absolute or
 * `..` path refuses the archive (zip-slip); the archive is unpacked into a
 * fresh hidden staging directory beside the destination; size and entry count
 * are watched while it runs and the job stops past the limits; symlinks that
 * would resolve outside the staging directory refuse the archive; device
 * files and sockets are dropped; only then is the staging directory renamed
 * into place. Jobs report progress and can be canceled, which kills the tool
 * and removes the staging directory.
 */

export const ARCHIVE_FORMATS = [
  "zip",
  "tar",
  "tar.gz",
  "tar.xz",
  "tar.zst",
  "tar.bz2",
  "7z",
  "rar",
] as const;
export type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number];
export type CompressFormat = "zip" | "tar.gz";

export const EXTRACT_MAX_ENTRIES = 100_000;
export const EXTRACT_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const JOB_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const FINISHED_JOB_TTL_MS = 10 * 60 * 1000;

const SUFFIXES: Array<[string, ArchiveFormat]> = [
  [".tar.gz", "tar.gz"],
  [".tgz", "tar.gz"],
  [".tar.xz", "tar.xz"],
  [".txz", "tar.xz"],
  [".tar.zst", "tar.zst"],
  [".tzst", "tar.zst"],
  [".tar.bz2", "tar.bz2"],
  [".tbz2", "tar.bz2"],
  [".tbz", "tar.bz2"],
  [".tar", "tar"],
  [".zip", "zip"],
  [".jar", "zip"],
  [".7z", "7z"],
  [".rar", "rar"],
];

export function archiveFormat(path: string): ArchiveFormat | null {
  const name = path.toLowerCase();
  return SUFFIXES.find(([suffix]) => name.endsWith(suffix))?.[1] ?? null;
}

/** `photos.tar.gz` -> `photos`, the default extraction folder name. */
export function archiveStem(name: string) {
  const lower = name.toLowerCase();
  const suffix = SUFFIXES.find(([candidate]) => lower.endsWith(candidate));
  const stem = suffix ? name.slice(0, -suffix[0].length) : name;
  return stem || "archive";
}

const DECOMPRESSOR: Partial<Record<ArchiveFormat, HostTool>> = {
  "tar.gz": "gzip",
  "tar.xz": "xz",
  "tar.zst": "zstd",
  "tar.bz2": "bzip2",
};

export type ToolChoice = { tool: HostTool } | { tool: null; missing: string };

/** The tool that extracts `format` on a host, or what to install. */
export function extractTool(
  format: ArchiveFormat,
  { os, tools }: HostToolInfo,
): ToolChoice {
  const has = (tool: HostTool) => tools.has(tool);
  const first = (...order: HostTool[]) => order.find(has) ?? null;
  let tool: HostTool | null;
  let missing: string;
  if (format === "zip") {
    tool = first("unzip", "bsdtar", "7zz", "7z", "7za");
    missing = "unzip, bsdtar or 7-Zip";
  } else if (format === "7z") {
    tool = first("7zz", "7z", "7za", "bsdtar");
    missing = "7-Zip (7z or 7zz) or bsdtar";
  } else if (format === "rar") {
    tool = first("unrar", "7zz", "7z", "bsdtar");
    missing = "unrar, 7-Zip or bsdtar";
  } else {
    // GNU tar (Linux) runs an external decompressor; BSD tar has them built in.
    const decompressor = DECOMPRESSOR[format];
    const gnu = os === "Linux";
    if (has("tar") && (!gnu || !decompressor || has(decompressor))) {
      tool = "tar";
    } else {
      tool = first("bsdtar");
    }
    missing =
      decompressor && gnu ? `tar with ${decompressor}, or bsdtar` : "tar";
  }
  return tool ? { tool } : { tool: null, missing };
}

export function compressTool(
  format: CompressFormat,
  { tools }: HostToolInfo,
): ToolChoice {
  const order: HostTool[] =
    format === "zip"
      ? ["zip", "7zz", "7z", "7za", "bsdtar"]
      : ["tar", "bsdtar"];
  const tool = order.find((candidate) => tools.has(candidate)) ?? null;
  return tool
    ? { tool }
    : {
        tool: null,
        missing: format === "zip" ? "zip, 7-Zip or bsdtar" : "tar",
      };
}

/** What the browser may offer on this host (`file.tools`). */
export function archiveCapabilities(info: HostToolInfo) {
  return {
    extract: Object.fromEntries(
      ARCHIVE_FORMATS.map((format) => {
        const choice = extractTool(format, info);
        return [format, choice.tool ? true : choice.missing];
      }),
    ) as Record<ArchiveFormat, true | string>,
    compress: Object.fromEntries(
      (["zip", "tar.gz"] as const).map((format) => {
        const choice = compressTool(format, info);
        return [format, choice.tool ? true : choice.missing];
      }),
    ) as Record<CompressFormat, true | string>,
  };
}

const COMMON = `
enc64() { printf '%s' "$1" | base64 | tr -d '\\n'; }
fail() { echo "$1" >&2; exit "\${2:-1}"; }
free_name() {
  candidate="$1/$2"; n=2
  while [ -e "$candidate" ] || [ -L "$candidate" ]; do
    candidate="$1/$2 ($n)"; n=$((n + 1))
    [ "$n" -lt 1000 ] || fail "could not find a free name"
  done
  printf '%s' "$candidate"
}
# Exit status of the background tool, polled so progress can stream.
pid=
watch_job() {
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.3
    progress
  done
  wait "$pid"; status=$?; pid=
  return "$status"
}
`;

/** Bash that lists, unpacks, checks and publishes one archive. */
export function extractScript({
  archive,
  parent,
  folder,
  tool,
  maxEntries = EXTRACT_MAX_ENTRIES,
  maxBytes = EXTRACT_MAX_BYTES,
}: {
  archive: string;
  parent: string;
  folder: string;
  tool: HostTool;
  maxEntries?: number;
  maxBytes?: number;
}) {
  const sevenZip = tool === "7z" || tool === "7zz" || tool === "7za";
  const list =
    tool === "unzip"
      ? `unzip -Z1 -- "$archive"`
      : sevenZip
        ? `${tool} l -ba -slt -- "$archive" | sed -n 's/^Path = //p'`
        : tool === "unrar"
          ? `unrar lb -- "$archive"`
          : `${tool} -tf "$archive"`;
  const extract =
    tool === "unzip"
      ? `unzip -qq -n -- "$archive" -d "$staging"`
      : sevenZip
        ? `${tool} x -y -bd -bso0 -bsp0 "-o$staging" -- "$archive"`
        : tool === "unrar"
          ? `unrar x -y -o- -idq -- "$archive" "$staging/"`
          : `${tool} -xf "$archive" -C "$staging"`;
  const total =
    tool === "unzip"
      ? `unzip -Zt -- "$archive" 2>/dev/null | sed -n 's/.*files, \\([0-9]*\\) bytes uncompressed.*/\\1/p'`
      : sevenZip
        ? `${tool} l -- "$archive" 2>/dev/null | awk '/ files/ { size = $3 } END { print size + 0 }'`
        : "echo 0";
  return `set -u
${COMMON}
archive=${shQuote(archive)}
parent=${shQuote(parent)}
folder=${shQuote(folder)}
max_entries=${maxEntries}
max_bytes=${maxBytes}
[ -f "$archive" ] || fail "archive does not exist" 14
[ -d "$parent" ] || fail "destination is not a directory" 14
listing=$(mktemp) || fail "cannot create a temporary file"
staging=
cleanup() {
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; pid=; fi
  rm -f -- "$listing"
  if [ -n "$staging" ]; then rm -rf -- "$staging"; fi
}
trap 'cleanup; exit 130' INT TERM HUP PIPE
${list} > "$listing" 2>/dev/null || { cleanup; fail "cannot read the archive (is it damaged or encrypted?)" 20; }
count=0
while IFS= read -r entry || [ -n "$entry" ]; do
  count=$((count + 1))
  if [ "$count" -gt "$max_entries" ]; then cleanup; fail "the archive has more than $max_entries entries" 21; fi
  case "$entry" in
    /*|[A-Za-z]:*|\\\\*|..|../*|*/..|*/../*|..\\\\*|*\\\\..|*\\\\..\\\\*)
      cleanup; fail "the archive has an entry outside its folder: $entry" 22 ;;
  esac
done < "$listing"
total=$(${total})
case "$total" in ''|*[!0-9]*) total=0 ;; esac
if [ "$total" -gt "$max_bytes" ]; then cleanup; fail "the archive expands to more than the extraction limit" 23; fi
staging=$(mktemp -d "$parent/.thyra-extract-XXXXXX") || { cleanup; fail "cannot write to the destination" 13; }
progress() {
  files=$(find "$staging" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')
  kb=$(du -sk "$staging" 2>/dev/null | cut -f1)
  bytes=$(( \${kb:-0} * 1024 ))
  printf 'PROGRESS\\t%s\\t%s\\t%s\\n' "$files" "$bytes" "$total"
  if [ "$bytes" -gt "$max_bytes" ] || [ "$files" -gt "$max_entries" ]; then
    cleanup; fail "the archive expands to more than the extraction limit" 23
  fi
}
( ${extract} ) </dev/null >/dev/null 2>"$listing.err" &
pid=$!
watch_job; status=$?
if [ "$status" -ne 0 ] && ! { [ ${shQuote(tool)} = unzip ] && [ "$status" -eq 1 ]; }; then
  message=$(head -c 400 "$listing.err" 2>/dev/null); rm -f -- "$listing.err"
  cleanup; fail "extraction failed: \${message:-${tool} exited $status}" 24
fi
rm -f -- "$listing.err"
progress
escapes() {
  case "$2" in /*) return 0 ;; esac
  depth=0
  path="$(dirname -- "$1")/$2"
  set -f; old_ifs=$IFS; IFS=/
  for part in $path; do
    case "$part" in
      ''|.) ;;
      ..) depth=$((depth - 1)); if [ "$depth" -lt 0 ]; then IFS=$old_ifs; set +f; return 0; fi ;;
      *) depth=$((depth + 1)) ;;
    esac
  done
  IFS=$old_ifs; set +f
  return 1
}
while IFS= read -r -d '' link; do
  relative=\${link#"$staging"/}
  if escapes "$relative" "$(readlink -- "$link")"; then
    cleanup; fail "the archive has a symlink that points outside its folder: $relative" 25
  fi
done < <(find "$staging" -type l -print0)
find "$staging" \\( -type p -o -type s -o -type b -o -type c \\) -exec rm -f -- {} + 2>/dev/null
final=$(free_name "$parent" "$folder")
chmod "$(printf '%o' "$((0777 & ~$(umask)))")" "$staging"
mv -- "$staging" "$final" || { cleanup; fail "cannot move the extracted folder into place" 13; }
staging=
rm -f -- "$listing"
printf 'DONE\\t%s\\n' "$(enc64 "$final")"
`;
}

/** Bash that writes `output` from `names` (relative to `base`). */
export function compressScript({
  base,
  names,
  output,
  format,
  tool,
}: {
  base: string;
  names: string[];
  output: string;
  format: CompressFormat;
  tool: HostTool;
}) {
  const quoted = names.map((name) => shQuote(name)).join(" ");
  const command =
    format === "tar.gz"
      ? `${tool} -czf "$temporary" -- ${quoted}`
      : tool === "zip"
        ? `zip -r -y -q - -- ${quoted} > "$temporary"`
        : tool === "bsdtar"
          ? `bsdtar --format zip -cf "$temporary" -- ${quoted}`
          : `${tool} a -tzip -y -bd -bso0 -bsp0 "$temporary.zip" -- ${quoted} && mv -- "$temporary.zip" "$temporary"`;
  return `set -u
${COMMON}
base=${shQuote(base)}
output=${shQuote(output)}
cd -- "$base" || fail "folder does not exist" 14
temporary=$(mktemp "$base/.thyra-compress-XXXXXX") || fail "cannot write to the folder" 13
rm -f -- "$temporary"
cleanup() {
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; pid=; fi
  rm -f -- "$temporary" "$temporary.zip"
}
trap 'cleanup; exit 130' INT TERM HUP PIPE
total=$(( $(du -sk -- ${quoted} 2>/dev/null | awk '{ sum += $1 } END { print sum + 0 }') * 1024 ))
progress() {
  bytes=$(wc -c 2>/dev/null < "$temporary" || wc -c 2>/dev/null < "$temporary.zip" || echo 0)
  printf 'PROGRESS\\t0\\t%s\\t%s\\n' "$(echo $bytes)" "$total"
}
( ${command} ) </dev/null >/dev/null 2>"$temporary.err" &
pid=$!
watch_job; status=$?
if [ "$status" -ne 0 ]; then
  message=$(head -c 400 "$temporary.err" 2>/dev/null); rm -f -- "$temporary.err"
  cleanup; fail "compression failed: \${message:-${tool} exited $status}" 24
fi
rm -f -- "$temporary.err"
final=$(free_name "\${output%/*}" "\${output##*/}")
chmod "$(printf '%o' "$((0666 & ~$(umask)))")" "$temporary"
mv -- "$temporary" "$final" || { cleanup; fail "cannot move the archive into place" 13; }
printf 'DONE\\t%s\\n' "$(enc64 "$final")"
`;
}

export type ArchiveJobState = "running" | "done" | "failed" | "canceled";

export type ArchiveJob = {
  id: string;
  kind: "extract" | "compress";
  state: ArchiveJobState;
  files: number;
  bytes: number;
  total_bytes: number;
  /** Host path of the new folder or archive once done. */
  result?: string;
  error?: string;
};

type JobRecord = ArchiveJob & {
  workspaceId: string;
  controller: AbortController;
  finishedAt?: number;
};

/** Running and recently finished archive jobs of one connection. */
export function createArchiveJobs(run: RunHostScript = runHostScript) {
  const jobs = new Map<string, JobRecord>();

  const sweep = () => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.finishedAt && now - job.finishedAt > FINISHED_JOB_TTL_MS) {
        jobs.delete(id);
      }
    }
  };

  function start(
    host: string | undefined,
    workspaceId: string,
    kind: ArchiveJob["kind"],
    script: string,
  ) {
    sweep();
    const job: JobRecord = {
      id: randomBytes(9).toString("base64url"),
      kind,
      state: "running",
      files: 0,
      bytes: 0,
      total_bytes: 0,
      workspaceId,
      controller: new AbortController(),
    };
    jobs.set(job.id, job);
    void run(host, script, {
      timeoutMs: JOB_TIMEOUT_MS,
      signal: job.controller.signal,
      onLine(line) {
        const [marker, a, b, c] = line.split("\t");
        if (marker === "PROGRESS") {
          job.files = Number(a) || job.files;
          job.bytes = Number(b) || job.bytes;
          job.total_bytes = Number(c) || job.total_bytes;
        } else if (marker === "DONE") {
          job.result = unb64(a);
        }
      },
    })
      .then((result) => {
        if (job.state !== "running") return;
        if (result.code === 0 && job.result) job.state = "done";
        else {
          job.state = "failed";
          job.error = hostScriptError(result, `${kind} failed`);
        }
      })
      .catch((error: Error) => {
        if (job.state !== "running") return;
        job.state = job.controller.signal.aborted ? "canceled" : "failed";
        job.error = error.message;
      })
      .finally(() => {
        job.finishedAt = Date.now();
      });
    return job.id;
  }

  function find(id: unknown, workspaceId: string) {
    const job = typeof id === "string" ? jobs.get(id) : undefined;
    if (!job || job.workspaceId !== workspaceId) {
      throw new Error("unknown archive job");
    }
    return job;
  }

  return {
    start,
    status(id: unknown, workspaceId: string): ArchiveJob {
      const job = find(id, workspaceId);
      return {
        id: job.id,
        kind: job.kind,
        state: job.state,
        files: job.files,
        bytes: job.bytes,
        total_bytes: job.total_bytes,
        ...(job.result ? { result: job.result } : {}),
        ...(job.error ? { error: job.error } : {}),
      };
    },
    cancel(id: unknown, workspaceId: string) {
      const job = find(id, workspaceId);
      if (job.state === "running") {
        job.state = "canceled";
        job.controller.abort();
      }
      return { id: job.id, state: job.state };
    },
  };
}
