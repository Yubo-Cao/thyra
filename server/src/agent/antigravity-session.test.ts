import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeAntigravitySessionPath,
  findAntigravitySessionById,
  findAntigravitySessionForCwd,
} from "./antigravity-session";
import { localAgentSessionFiles } from "./session-file-access";
import {
  createAgentSessionResolverContext,
  resolveAgentSessionFile,
} from "./session-resolver";

const resolve = (agent: Record<string, unknown>) =>
  resolveAgentSessionFile(
    agent,
    localAgentSessionFiles,
    createAgentSessionResolverContext(),
  );

const tempRoots: string[] = [];
const originalHome = process.env.ANTIGRAVITY_HOME;
const originalConvDir = process.env.ANTIGRAVITY_CONVERSATIONS_DIR;

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  if (originalHome === undefined) delete process.env.ANTIGRAVITY_HOME;
  else process.env.ANTIGRAVITY_HOME = originalHome;
  if (originalConvDir === undefined)
    delete process.env.ANTIGRAVITY_CONVERSATIONS_DIR;
  else process.env.ANTIGRAVITY_CONVERSATIONS_DIR = originalConvDir;
});

function encodeVarint(val: number | bigint): Buffer {
  const bytes: number[] = [];
  let n = BigInt(val);
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function encodeField(
  fieldNum: number,
  wireType: number,
  data: number | bigint | string | Buffer,
): Buffer {
  const tag = (fieldNum << 3) | wireType;
  const tagBuf = encodeVarint(tag);
  if (wireType === 0) {
    return Buffer.concat([tagBuf, encodeVarint(Number(data))]);
  }
  if (wireType === 2) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
    return Buffer.concat([tagBuf, encodeVarint(buf.length), buf]);
  }
  throw new Error(`unsupported wireType ${wireType}`);
}

function makeStepMeta(
  sec: number,
  toolCall?: { id: string; name: string; args: Record<string, unknown> },
): Buffer {
  const secBuf = encodeField(1, 0, sec);
  const timeMsg = encodeField(1, 2, secBuf);
  const parts = [timeMsg];
  if (toolCall) {
    const f1 = encodeField(1, 2, toolCall.id);
    const f2 = encodeField(2, 2, toolCall.name);
    const f3 = encodeField(3, 2, JSON.stringify(toolCall.args));
    parts.push(encodeField(4, 2, Buffer.concat([f1, f2, f3])));
  }
  return Buffer.concat(parts);
}

async function createSyntheticDb(
  root: string,
  sessionId: string,
  cwd: string,
  baseTimeSec = 1726272000,
  options: { model?: string } = {},
): Promise<string> {
  await mkdir(root, { recursive: true });
  const dbPath = join(root, `${sessionId}.db`);
  const db = new Database(dbPath);

  db.run(
    "CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer, PRIMARY KEY (trajectory_id))",
  );
  db.run(
    "CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))",
  );
  db.run(
    "CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))",
  );
  db.run(
    'CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id))',
  );

  db.run("INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)", [
    `traj-${sessionId}`,
    sessionId,
    4,
    17,
  ]);

  const cwdBuf = encodeField(7, 2, `file://${cwd}`);
  db.run("INSERT INTO trajectory_metadata_blob VALUES (?, ?)", [
    "main",
    cwdBuf,
  ]);

  // Step 0: User input
  const userTextBuf = encodeField(2, 2, "Fix the bug in pult");
  const userMsg = encodeField(19, 2, userTextBuf);
  db.run(
    "INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)",
    [0, 14, makeStepMeta(baseTimeSec), userMsg],
  );

  // Step 1: Tool call
  const toolCall = {
    id: "call_1",
    name: "view_file",
    args: { AbsolutePath: "/dev/pult/README.md" },
  };
  const toolOutMsg = encodeField(
    140,
    2,
    encodeField(2, 2, encodeField(1, 2, "Pult documentation content")),
  );
  db.run(
    "INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)",
    [1, 132, makeStepMeta(baseTimeSec + 5, toolCall), toolOutMsg],
  );

  // Step 2: Assistant planner response
  const respText = encodeField(1, 2, "Bug is fixed!");
  const thoughtText = encodeField(3, 2, "I checked the documentation.");
  const plannerMsg = encodeField(20, 2, Buffer.concat([respText, thoughtText]));
  db.run(
    "INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)",
    [2, 15, makeStepMeta(baseTimeSec + 10), plannerMsg],
  );

  // gen_metadata
  const modelName = encodeField(19, 2, options.model ?? "gemini-3.8-flash");
  const tokIn = encodeField(2, 0, 150);
  const tokOut = encodeField(3, 0, 45);
  const tokCached = encodeField(9, 0, 30);
  const usageBuf = encodeField(4, 2, Buffer.concat([tokIn, tokOut, tokCached]));
  const stepIdxKey = encodeField(1, 2, "last_step_index");
  const stepIdxVal = encodeField(2, 2, "2");
  const stepIdxKv = encodeField(20, 2, Buffer.concat([stepIdxKey, stepIdxVal]));
  const genPayload = encodeField(
    1,
    2,
    Buffer.concat([modelName, usageBuf, stepIdxKv]),
  );
  db.run("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)", [0, genPayload]);

  db.close();
  return dbPath;
}

describe("Antigravity sessions", () => {
  test("finds the newest Antigravity session for the exact working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "thyra-agy-test-"));
    tempRoots.push(root);
    const cwd = "/workspace/repo";
    await createSyntheticDb(root, "older-session", cwd, 1726270000);
    await createSyntheticDb(root, "newer-session", cwd, 1726280000, {
      model: "gemini-3.8-flash",
    });
    await createSyntheticDb(
      root,
      "other-session",
      "/workspace/other",
      1726290000,
    );

    const found = await findAntigravitySessionForCwd(cwd, root);

    expect(found?.session.sessionId).toBe("newer-session");
    expect(found?.file.path).toEndWith("newer-session.db");
  });

  test("resolves a known session id with exact name and prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "thyra-agy-test-"));
    tempRoots.push(root);
    await createSyntheticDb(
      root,
      "3f74fcbe-9742-499a-9697-b6a0ef3e2dc2",
      "/workspace/repo",
    );

    const exact = await findAntigravitySessionById(
      "3f74fcbe-9742-499a-9697-b6a0ef3e2dc2",
      "",
      root,
    );
    expect(exact?.session.sessionId).toBe(
      "3f74fcbe-9742-499a-9697-b6a0ef3e2dc2",
    );
    expect(exact?.session.cwd).toBe("/workspace/repo");

    const withExt = await findAntigravitySessionById(
      "3f74fcbe-9742-499a-9697-b6a0ef3e2dc2.db",
      "",
      root,
    );
    expect(withExt?.session.sessionId).toBe(
      "3f74fcbe-9742-499a-9697-b6a0ef3e2dc2",
    );

    const prefix = await findAntigravitySessionById("3f74fcbe", "", root);
    expect(prefix?.session.sessionId).toBe(
      "3f74fcbe-9742-499a-9697-b6a0ef3e2dc2",
    );

    expect(
      await findAntigravitySessionById("../3f74fcbe", "", root),
    ).toBeNull();
  });

  test("describes session path correctly and reads metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "thyra-agy-test-"));
    tempRoots.push(root);
    const dbPath = await createSyntheticDb(
      root,
      "session-desc-1",
      "/workspace/my-project",
      1726272000,
      { model: "gemini-3.8-flash" },
    );

    const desc = await describeAntigravitySessionPath(dbPath);
    expect(desc).not.toBeNull();
    expect(desc?.session.sessionId).toBe("session-desc-1");
    expect(desc?.session.cwd).toBe("/workspace/my-project");
    expect(desc?.file.mtimeMs).toBe((1726272000 + 10) * 1000);
  });

  test("resolves a reported Antigravity session id", async () => {
    const root = await mkdtemp(join(tmpdir(), "thyra-agy-test-"));
    tempRoots.push(root);
    process.env.ANTIGRAVITY_CONVERSATIONS_DIR = root;

    const sessionId = "session-herdr-resolved";
    await createSyntheticDb(root, sessionId, "/workspace/test-repo");

    const file = await resolve({
      agent: "agy",
      cwd: "/workspace/test-repo",
      agent_session: { agent: "agy", kind: "id", value: sessionId },
    });

    expect(file?.sessionId).toBe(sessionId);
    expect(file?.path).toEndWith(`${sessionId}.db`);
  });

  test("resolves Antigravity session via cwd fallback when agent_session is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "thyra-agy-test-"));
    tempRoots.push(root);
    process.env.ANTIGRAVITY_CONVERSATIONS_DIR = root;

    const sessionId = "session-fallback-cwd";
    await createSyntheticDb(root, sessionId, "/workspace/fallback-dir");

    const file = await resolve({
      agent: "antigravity",
      cwd: "/workspace/fallback-dir",
    });

    expect(file?.sessionId).toBe(sessionId);
  });

  test("returns no file when the session cannot be resolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "thyra-agy-test-"));
    tempRoots.push(root);
    process.env.ANTIGRAVITY_CONVERSATIONS_DIR = root;

    expect(await resolve({ agent: "agy", cwd: "" })).toBeNull();
  });

  test("describes unknown or future schemas with fallback metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "thyra-agy-test-"));
    tempRoots.push(root);
    const dbPath = join(root, "unknown-schema-session.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE schema_v99_future (id text, unknown_payload blob)");
    db.run("INSERT INTO schema_v99_future VALUES (?, ?)", [
      "fut-1",
      Buffer.from([0x01, 0x02, 0x03]),
    ]);
    db.close();

    const desc = await describeAntigravitySessionPath(dbPath);
    expect(desc).not.toBeNull();
    expect(desc?.session.sessionId).toBe("unknown-schema-session");
  });
});
