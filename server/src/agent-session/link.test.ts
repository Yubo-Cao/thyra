import { expect, test } from "bun:test";
import { createLineReader, parseBridgeMessage, parseHostMessage } from "./link";

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
  for (const line of [
    "not json",
    "[]",
    '{"type":"action","action":"interrupt"}',
    '{"type":"action","id":"1","action":"interrupt"}',
    '{"type":"action","id":1,"action":"send"}',
    '{"type":"action","id":1,"action":"send","text":5}',
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
