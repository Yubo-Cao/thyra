import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ShellCompletion } from "../../../shared/shell";
import type { ShellRecord } from "./state";

/** A lexical tokenizer only: never evaluates expansions, substitutions or code. */
export function completionToken(line: string, cursor: number) {
  const tokens: { start: number; end: number; text: string }[] = [];
  let start = -1,
    text = "",
    quote = "",
    escaped = false;
  let prefix = "";
  for (let i = 0; i <= line.length; i++) {
    if (i === cursor) prefix = text;
    const c = line[i];
    if (c === undefined || (!quote && !escaped && /[\s;|&]/.test(c))) {
      if (start >= 0) {
        tokens.push({ start, end: i, text });
        start = -1;
        text = "";
      }
      continue;
    }
    if (start < 0) start = i;
    if (escaped) {
      text += c;
      escaped = false;
    } else if (c === "\\" && quote !== "'") escaped = true;
    else if (c === quote) quote = "";
    else if (!quote && (c === "'" || c === '"')) quote = c;
    else text += c;
  }
  const token = tokens.find((t) => t.start <= cursor && cursor <= t.end) ?? {
    start: cursor,
    end: cursor,
    text: "",
  };
  if (token.start === cursor) prefix = "";
  return {
    start: token.start,
    end: token.end,
    prefix,
    before: tokens.filter((t) => t.end < token.start).map((t) => t.text),
  };
}
function escapeWord(text: string) {
  return text.replace(/([^a-zA-Z0-9_./~:@%+=,-])/gu, "\\$1");
}
const common =
  "cd echo printf pwd exit return set read test true false eval exec source type command builtin alias unalias history jobs fg bg wait kill break continue";
const posix =
  "export unset if then else elif fi for while until do done case esac in function time . : [ { } ! [[ ]]";
const builtins = {
  bash: `${common} ${posix} shopt bind compgen complete compopt declare local let mapfile readarray readonly select coproc caller dirs disown enable fc getopts hash help logout popd pushd shift suspend times trap typeset ulimit umask`,
  zsh: `${common} ${posix} autoload typeset zmodload zstyle whence rehash repeat foreach end bindkey chdir declare dirs disable disown echotc echoti emulate enable fc float functions getln getopts hash integer let limit local log logout noglob popd print pushd pushln r readonly sched select setopt shift suspend times trap ttyctl ulimit umask unfunction unhash unlimit unsetopt vared where which zcompile zle`,
  fish: `${common} abbr begin end and or not status string math functions contains count emit argparse block commandline complete for function if isatty path random realpath set_color switch time ulimit umask while`,
};
async function budget<T>(source: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      source.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), 150);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export class ShellCompleter {
  private commands = new Map<string, { at: number; words: string[] }>();
  private async executableNames(path: string, cwd: string) {
    const key = Bun.hash(path + "\0" + cwd).toString();
    const cached = this.commands.get(key);
    if (cached && Date.now() - cached.at < 30_000) return cached.words;
    const deadline = performance.now() + 145;
    const words = new Set<string>();
    for (const directory of path.split(":")) {
      if (performance.now() > deadline) break;
      const dir = resolve(cwd, directory || ".");
      const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (performance.now() > deadline) break;
        if (file.isDirectory()) continue;
        if (
          await access(resolve(dir, file.name), constants.X_OK).then(
            () => true,
            () => false,
          )
        )
          words.add(file.name);
      }
    }
    if (this.commands.size >= 32)
      this.commands.delete(this.commands.keys().next().value!);
    const result = [...words].sort();
    this.commands.set(key, { at: Date.now(), words: result });
    return result;
  }
  private async files(
    prefix: string,
    cwd: string,
  ): Promise<ShellCompletion["items"]> {
    if (prefix === "~") return [{ text: "~/", kind: "dir" }];
    const slash = prefix.lastIndexOf("/");
    const base = slash < 0 ? "" : prefix.slice(0, slash + 1);
    const name = prefix.slice(slash + 1);
    const expanded = base.startsWith("~/") ? homedir() + base.slice(1) : base;
    const directory = resolve(cwd, expanded || ".");
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.name.startsWith(name) &&
          (!entry.name.startsWith(".") || name.startsWith(".")),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200)
      .map((entry) => ({
        text: escapeWord(base + entry.name + (entry.isDirectory() ? "/" : "")),
        kind: entry.isDirectory() ? "dir" : "file",
      }));
  }
  private async branches(
    cwd: string,
    prefix: string,
  ): Promise<ShellCompletion["items"]> {
    const proc = Bun.spawn(
      [
        "git",
        "for-each-ref",
        "--format=%(refname:short)",
        "--count=200",
        "refs/heads",
        "refs/remotes",
      ],
      {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    const timer = setTimeout(() => proc.kill(), 145);
    try {
      const output = await new Response(proc.stdout).text();
      if ((await proc.exited) !== 0) return [];
      return output
        .trim()
        .split("\n")
        .filter((name) => name && name.startsWith(prefix))
        .map((name) => ({ text: escapeWord(name), kind: "branch" }));
    } finally {
      clearTimeout(timer);
    }
  }
  async complete(
    record: ShellRecord,
    line: string,
    cursor: number,
  ): Promise<ShellCompletion> {
    const token = completionToken(line, cursor);
    let path = record.path;
    if (path === undefined)
      path = await budget(
        readFile(`/proc/${record.pid}/environ`, "utf8").then(
          (env) =>
            env
              .split("\0")
              .find((entry) => entry.startsWith("PATH="))
              ?.slice(5) ?? "",
        ),
        "",
      );
    const sources: Promise<ShellCompletion["items"]>[] = [];
    const shellWords = new Set(builtins[record.shell].split(" "));
    if (!token.before.length && !token.prefix.includes("/"))
      sources.push(
        budget(
          this.executableNames(path ?? "", record.cwd).then((names) =>
            [...new Set([...shellWords, ...names])]
              .filter((name) => name.startsWith(token.prefix))
              .slice(0, 200)
              .map((text) => ({
                text: shellWords.has(text) ? text : escapeWord(text),
                kind: "command" as const,
              })),
          ),
          [],
        ),
      );
    sources.push(budget(this.files(token.prefix, record.cwd), []));
    const [command, subcommand, option] = token.before;
    if (
      command === "git" &&
      (["checkout", "switch", "merge", "rebase", "push", "pull"].includes(
        subcommand ?? "",
      ) ||
        (subcommand === "branch" && option === "-d"))
    )
      sources.unshift(budget(this.branches(record.cwd, token.prefix), []));
    const items = (await Promise.all(sources)).flat();
    const seen = new Set<string>();
    return {
      replace_start: token.start,
      replace_end: token.end,
      items: items
        .filter((item) => {
          if (seen.has(item.text)) return false;
          seen.add(item.text);
          return true;
        })
        .slice(0, 200),
    };
  }
}
