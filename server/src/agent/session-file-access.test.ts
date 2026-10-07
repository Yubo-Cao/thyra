import { describe, expect, test } from "bun:test";
import { createAgentSessionFileAccess } from "./session-file-access";

const remotePath = "/srv/thyra-test/sessions/pi-session.jsonl";
const metadata = `42\t1784872800\t${Buffer.from(remotePath).toString("base64")}\t1:42\t1784872800.123:1784872800.456\n`;

function quote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe("agent session file access", () => {
  test("stats reported session files through SSH", async () => {
    const commands: string[][] = [];
    const files = createAgentSessionFileAccess({
      sshHost: "operator@example.com",
      shQuote: quote,
      async runBinaryProcessWithTimeout(argv) {
        commands.push(argv);
        return { code: 0, stdout: Buffer.from(metadata), stderr: "" };
      },
    });

    expect(await files.statFile(remotePath)).toEqual({
      path: remotePath,
      size: 42,
      mtimeMs: 1_784_872_800_000,
      identity: "1:42",
      changeToken: "1784872800.123:1784872800.456",
    });
    expect(
      commands.every(
        (command) =>
          command[0] === "ssh" &&
          command.includes("BatchMode=yes") &&
          command.includes("StrictHostKeyChecking=yes") &&
          command.at(-2) === "operator@example.com" &&
          command.at(-3) === "--",
      ),
    ).toBe(true);
  });

  test("returns null when a remote session file is missing", async () => {
    const files = createAgentSessionFileAccess({
      sshHost: "operator@example.com",
      shQuote: quote,
      async runBinaryProcessWithTimeout() {
        return { code: 44, stdout: Buffer.alloc(0), stderr: "" };
      },
    });

    expect(await files.statFile(remotePath)).toBeNull();
    expect(await files.findPiSessionById("missing")).toBeNull();
  });
});
