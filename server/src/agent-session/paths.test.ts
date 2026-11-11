import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentSocketDir,
  agentSocketName,
  agentSocketPath,
  herdrSocketKey,
  isPrivateAgentSocketDir,
  parseAgentSocketName,
  prepareAgentSocketDir,
} from "./paths";

test("the socket directory comes from the override, the runtime dir, then state", () => {
  expect(
    agentSocketDir({
      THYRA_AGENT_SOCKET_DIR: "/tmp/override",
      XDG_RUNTIME_DIR: "/run/user/1",
    }),
  ).toBe("/tmp/override");
  expect(agentSocketDir({ XDG_RUNTIME_DIR: "/run/user/1", HOME: "/h" })).toBe(
    "/run/user/1/thyra/agents",
  );
  expect(agentSocketDir({ HOME: "/h", XDG_STATE_HOME: "/state" })).toBe(
    "/state/thyra/agents",
  );
  expect(agentSocketDir({ HOME: "/h" })).toBe("/h/.local/state/thyra/agents");
});

test("a socket name carries the Herdr server and the pane, reversibly", () => {
  const key = herdrSocketKey("/nonexistent/herdr.sock");
  expect(key).toMatch(/^[0-9a-f]{12}$/);
  expect(herdrSocketKey("/nonexistent/other.sock")).not.toBe(key);
  for (const pane of ["w1:p3", "w12:p4", "odd/pane id", "pane.sock", "a-b_c"]) {
    const name = agentSocketName(key, pane);
    expect(name).not.toContain("/");
    expect(parseAgentSocketName(name)).toEqual({ herdrKey: key, paneId: pane });
  }
  expect(agentSocketName(key, "w1:p3")).toBe(`${key}-w1%3Ap3.sock`);
});

test("names this module would not write are not sockets", () => {
  const key = "0123456789ab";
  for (const name of [
    "w1%3Ap3.sock",
    `${key}-.sock`,
    `${key}-w1%3Ap3`,
    `${key}-w1:p3.sock`,
    `${key}-w1%3ap3.sock`,
    `${key}-%E0%A4%A.sock`,
    `${key.toUpperCase()}-x.sock`,
    ".thyra-tmp",
  ])
    expect(parseAgentSocketName(name)).toBeNull();
});

test("the Herdr key follows symlinks to the same socket", () => {
  const root = mkdtempSync(join(tmpdir(), "thyra-agent-paths-"));
  try {
    const real = join(root, "herdr.sock");
    Bun.write(real, "");
    symlinkSync(real, join(root, "link.sock"));
    expect(herdrSocketKey(join(root, "link.sock"))).toBe(herdrSocketKey(real));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the directory is created private and a loose one is tightened", () => {
  const root = mkdtempSync(join(tmpdir(), "thyra-agent-paths-"));
  try {
    const dir = join(root, "thyra", "agents");
    expect(isPrivateAgentSocketDir(dir)).toBe(false);
    prepareAgentSocketDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(isPrivateAgentSocketDir(dir)).toBe(true);
    chmodSync(dir, 0o755);
    expect(isPrivateAgentSocketDir(dir)).toBe(false);
    prepareAgentSocketDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // A symlink in its place is refused rather than followed.
    const link = join(root, "link");
    symlinkSync(dir, link);
    expect(() => prepareAgentSocketDir(link)).toThrow("not a directory");
    expect(isPrivateAgentSocketDir(link)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a socket path too long for the kernel is refused", () => {
  expect(() =>
    agentSocketPath(`/tmp/${"d".repeat(90)}`, "/herdr.sock", "w1:p1"),
  ).toThrow("too long");
  expect(agentSocketPath("/tmp/agents", "/herdr.sock", "w1:p1")).toMatch(
    /^\/tmp\/agents\/[0-9a-f]{12}-w1%3Ap1\.sock$/,
  );
});
