import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGrokSessionById, findGrokSessionForCwd } from "./grok-session";
import { localAgentSessionFiles } from "./session-file-access";
import {
  createAgentSessionResolverContext,
  resolveAgentSessionFile,
} from "./session-resolver";

const tempRoots: string[] = [];
const originalGrokHome = process.env.GROK_HOME;

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true })),
  );
  if (originalGrokHome === undefined) {
    delete process.env.GROK_HOME;
  } else {
    process.env.GROK_HOME = originalGrokHome;
  }
});

async function createSession(
  root: string,
  cwd: string,
  id: string,
  updatedAt: string,
) {
  const sessionDir = join(root, encodeURIComponent(cwd), id);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "chat_history.jsonl"), '{"type":"user"}\n');
  await writeFile(
    join(sessionDir, "summary.json"),
    JSON.stringify({
      info: { id, cwd },
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: updatedAt,
      current_model_id: "grok-4.5",
    }),
  );
  return sessionDir;
}

describe("Grok Build sessions", () => {
  test("finds the newest session for the exact working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-grok-"));
    tempRoots.push(root);
    const cwd = "/workspace/repo";
    await createSession(root, cwd, "older", "2026-07-01T00:00:00.000Z");
    await createSession(root, cwd, "newer", "2026-07-02T00:00:00.000Z");
    await createSession(
      root,
      "/workspace/other",
      "other",
      "2026-07-03T00:00:00.000Z",
    );

    const found = await findGrokSessionForCwd(cwd, root);

    expect(found?.session.sessionId).toBe("newer");
    expect(found?.file.path).toEndWith("newer/chat_history.jsonl");
  });

  test("resolves a known session id without an integration-provided path", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-grok-"));
    tempRoots.push(root);
    await createSession(
      root,
      "/workspace/repo",
      "session-1",
      "2026-07-01T00:00:00Z",
    );

    const found = await findGrokSessionById("session-1", "", root);

    expect(found?.session.cwd).toBe("/workspace/repo");
    expect(await findGrokSessionById("../session-1", "", root)).toBeNull();
  });

  test("uses the foreground process cwd instead of the pane identity cwd", async () => {
    const home = await mkdtemp(join(tmpdir(), "herdr-grok-home-"));
    tempRoots.push(home);
    process.env.GROK_HOME = home;
    const foregroundCwd = "/workspace/actual-agent-directory";
    await createSession(
      join(home, "sessions"),
      foregroundCwd,
      "foreground-session",
      "2026-07-02T00:00:00.000Z",
    );

    const file = await resolveAgentSessionFile(
      {
        agent: "grok",
        cwd: "/workspace/pane-identity-directory",
        foreground_cwd: foregroundCwd,
      },
      localAgentSessionFiles,
      createAgentSessionResolverContext(),
    );

    expect(file?.sessionId).toBe("foreground-session");
  });
});
