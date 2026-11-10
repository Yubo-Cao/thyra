import { expect, test } from "bun:test";
import {
  queueTerminalCall,
  queueTerminalInput,
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

test("a queued call keeps its place between typed input", async () => {
  const sent: string[] = [];
  const replies: (() => void)[] = [];
  const pending = () =>
    new Promise<void>((resolve) => {
      replies.push(resolve);
    });
  const batcher = new TerminalInputBatcher((input) => {
    sent.push(text(input));
    return pending();
  });
  const encode = (value: string) => new TextEncoder().encode(value);
  batcher.send(encode("a"));
  batcher.send(encode("b"));
  const pasted = batcher.run(async () => {
    sent.push("[paste]");
    await pending();
    return "done";
  });
  batcher.send(encode("c"));
  batcher.send(encode("d"));
  expect(sent).toEqual(["a"]);
  for (let i = 0; i < 2; i++) {
    replies.shift()!();
    await Bun.sleep(0);
  }
  expect(sent).toEqual(["a", "b", "[paste]"]);
  replies.shift()!();
  expect(await pasted).toBe("done");
  await Bun.sleep(0);
  expect(sent).toEqual(["a", "b", "[paste]", "cd"]);
});

test("a failed queued call rejects its caller and the queue continues", async () => {
  const sent: string[] = [];
  let idle = 0;
  const batcher = new TerminalInputBatcher(
    async (input) => {
      sent.push(text(input));
    },
    () => idle++,
  );
  const failed = batcher.run(async () => {
    throw new Error("paste failed");
  });
  batcher.send(new TextEncoder().encode("x"));
  await expect(failed).rejects.toThrow("paste failed");
  await Bun.sleep(0);
  expect(sent).toEqual(["x"]);
  expect(idle).toBe(1);
});

test("typed input and calls for one terminal share a queue across client objects", async () => {
  const calls: string[] = [];
  const replies: (() => void)[] = [];
  const client = () => ({
    connectionId: "c1",
    generation: 3,
    call(method: string) {
      calls.push(method);
      return new Promise<void>((resolve) => {
        replies.push(resolve);
      });
    },
  });
  const typing = client();
  const pasting = client();
  queueTerminalInput(typing, new TextEncoder().encode("a"), "t1");
  queueTerminalInput(typing, [{ key: "Enter", mods: 0 }], "t1");
  const pasted = queueTerminalCall(pasting, "t1", () =>
    pasting.call("pane.send_input"),
  );
  // Another terminal is not held up.
  queueTerminalInput(typing, new TextEncoder().encode("z"), "t2");
  expect(calls).toEqual(["terminal.input", "terminal.input"]);
  replies.shift()!();
  await Bun.sleep(0);
  expect(calls).toEqual(["terminal.input", "terminal.input", "terminal.key"]);
  replies.splice(0).forEach((reply) => reply());
  await Bun.sleep(0);
  expect(calls[3]).toBe("pane.send_input");
  replies.splice(0).forEach((reply) => reply());
  await pasted;
});
