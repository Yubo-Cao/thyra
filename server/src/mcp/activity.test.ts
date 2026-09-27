import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpActivityLog } from "./activity";
import { createRateLimiter } from "./rate-limit";
import { loadMcpConfig } from "./service";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("MCP activity log", () => {
  test("keeps structural and task events within capacity", () => {
    const log = createMcpActivityLog({
      capacity: 2,
      now: () => new Date("2026-09-27T12:00:00.000Z"),
    });
    log.recordHerdrEvent("c", {
      event: "pane.focused",
      data: { pane_id: "w1:p1" },
    });
    log.recordHerdrEvent("c", {
      event: "pane_exited",
      data: { pane_id: "w1:p1" },
    });
    log.recordHerdrEvent("c", {
      event: "workspace.created",
      data: { workspace_id: "w2" },
    });
    log.recordTaskEvent("c", {
      kind: "completed",
      workspaceId: "w1",
      paneId: "w1:p2",
      agent: "claude",
    });
    expect(log.list()).toEqual([
      {
        at: "2026-09-27T12:00:00.000Z",
        connection_id: "c",
        type: "workspace_created",
        workspace_id: "w2",
        tab_id: undefined,
        pane_id: undefined,
        agent: undefined,
      },
      {
        at: "2026-09-27T12:00:00.000Z",
        connection_id: "c",
        type: "agent_completed",
        workspace_id: "w1",
        tab_id: undefined,
        pane_id: "w1:p2",
        agent: "claude",
      },
    ]);
  });
});

describe("MCP rate limiter", () => {
  test("refills over time", () => {
    let now = 0;
    const limiter = createRateLimiter({
      perMinute: 60,
      burst: 2,
      now: () => now,
    });
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(1);
    now += 1000;
    expect(limiter.take("a")).toBe(0);
  });
});

describe("MCP config", () => {
  test("merges file and environment deny patterns", () => {
    const dir = mkdtempSync(join(tmpdir(), "thyra-mcp-config-"));
    dirs.push(dir);
    mkdirSync(join(dir, "thyra"));
    const path = join(dir, "thyra", "mcp.json");
    expect(loadMcpConfig(path, {})).toEqual({
      deny_files: [],
      rate_limit_per_minute: 120,
    });
    writeFileSync(
      path,
      JSON.stringify({ deny_files: ["*.db", 3], rate_limit_per_minute: 30 }),
    );
    expect(
      loadMcpConfig(path, { THYRA_MCP_DENY_FILES: "private, *.sqlite" }),
    ).toEqual({
      deny_files: ["*.db", "private", "*.sqlite"],
      rate_limit_per_minute: 30,
    });
    writeFileSync(path, "{");
    expect(() => loadMcpConfig(path, {})).toThrow("invalid MCP config");
  });
});
