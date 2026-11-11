import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentServiceEnvironment,
  agentSessionArgs,
  agentSessionDefaultArgs,
  splitShellWords,
} from "./default-args";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("default arguments are read per agent and refused when unsafe", () => {
  expect(
    agentSessionDefaultArgs("codex", { THYRA_AGENT_CODEX_ARGS: " --yolo " }),
  ).toBe("--yolo");
  expect(agentSessionDefaultArgs("claude", {})).toBe("");
  expect(
    agentSessionDefaultArgs("claude", {
      THYRA_AGENT_CLAUDE_ARGS: "--model x\nrm -rf /",
    }),
  ).toBe("");
});

test("shell text splits into words as a shell would", () => {
  expect(splitShellWords("")).toEqual([]);
  expect(splitShellWords("  --yolo  -m gpt-x ")).toEqual([
    "--yolo",
    "-m",
    "gpt-x",
  ]);
  expect(
    splitShellWords(
      `-c 'model="o"' --append-system-prompt "a \\"b\\" c" x\\ y ''`,
    ),
  ).toEqual([
    "-c",
    'model="o"',
    "--append-system-prompt",
    'a "b" c',
    "x y",
    "",
  ]);
});

test("defaults apply when the arguments choose nothing but the conversation", () => {
  const env = {
    THYRA_AGENT_CLAUDE_ARGS: "--dangerously-skip-permissions",
    THYRA_AGENT_CODEX_ARGS: "--yolo",
  };
  expect(agentSessionArgs("codex", [], env)).toEqual(["--yolo"]);
  expect(agentSessionArgs("codex", ["resume", "--last"], env)).toEqual([
    "--yolo",
    "resume",
    "--last",
  ]);
  expect(agentSessionArgs("codex", ["resume", "t-1"], env)).toEqual([
    "--yolo",
    "resume",
    "t-1",
  ]);
  expect(agentSessionArgs("claude", [], env)).toEqual([
    "--dangerously-skip-permissions",
  ]);
  expect(agentSessionArgs("claude", ["--resume", "abc"], env)).toEqual([
    "--dangerously-skip-permissions",
    "--resume",
    "abc",
  ]);
  expect(agentSessionArgs("claude", ["--continue"], env)).toEqual([
    "--dangerously-skip-permissions",
    "--continue",
  ]);
  // Arguments that choose anything else replace the defaults.
  expect(agentSessionArgs("codex", ["-a", "on-request"], env)).toEqual([
    "-a",
    "on-request",
  ]);
  expect(
    agentSessionArgs("claude", ["--permission-mode", "plan"], env),
  ).toEqual(["--permission-mode", "plan"]);
  expect(agentSessionArgs("codex", [], {})).toEqual([]);
});

test("a pane reads the service environment file under its own environment", () => {
  const root = mkdtempSync(join(tmpdir(), "thyra-default-args-"));
  roots.push(root);
  const path = join(root, "thyra.env");
  writeFileSync(
    path,
    "# comment\nTHYRA_AGENT_CODEX_ARGS=--yolo\nTHYRA_AGENT_CLAUDE_ARGS='--model opus'\n",
  );
  const env = agentServiceEnvironment({
    THYRA_CONFIG_PATH: path,
    THYRA_AGENT_CLAUDE_ARGS: "--dangerously-skip-permissions",
  });
  expect(agentSessionDefaultArgs("codex", env)).toBe("--yolo");
  expect(agentSessionDefaultArgs("claude", env)).toBe(
    "--dangerously-skip-permissions",
  );
  expect(
    agentServiceEnvironment({ THYRA_CONFIG_PATH: join(root, "missing") })
      .THYRA_AGENT_CODEX_ARGS,
  ).toBeUndefined();
});
