import { sshCommandArgv } from "../bridge/ssh-command";
import { shQuote } from "../utils/process-utils";

/**
 * Bash scripts that run on the host owning the files: the bridge host for
 * local connections, the SSH destination otherwise. File-manager operations
 * that need host tools (archives, thumbnails) or must run remotely share this
 * runner, so local and SSH connections execute the same script.
 */
export function hostScriptArgv(host: string | undefined, script: string) {
  return host
    ? sshCommandArgv(host, `bash -lc ${shQuote(script)}`)
    : ["bash", "-c", script];
}

export type HostScriptResult = { code: number; stdout: string; stderr: string };

export type HostScriptOptions = {
  timeoutMs: number;
  /** Written to the script's stdin, then closed. */
  input?: string;
  /** Each complete stdout line as it arrives (progress protocols). */
  onLine?: (line: string) => void;
  /** Aborting kills the script (and, over SSH, the session running it). */
  signal?: AbortSignal;
};

export type RunHostScript = (
  host: string | undefined,
  script: string,
  options: HostScriptOptions,
) => Promise<HostScriptResult>;

/** Spawn a host script; stdout is collected and optionally streamed by line. */
export const runHostScript: RunHostScript = async (host, script, options) => {
  const proc = Bun.spawn(hostScriptArgv(host, script), {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.input !== undefined && proc.stdin) {
    const sink = proc.stdin;
    void Promise.resolve(sink.write(options.input)).catch(() => {});
    void Promise.resolve(sink.end()).catch(() => {});
  }
  let killedFor: string | null = null;
  const kill = (reason: string) => {
    killedFor ??= reason;
    try {
      proc.kill("SIGTERM");
    } catch {}
  };
  const timer = setTimeout(
    () => kill(`timed out after ${options.timeoutMs}ms`),
    options.timeoutMs,
  );
  const onAbort = () => kill("canceled");
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const readStdout = async () => {
    const decoder = new TextDecoder();
    let all = "";
    let pending = "";
    for await (const chunk of proc.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      all += text;
      if (!options.onLine) continue;
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        options.onLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    if (options.onLine && pending) options.onLine(pending);
    return all;
  };
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      readStdout(),
      new Response(proc.stderr).text(),
    ]);
    if (killedFor) throw new Error(`host operation ${killedFor}`);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
};

/** First line of a failed script's diagnostics, bounded for error replies. */
export function hostScriptError(result: HostScriptResult, fallback: string) {
  return (result.stderr || result.stdout || fallback).trim().slice(0, 1000);
}

/** Tools the file manager can use when the host has them on its PATH. */
export const HOST_TOOLS = [
  "tar",
  "bsdtar",
  "unzip",
  "zip",
  "7z",
  "7zz",
  "7za",
  "unrar",
  "gzip",
  "xz",
  "zstd",
  "bzip2",
  "vipsthumbnail",
  "magick",
  "convert",
  "ffmpegthumbnailer",
  "ffmpeg",
  "pdftoppm",
] as const;
export type HostTool = (typeof HOST_TOOLS)[number];

const TOOL_CACHE_MS = 5 * 60 * 1000;
const TOOL_PROBE_TIMEOUT_MS = 10000;

export function parseHostTools(stdout: string) {
  const known = new Set<string>(HOST_TOOLS);
  const tools = new Set<HostTool>();
  let os = "";
  for (const line of stdout.split(/\r?\n/)) {
    const [kind, value] = line.split("\t");
    if (kind === "OS" && value) os = value.trim();
    if (kind === "TOOL" && value && known.has(value)) {
      tools.add(value as HostTool);
    }
  }
  return { os, tools };
}

export type HostToolInfo = ReturnType<typeof parseHostTools>;

/**
 * Detect tools once per host and cache them for a few minutes, so installing
 * a tool is noticed without a bridge restart. Hosts without bash (a Windows
 * bridge) report no tools.
 */
export function createHostToolProbe(run: RunHostScript = runHostScript) {
  const cache = new Map<string, { at: number; info: Promise<HostToolInfo> }>();
  return (host: string | undefined): Promise<HostToolInfo> => {
    const key = host ?? "";
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < TOOL_CACHE_MS) return cached.info;
    const script = `printf 'OS\\t%s\\n' "$(uname -s 2>/dev/null)"
for tool in ${HOST_TOOLS.join(" ")}; do
  if command -v "$tool" >/dev/null 2>&1; then printf 'TOOL\\t%s\\n' "$tool"; fi
done`;
    const info =
      !host && process.platform === "win32"
        ? Promise.resolve({ os: "Windows", tools: new Set<HostTool>() })
        : run(host, script, { timeoutMs: TOOL_PROBE_TIMEOUT_MS }).then(
            (result) => {
              if (result.code !== 0) {
                throw new Error(hostScriptError(result, "tool probe failed"));
              }
              return parseHostTools(result.stdout);
            },
          );
    cache.set(key, { at: Date.now(), info });
    info.catch(() => {
      if (cache.get(key)?.info === info) cache.delete(key);
    });
    return info;
  };
}

export function b64(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

export function unb64(value: string | undefined) {
  return Buffer.from(value ?? "", "base64").toString("utf8");
}
