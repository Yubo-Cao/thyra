/**
 * A stand-in for `claude -p` in process-level tests: it speaks just enough
 * of the stream-json and control protocols for one text turn, and records
 * how it was started in the file named by FAKE_AGENT_RECORD.
 */
import { writeFileSync } from "node:fs";

if (process.env.FAKE_AGENT_RECORD)
  writeFileSync(
    process.env.FAKE_AGENT_RECORD,
    JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      herdrEnv: process.env.HERDR_ENV ?? null,
      herdrAgent: process.env.HERDR_AGENT ?? null,
      herdrPane: process.env.HERDR_PANE_ID ?? null,
    }),
  );

const say = (message: unknown) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);
const session_id = "00000000-0000-4000-8000-000000000001";

function turn(uuid: string, prompt: string) {
  if (prompt === "crash") {
    process.stderr.write("fake agent: simulated crash\n");
    process.exit(3);
  }
  say({ type: "command_lifecycle", command_uuid: uuid, state: "started" });
  say({
    type: "system",
    subtype: "init",
    session_id,
    model: "fake-model",
    permissionMode: "default",
    cwd: process.cwd(),
  });
  const stream = (event: unknown) =>
    say({ type: "stream_event", event, session_id, parent_tool_use_id: null });
  stream({
    type: "message_start",
    message: { id: "msg_fake", usage: { input_tokens: 10, output_tokens: 1 } },
  });
  stream({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  for (const piece of ["You said: ", prompt])
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: piece },
    });
  say({
    type: "assistant",
    session_id,
    parent_tool_use_id: null,
    message: {
      id: "msg_fake",
      content: [{ type: "text", text: `You said: ${prompt}` }],
    },
  });
  stream({ type: "content_block_stop", index: 0 });
  stream({ type: "message_stop" });
  say({
    type: "result",
    subtype: "success",
    is_error: false,
    queued_turn_count: 0,
    session_id,
  });
  say({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end === -1) break;
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.type === "control_request")
      say({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response:
            message.request.subtype === "initialize"
              ? { current_permission_mode: "default" }
              : message.request.subtype === "set_permission_mode"
                ? { mode: message.request.mode }
                : {},
        },
      });
    else if (message.type === "user")
      turn(message.uuid, message.message.content);
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
