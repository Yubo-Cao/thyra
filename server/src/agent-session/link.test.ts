import { expect, test } from "bun:test";
import {
  AGENT_LINK_PROTOCOL,
  createLineReader,
  forkArgsOf,
  isAgentSessionId,
  parseBridgeMessage,
  parseHostMessage,
} from "./link";

function reader(maxLineBytes?: number) {
  const lines: string[] = [];
  let overflowed = 0;
  const read = createLineReader(
    (line) => lines.push(line),
    () => {
      overflowed += 1;
    },
    maxLineBytes,
  );
  return { lines, read, overflowed: () => overflowed };
}

test("lines are split across chunks without breaking a character", () => {
  const { lines, read } = reader();
  const bytes = new TextEncoder().encode('{"a":"héllo 😀"}\n\n{"b":2}\n{"c"');
  // One byte at a time splits every multi-byte character.
  for (const byte of bytes) read(new Uint8Array([byte]));
  expect(lines).toEqual(['{"a":"héllo 😀"}', '{"b":2}']);
  read(new TextEncoder().encode(":3}\n"));
  expect(lines.at(-1)).toBe('{"c":3}');
});

test("a line past the limit stops the reader once", () => {
  const { lines, read, overflowed } = reader(16);
  read(new TextEncoder().encode("short\n"));
  read(new TextEncoder().encode("x".repeat(40)));
  read(new TextEncoder().encode("more\nlater\n"));
  expect(lines).toEqual(["short"]);
  expect(overflowed()).toBe(1);
});

test("only well-formed actions are accepted from the bridge", () => {
  expect(
    parseBridgeMessage('{"type":"action","id":1,"action":"send","text":"hi"}'),
  ).toEqual({
    type: "action",
    id: 1,
    action: "send",
    text: "hi",
  });
  expect(
    parseBridgeMessage(
      '{"type":"action","id":2,"action":"approve","approval_id":"a","option_id":"o","extra":1}',
    ),
  ).toEqual({
    type: "action",
    id: 2,
    action: "approve",
    approval_id: "a",
    option_id: "o",
  });
  expect(
    parseBridgeMessage('{"type":"action","id":3,"action":"interrupt"}'),
  ).toEqual({
    type: "action",
    id: 3,
    action: "interrupt",
  });
  expect(
    parseBridgeMessage('{"type":"action","id":4,"action":"history","x":1}'),
  ).toEqual({ type: "action", id: 4, action: "history" });
  // A prompt's images travel as paths; anything else in an entry is dropped,
  // and an entry without a path is left for the host to refuse by number.
  expect(
    parseBridgeMessage(
      '{"type":"action","id":6,"action":"send","text":"","images":[{"path":"/tmp/a.png","data":"x"},{},"junk"]}',
    ),
  ).toEqual({
    type: "action",
    id: 6,
    action: "send",
    text: "",
    images: [{ path: "/tmp/a.png" }, { path: "" }, { path: "" }],
  });
  expect(
    parseBridgeMessage(
      '{"type":"action","id":7,"action":"send","text":"hi","images":[]}',
    ),
  ).toEqual({ type: "action", id: 7, action: "send", text: "hi" });
  expect(
    parseBridgeMessage(
      '{"type":"action","id":5,"action":"resume","session_id":"0a1b-2c3d"}',
    ),
  ).toEqual({
    type: "action",
    id: 5,
    action: "resume",
    session_id: "0a1b-2c3d",
  });
  // How a prompt goes during a turn, and the actions that came with it.
  expect(
    parseBridgeMessage(
      '{"type":"action","id":8,"action":"send","text":"hi","delivery":"queue"}',
    ),
  ).toEqual({
    type: "action",
    id: 8,
    action: "send",
    text: "hi",
    delivery: "queue",
  });
  for (const [line, action] of [
    ['"unqueue","prompt_id":"q1"', { action: "unqueue", prompt_id: "q1" }],
    ['"set_model","model":"m"', { action: "set_model", model: "m" }],
    ['"set_effort","effort":"high"', { action: "set_effort", effort: "high" }],
    ['"compact"', { action: "compact" }],
  ] as const)
    expect(
      parseBridgeMessage(`{"type":"action","id":9,"action":${line}}`),
    ).toEqual({ type: "action", id: 9, ...action });
  for (const line of [
    '{"type":"action","id":1,"action":"send","text":"x","delivery":"later"}',
    '{"type":"action","id":1,"action":"unqueue"}',
    '{"type":"action","id":1,"action":"set_model","model":1}',
    '{"type":"action","id":1,"action":"set_effort"}',
    "not json",
    "[]",
    '{"type":"action","id":1,"action":"resume"}',
    '{"type":"action","id":1,"action":"resume","session_id":7}',
    '{"type":"action","action":"interrupt"}',
    '{"type":"action","id":"1","action":"interrupt"}',
    '{"type":"action","id":1,"action":"send"}',
    '{"type":"action","id":1,"action":"send","text":5}',
    '{"type":"action","id":1,"action":"send","text":"x","images":"/tmp/a.png"}',
    '{"type":"action","id":1,"action":"send","images":[{"path":"/tmp/a.png"}]}',
    '{"type":"action","id":1,"action":"approve","approval_id":"a"}',
    '{"type":"action","id":1,"action":"set_mode"}',
    '{"type":"action","id":1,"action":"shutdown"}',
    '{"type":"event","id":1}',
  ])
    expect(parseBridgeMessage(line)).toBeNull();
});

test("host messages are checked as far as the bridge relies on them", () => {
  const snapshot = {
    info: { pane_id: "w1:p1", kind: "claude", status: "idle" },
    items: [],
    approvals: [],
    seq: 0,
  };
  const hello = {
    type: "hello",
    protocol: 1,
    pane_id: "w1:p1",
    herdr_socket: "/h",
    pid: 1,
    snapshot,
  };
  expect(parseHostMessage(JSON.stringify(hello))).toEqual(hello as never);
  expect(
    parseHostMessage('{"type":"result","id":4,"error":"no","more":true}'),
  ).toEqual({
    type: "result",
    id: 4,
    error: "no",
  });
  expect(parseHostMessage('{"type":"result","id":4}')).toEqual({
    type: "result",
    id: 4,
  });
  // What an action answers with comes through as it is.
  expect(
    parseHostMessage('{"type":"result","id":5,"value":[{"id":"a"}]}'),
  ).toEqual({ type: "result", id: 5, value: [{ id: "a" }] });
  const event = {
    type: "event",
    event: { pane_id: "w1:p1", seq: 1, type: "delta", id: "m", text: "x" },
  };
  expect(parseHostMessage(JSON.stringify(event))).toEqual(event as never);
  for (const bad of [
    "nope",
    '"text"',
    JSON.stringify({ ...hello, pane_id: "w1:p2" }),
    JSON.stringify({ ...hello, snapshot: { ...snapshot, items: null } }),
    JSON.stringify({ ...hello, herdr_socket: 1 }),
    '{"type":"event","event":{"seq":1,"type":"delta"}}',
    '{"type":"result"}',
    '{"type":"unknown"}',
  ])
    expect(parseHostMessage(bad)).toBeNull();
});

test("a conversation ID is a plain token", () => {
  for (const id of [
    "0a1b2c3d-0000-4000-8000-000000000001",
    "01a1cbe0-ba9f-73d2-a43a-69d53e781ff4",
    "abc_1",
    "A",
  ])
    expect(isAgentSessionId(id)).toBe(true);
  // It becomes an argument and a file name: nothing that reads as an
  // option, a path or a second argument.
  for (const id of [
    "",
    "-r",
    "--resume",
    "_x",
    "a/b",
    "..",
    "a.b",
    "a b",
    "a\nb",
    "caf\u00e9",
    "x".repeat(129),
    5,
    null,
    undefined,
  ])
    expect(isAgentSessionId(id)).toBe(false);
});

test("hosts of builds before and after resume speak the same protocol number", () => {
  // The bridge drops a host that reports another number, and hosts keep
  // their binary across deploys: new actions do not raise it.
  expect(AGENT_LINK_PROTOCOL).toBe(1);
});

test("rewind names a prompt; a branch may", () => {
  expect(
    parseBridgeMessage(
      '{"type":"action","id":5,"action":"rewind","item_id":"u1"}',
    ),
  ).toEqual({ type: "action", id: 5, action: "rewind", item_id: "u1" });
  expect(
    parseBridgeMessage('{"type":"action","id":6,"action":"rewind"}'),
  ).toBeNull();
  expect(
    parseBridgeMessage('{"type":"action","id":7,"action":"fork"}'),
  ).toEqual({ type: "action", id: 7, action: "fork" });
  expect(
    parseBridgeMessage(
      '{"type":"action","id":8,"action":"fork","item_id":"u2"}',
    ),
  ).toEqual({ type: "action", id: 8, action: "fork", item_id: "u2" });
  expect(
    parseBridgeMessage('{"type":"action","id":9,"action":"fork","item_id":3}'),
  ).toBeNull();
  // What a host answers a branch with is typed into a shell: plain arguments.
  expect(forkArgsOf({ args: ["--resume", "a b", "it's"] })).toEqual([
    "--resume",
    "a b",
    "it's",
  ]);
  expect(forkArgsOf({ args: [] })).toEqual([]);
  for (const value of [
    undefined,
    { args: "x" },
    { args: [1] },
    { args: ["a\nb"] },
    { args: ["\u001b[31m"] },
    { args: Array.from({ length: 65 }, () => "x") },
  ])
    expect(forkArgsOf(value)).toBeNull();
});
