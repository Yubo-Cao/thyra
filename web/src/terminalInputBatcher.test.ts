import { expect, test } from "bun:test";
import {
  type TerminalInput,
  TerminalInputBatcher,
} from "./terminalInputBatcher";

const text = (input: TerminalInput) =>
  Array.isArray(input)
    ? input.map((key) => `<${key.char ?? key.key}>`).join("")
    : new TextDecoder().decode(input);

test("merges keys typed while a call is in flight, in order", async () => {
  const sent: string[] = [];
  const replies: (() => void)[] = [];
  const batcher = new TerminalInputBatcher(
    (bytes) =>
      new Promise<void>((resolve) => {
        sent.push(text(bytes));
        replies.push(resolve);
      }),
  );
  const encode = (value: string) => new TextEncoder().encode(value);
  batcher.send(encode("a"));
  batcher.send(encode("b"));
  batcher.send(encode("c"));
  batcher.send(encode("\x1b"));
  batcher.send(encode("d"));
  expect(sent).toEqual(["a"]);
  replies.shift()!();
  await Bun.sleep(0);
  expect(sent).toEqual(["a", "bc"]);
  replies.shift()!();
  await Bun.sleep(0);
  expect(sent).toEqual(["a", "bc", "\x1b"]);
  replies.shift()!();
  await Bun.sleep(0);
  expect(sent).toEqual(["a", "bc", "\x1b", "d"]);
});

test("keeps semantic keys and bytes in typing order", async () => {
  const sent: string[] = [];
  const replies: (() => void)[] = [];
  const batcher = new TerminalInputBatcher(
    (input) =>
      new Promise<void>((resolve) => {
        sent.push(text(input));
        replies.push(resolve);
      }),
  );
  const key = (char: string) => [{ key: "Char" as const, char, mods: 2 }];
  batcher.send(key("a"));
  batcher.send(key("b"));
  batcher.send(key("c"));
  batcher.send(new TextEncoder().encode("pasted"));
  batcher.send(key("d"));
  for (let i = 0; i < 3; i++) {
    replies.shift()!();
    await Bun.sleep(0);
  }
  expect(sent).toEqual(["<a>", "<b><c>", "pasted", "<d>"]);
});
