import { expect, test } from "bun:test";
import { join } from "node:path";
test("MCP survives malformed frames, ignores notifications, lists tools and reports failed calls", async () => {
  const cli = join(import.meta.dir, "cli.ts");
  const process = Bun.spawn(
    [
      Bun.which("bun")!,
      "-e",
      `import {runMessageBoardCommand} from ${JSON.stringify(cli)}; process.exit(await runMessageBoardCommand(['message-board','mcp']) ?? 1);`,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, THYRA_BOARD_URL: "", THYRA_BOARD_TOKEN: "" },
    },
  );
  for (const line of [
    "{",
    "null",
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "leave_message", arguments: { title: "test", body: "" } },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "toString" },
    }),
  ])
    process.stdin.write(line + "\n");
  process.stdin.end();
  const output = (await new Response(process.stdout).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(await process.exited).toBe(0);
  expect(output).toHaveLength(6);
  expect(output[0].error.code).toBe(-32700);
  expect(output[1].error.code).toBe(-32600);
  expect(output[2].result.serverInfo.name).toBe("thyra-message-board");
  expect(output[3].result.tools).toHaveLength(3);
  expect(output[4].result.isError).toBe(true);
  expect(output[5].error.code).toBe(-32602);
});
