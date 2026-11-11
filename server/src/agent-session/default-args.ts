import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionKind } from "../../../shared/agentSession";
import { dataRoot } from "../config/data-paths";
import { parseEnvironmentFile } from "../config/environment";
import { claudeConversationArgs } from "./claude";

type Env = Record<string, string | undefined>;

/**
 * `THYRA_AGENT_CLAUDE_ARGS` and `THYRA_AGENT_CODEX_ARGS`: the arguments a
 * deployment gives agent sessions that choose none, as shell text. A value
 * with control characters, or an overlong one, counts as unset.
 */
export function agentSessionDefaultArgs(
  agent: AgentSessionKind,
  env: Env = process.env,
): string {
  const value = env[`THYRA_AGENT_${agent.toUpperCase()}_ARGS`]?.trim() ?? "";
  return value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value)
    ? ""
    : value;
}

/**
 * The bridge's settings as a pane sees them: the service environment file
 * (`THYRA_CONFIG_PATH`, else `~/.config/thyra/thyra.env`) under the
 * process environment. A shell in a Herdr pane does not inherit the
 * service's environment, so `thyra agent` typed there reads the file.
 */
export function agentServiceEnvironment(env: Env = process.env): Env {
  const merged: Env = {};
  const path = env.THYRA_CONFIG_PATH || join(dataRoot(), "thyra.env");
  try {
    if (existsSync(path))
      Object.assign(merged, parseEnvironmentFile(readFileSync(path, "utf8")));
  } catch {
    // An unreadable file gives no defaults.
  }
  for (const [key, value] of Object.entries(env))
    if (value !== undefined) merged[key] = value;
  return merged;
}

/**
 * Shell text split into words as a POSIX shell would for plain arguments:
 * whitespace separates, quotes and backslashes group. Expansions are not
 * performed; an unterminated quote ends at the end of the text.
 */
export function splitShellWords(text: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && /["\\$`]/.test(text[index + 1] ?? ""))
        word += text[++index];
      else word += char;
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (char === "'" || char === '"') {
      word ??= "";
      quote = char;
    } else if (char === "\\" && index + 1 < text.length) {
      word = (word ?? "") + text[++index];
    } else word = (word ?? "") + char;
  }
  if (word !== null) words.push(word);
  return words;
}

/** Whether `args` only say which conversation to continue, if any. */
function choosesOnlyConversation(
  kind: AgentSessionKind,
  args: string[],
): boolean {
  if (kind === "claude")
    return claudeConversationArgs(args).others.length === 0;
  // `resume`, `resume <id>`, `resume --last`.
  if (args.length === 0) return true;
  return args[0] === "resume" && args.length <= 2;
}

/**
 * The arguments a session starts with: the given ones, after the
 * deployment's defaults when the given ones choose nothing but the
 * conversation. Every way of starting a session goes through this, so a
 * launcher launch, a resume and `thyra agent codex` typed into a pane all
 * start alike.
 */
export function agentSessionArgs(
  kind: AgentSessionKind,
  args: string[],
  env: Env = process.env,
): string[] {
  if (!choosesOnlyConversation(kind, args)) return args;
  return [...splitShellWords(agentSessionDefaultArgs(kind, env)), ...args];
}
