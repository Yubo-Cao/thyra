import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClaudeTranscriber,
  promptAfterDialog,
  TRANSCRIBER_SETTINGS,
  transcriberArgv,
  trustAnswer,
  visibleText,
} from "./claude-transcriber";

const silent = { info() {}, warn() {}, debug() {} };

test("strips escape sequences from terminal output", () => {
  expect(visibleText("\x1b7\x1b[1m❯\x1b[0m hi\x1b]0;title\x07\x1b8")).toBe(
    " ❯  hi",
  );
});

test("accepts the folder trust dialog whichever option is selected", () => {
  expect(trustAnswer("Claude Code is ready ❯")).toBeNull();
  expect(
    trustAnswer(
      "Yes, I trust this folder?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm",
    ),
  ).toEqual(["\x1b[B", "\r"]);
  expect(
    trustAnswer(
      "Do you trust this folder?\n ❯ 1. Yes, proceed\n   2. No\n Enter to confirm",
    ),
  ).toEqual(["\r"]);
});

test("the prompt counts only once drawn after the trust dialog", () => {
  const dialog = " ❯ No, exit\n   Yes, I trust this folder\n";
  expect(promptAfterDialog(dialog)).toBe(false);
  expect(promptAfterDialog(`${dialog}\x1b[2J  ❯  Try "fix"`)).toBe(true);
  expect(promptAfterDialog('❯ Try "fix"')).toBe(true);
});

test("runs Claude Code in hold mode without hooks, MCP or auto-submit", () => {
  const argv = transcriberArgv("/bin/claude");
  expect(argv[0]).toBe("/bin/claude");
  expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!)).toEqual(
    TRANSCRIBER_SETTINGS,
  );
  expect(TRANSCRIBER_SETTINGS.voice).toMatchObject({
    mode: "hold",
    autoSubmit: false,
  });
  expect(argv).toContain("--strict-mcp-config");
});

test("is unavailable without claude or when turned off", () => {
  const base = {
    spawn: () => {
      throw new Error("unused");
    },
    stateDir: "/nonexistent",
    logger: silent,
  };
  expect(
    createClaudeTranscriber({ ...base, which: () => null, env: {} }).available()
      .available,
  ).toBe(false);
  expect(
    createClaudeTranscriber({
      ...base,
      which: () => "/bin/claude",
      env: { THYRA_TRANSCRIBER: "off" },
    }).available().available,
  ).toBe(false);
});

test("holds the voice key, then takes the prompt out through the editor", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "thyra-transcriber-"));
  const writes: string[] = [];
  let env: Record<string, string> = {};
  let emit: (text: string) => void = () => {};
  const transcriber = createClaudeTranscriber({
    stateDir,
    logger: silent,
    which: () => "/bin/claude",
    env: { HOME: stateDir, HERDR_PANE_ID: "p1", PATH: "/bin" },
    spawn: (_argv, options) => {
      env = options.env;
      emit = options.onData;
      setTimeout(() => emit("\x1b[2J❯ Try something"), 5);
      return {
        write(data) {
          writes.push(data);
          // The editor script hands the prompt over.
          if (data === "\x07")
            writeFileSync(env.THYRA_TRANSCRIBER_OUT!, "spoken words\n");
        },
        kill() {},
        exited: new Promise(() => {}),
      };
    },
  });
  const take = await transcriber.begin();
  expect(env.HERDR_PANE_ID).toBeUndefined();
  expect(env.EDITOR).toBe(join(stateDir, "transcriber-editor.sh"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const presses = writes.filter((data) => data === "\x1b[24~").length;
  expect(presses).toBeGreaterThanOrEqual(2);
  expect(await take.finish()).toBe("spoken words");
  // Let go: no more presses after the transcript.
  const after = writes.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(writes.length).toBe(after);
  transcriber.stop();
}, 15_000);
