import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AgentSessionInfo, SessionFile } from "./session-types";
import type { AgentSessionFileAccess } from "./session-file-access";
import {
  describeGrokSessionPath,
  findGrokSessionById,
  findGrokSessionForCwd,
} from "./grok-session";
import {
  describeAntigravitySessionPath,
  findAntigravitySessionById,
  findAntigravitySessionForCwd,
} from "./antigravity-session";
import { findMuseSession, type MuseMetadataCache } from "./muse-session";
import { isRecord, normalizeAgentName, stringValue } from "./session-utils";

export type AgentSessionResolverContext = {
  pathCache: Map<string, string>;
  museMetadata: MuseMetadataCache;
};

export function createAgentSessionResolverContext(): AgentSessionResolverContext {
  return { pathCache: new Map(), museMetadata: new Map() };
}

function piAgentDirectory() {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) {
    return join(homedir(), configured.slice(2));
  }
  return resolve(configured);
}

async function walkFiles(root: string, match: (path: string) => boolean) {
  const results: string[] = [];
  async function visit(dir: string, depth: number) {
    if (depth > 8 || results.length > 200) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isFile() && match(path)) {
        results.push(path);
      }
    }
  }
  await visit(root, 0);
  return results;
}

async function resolveCachedSessionPath(
  context: AgentSessionResolverContext,
  cacheKey: string,
  resolvePath: () => Promise<string | null>,
) {
  const cached = context.pathCache.get(cacheKey);
  if (cached && existsSync(cached)) return cached;
  const path = await resolvePath();
  if (path) context.pathCache.set(cacheKey, path);
  return path;
}

async function findCodexSession(
  id: string,
  context: AgentSessionResolverContext,
) {
  return resolveCachedSessionPath(context, `codex:${id}`, async () => {
    const root = join(homedir(), ".codex", "sessions");
    const files = await walkFiles(
      root,
      (path) => path.endsWith(".jsonl") && basename(path).includes(id),
    );
    return newestFile(files);
  });
}

async function findClaudeSession(
  id: string,
  context: AgentSessionResolverContext,
) {
  return resolveCachedSessionPath(context, `claude:${id}`, async () => {
    const root = join(homedir(), ".claude", "projects");
    const files = await walkFiles(
      root,
      (path) => basename(path) === `${id}.jsonl`,
    );
    return newestFile(files);
  });
}

async function findKimiSession(
  id: string,
  context: AgentSessionResolverContext,
) {
  return resolveCachedSessionPath(context, `kimi:${id}`, async () => {
    const root = join(homedir(), ".kimi-code", "sessions");
    const suffix = join(id, "agents", "main", "wire.jsonl");
    const files = await walkFiles(
      root,
      (path) =>
        path.endsWith(suffix) || path.includes(`/${id}/agents/main/wire.jsonl`),
    );
    return newestFile(files);
  });
}

async function findPiSession(id: string, context: AgentSessionResolverContext) {
  return resolveCachedSessionPath(context, `pi:${id}`, async () => {
    const root = join(piAgentDirectory(), "sessions");
    const files = await walkFiles(root, (path) => {
      const name = basename(path);
      return name === `${id}.jsonl` || name.endsWith(`_${id}.jsonl`);
    });
    return newestFile(files);
  });
}

function newestFile(paths: string[]) {
  return (
    paths
      .map((path) => {
        try {
          return { path, mtimeMs: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((file): file is SessionFile => !!file)
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null
  );
}

async function sessionFileFor(
  agent: string,
  session: AgentSessionInfo,
  cwd: string,
  files: AgentSessionFileAccess,
  context: AgentSessionResolverContext,
) {
  if (agent === "grok") {
    const descriptor =
      session.kind === "path"
        ? await describeGrokSessionPath(resolve(session.value))
        : await findGrokSessionById(session.value, cwd);
    return descriptor?.file ?? null;
  }
  if (agent === "agy") {
    const descriptor =
      session.kind === "path"
        ? await describeAntigravitySessionPath(resolve(session.value))
        : await findAntigravitySessionById(session.value, cwd);
    return descriptor?.file ?? null;
  }
  if (session.kind === "path") {
    const path = resolve(session.value);
    return files.statFile(path);
  }
  if (agent === "muse") {
    // A remote ID must never resolve to this machine's unrelated transcript.
    return files.remote ? null : findMuseSession({ id: session.value });
  }
  if (agent === "pi" && files.remote) {
    return files.findPiSessionById(session.value);
  }
  let path: string | null = null;
  if (agent === "codex") path = await findCodexSession(session.value, context);
  if (agent === "claude")
    path = await findClaudeSession(session.value, context);
  if (agent === "kimi") path = await findKimiSession(session.value, context);
  if (agent === "pi") path = await findPiSession(session.value, context);
  if (path) return files.statFile(path);
  return null;
}

function parseAgentSession(agentInfo: Record<string, unknown>) {
  const raw = agentInfo.agent_session;
  if (!isRecord(raw)) return null;
  const kind = stringValue(raw.kind).toLowerCase();
  const value = stringValue(raw.value);
  if ((kind !== "id" && kind !== "path") || !value) return null;
  return {
    agent: stringValue(raw.agent),
    kind,
    value,
  } satisfies AgentSessionInfo;
}

const SUPPORTED_AGENTS = new Set([
  "codex",
  "claude",
  "kimi",
  "grok",
  "pi",
  "muse",
  "agy",
]);

/**
 * Locate the native session file of an agent snapshot from `agent.list`, for
 * its modification time. Returns null when the agent or file is unknown.
 */
export async function resolveAgentSessionFile(
  agentInfo: Record<string, unknown>,
  files: AgentSessionFileAccess,
  context: AgentSessionResolverContext,
): Promise<SessionFile | null> {
  const session = parseAgentSession(agentInfo);
  const agent = normalizeAgentName(
    stringValue(agentInfo.agent) || session?.agent || "",
  );
  if (!SUPPORTED_AGENTS.has(agent)) return null;
  // Native session files follow the agent process, which may have been
  // launched after `cd`. Herdr's `cwd` remains the pane's identity directory.
  const cwd =
    stringValue(agentInfo.foreground_cwd) || stringValue(agentInfo.cwd);
  if (session) return sessionFileFor(agent, session, cwd, files, context);
  if (agent === "grok") return (await findGrokSessionForCwd(cwd))?.file ?? null;
  if (agent === "agy")
    return (await findAntigravitySessionForCwd(cwd))?.file ?? null;
  if (agent === "muse" && !files.remote)
    return findMuseSession({ cwd, metadataCache: context.museMetadata });
  return null;
}
