import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AgentSessionFileAccess,
  localAgentSessionFiles,
} from "./session-file-access";
import { findMuseSession, museMetadataReader } from "./muse-session";
import {
  type AgentSessionResolverContext,
  createAgentSessionResolverContext,
  resolveAgentSessionFile,
} from "./session-resolver";
import { normalizeAgentName } from "./session-utils";

const resolveFile = (
  agent: Record<string, unknown>,
  files: AgentSessionFileAccess = localAgentSessionFiles,
  context: AgentSessionResolverContext = createAgentSessionResolverContext(),
) => resolveAgentSessionFile(agent, files, context);

const roots: string[] = [];
const originalDataHome = process.env.XDG_DATA_HOME;
const sessionId = "74747474-7474-4747-8747-747474747474";
const timestamp = Date.parse("2026-09-01T00:00:00Z");

afterEach(async () => {
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "thyra-muse-"));
  roots.push(root);
  return root;
}

// Native envelopes verified with Muse 1.3.0's offline echo provider. Committed
// tool events also match the public Muse 0.2.1 session-migrate native corpus:
// https://github.com/xhluca/session-migrate/tree/c23b1dbd21404f78be3b69d42ff4fb158ff52105/tests/native_corpus/v1/sources/muse
function record(payload_type: string, payload: Record<string, unknown>) {
  return {
    schema_version: 1,
    stream: { kind: "session", id: sessionId },
    recorded_at: timestamp * 1000 + 123456,
    record_type: "event",
    durability: "durable",
    payload_type,
    payload,
  };
}
function run(event: Record<string, unknown>, run_id = "run-1") {
  return record("runtime.session", { kind: "run", run_id, event });
}
function metadata(cwd: string) {
  return record("runtime.session.metadata", {
    kind: "metadata",
    record: {
      workspace_root: cwd,
      model_id: "meta/muse-glimmer-30b",
      build: { semver: "1.3.0" },
    },
  });
}
function configured(provider: string, runId = "run-1") {
  return record("run.model.configured", {
    kind: "run_model",
    record: { provider_id: provider, run_stream: { kind: "run", id: runId } },
  });
}
function conversation(cwd: string) {
  return [
    // Current Muse logs may begin with a permission transaction, not metadata.
    { retained_frame: "session_permission_transaction", children: [] },
    metadata(cwd),
    configured("meta"),
    record("runtime.user_intent.accepted", {
      intent_id: "intent-1",
      model_messages: [{ content: [{ kind: "text", text: "Read README.md" }] }],
      refill_blocks: [{ kind: "text", text: "Read README.md" }],
    }),
    run({ kind: "started", prompt: "Read README.md" }),
    record("runtime.user_intent.materialized", {
      intent_id: "intent-1",
      outcome: { kind: "top_level_turn_started", run_id: "run-1" },
    }),
    run({ kind: "assistant_message_delta", text: "duplicate chunk" }),
    run({ kind: "reasoning_committed", text: "Inspect the file" }),
    run({
      kind: "assistant_tool_calls_committed",
      tool_calls: [
        { call_id: "call-1", name: "read_file", args: '{"path":"README.md"}' },
      ],
    }),
    run({
      kind: "tool_result_batch_committed",
      results: [{ tool_call_id: "call-1", text: "# README" }],
    }),
    run({
      kind: "model_completed",
      model: "meta/muse-glimmer-30b",
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        cached_tokens: 4,
        cache_read_tokens: 4,
        reasoning_tokens: 2,
      },
    }),
    // Task and accounting events are not another main-agent completion.
    record("runtime.session", {
      kind: "task",
      event: { kind: "model_completed", usage: { input_tokens: 900 } },
    }),
    run({ kind: "assistant_message_committed", text: "Read the README." }),
  ];
}
async function writeSession(
  root: string,
  id: string,
  cwd: string,
  time: number,
) {
  const path = join(root, "2026", "09", "01", id, "session.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    conversation(cwd)
      .map((item) => JSON.stringify(item))
      .join("\n") + "\n",
  );
  await utimes(path, new Date(time), new Date(time));
  return path;
}

describe("Muse Code session discovery", () => {
  test("discovers the newest exact workspace, excluding subagents and other workspaces", async () => {
    const root = await tempRoot();
    const cwd = join(root, "work");
    await mkdir(cwd);
    const alias = join(root, "work-alias");
    await symlink(cwd, alias, "junction");
    await writeSession(root, "old", cwd, timestamp);
    const newest = await writeSession(root, sessionId, cwd, timestamp + 1000);
    await writeSession(root, "unrelated", `${cwd}/nested`, timestamp + 2000);
    await writeSession(
      root,
      `${sessionId}/subagent/child`,
      cwd,
      timestamp + 3000,
    );

    expect((await findMuseSession({ cwd: alias }, root))?.path).toBe(newest);
    expect((await findMuseSession({ id: "old" }, root))?.path).toContain(
      "/old/",
    );
    expect(await findMuseSession({ cwd: `${cwd}/absent` }, root)).toBeNull();
    expect(await findMuseSession({ id: "../old" }, root)).toBeNull();
    expect(await findMuseSession({}, root)).toBeNull();
  });

  test("caches and coalesces discovery metadata without pinning the selected session", async () => {
    const root = await tempRoot();
    process.env.XDG_DATA_HOME = root;
    const sessions = join(root, "muse", "sessions");
    const target = await writeSession(sessions, "target", "/work", timestamp);
    const other = await writeSession(
      sessions,
      "other",
      "/else",
      timestamp + 1000,
    );
    const agent = { agent: "muse", cwd: "/work" };
    const context = createAgentSessionResolverContext();
    const read = spyOn(museMetadataReader, "readPrefix");
    const resolve = async () =>
      (await resolveFile(agent, localAgentSessionFiles, context)) ?? {
        path: null,
      };
    try {
      const pair = await Promise.all([resolve(), resolve()]);
      expect(pair.map((result) => result.path)).toEqual([target, target]);
      expect(read).toHaveBeenCalledTimes(2);
      await resolve();
      expect(read).toHaveBeenCalledTimes(2);
      // Another connection must own its own metadata cache.
      await resolveFile(agent);
      expect(read).toHaveBeenCalledTimes(4);
      const newest = await writeSession(
        sessions,
        "new",
        "/work",
        timestamp + 2000,
      );
      expect((await resolve()).path).toBe(newest);
      expect(read).toHaveBeenCalledTimes(5);
      // Rewritten metadata invalidates the cached path even at the same size/mtime.
      const oldStat = await localAgentSessionFiles.statFile(other);
      await writeSession(sessions, "other", "/work", timestamp + 1000);
      expect(
        (await localAgentSessionFiles.statFile(other))?.changeToken,
      ).not.toBe(oldStat?.changeToken);
      await rm(newest);
      expect((await resolve()).path).toBe(other);
      expect(read).toHaveBeenCalledTimes(6);
      await rm(other);
      expect((await resolve()).path).toBe(target);
      expect(read).toHaveBeenCalledTimes(6);
    } finally {
      read.mockRestore();
    }
  });

  test("uses XDG_DATA_HOME and foreground cwd; stays local-only", async () => {
    const root = await tempRoot();
    process.env.XDG_DATA_HOME = root;
    const path = await writeSession(
      join(root, "muse", "sessions"),
      sessionId,
      "/work/actual",
      timestamp,
    );
    const agent = {
      agent: "Muse Code",
      cwd: "/work/pane",
      foreground_cwd: "/work/actual",
    };
    expect((await resolveFile(agent))?.path).toBe(path);
    expect(normalizeAgentName("muse-code")).toBe("muse");

    const byIdAgent = {
      agent: "muse",
      agent_session: { kind: "id", value: sessionId },
    };
    expect((await resolveFile(byIdAgent))?.path).toBe(path);
    expect(await resolveFile({ agent: "muse", cwd: "/absent" })).toBeNull();

    // Remote connections never resolve against this host's sessions.
    const remoteFiles = { ...localAgentSessionFiles, remote: true };
    expect(await resolveFile(agent, remoteFiles)).toBeNull();
    expect(await resolveFile(byIdAgent, remoteFiles)).toBeNull();
  });
});
