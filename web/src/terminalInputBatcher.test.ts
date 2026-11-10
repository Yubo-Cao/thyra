import { expect, test } from "bun:test";
import {
  MAX_PIPELINED_CALLS,
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

// A batcher against a bridge that orders pipelined input.
function pipelinedBatcher(transport: () => number = () => 0) {
  const sent: string[] = [];
  const replies: { resolve(): void; reject(error: Error): void }[] = [];
  let idle = 0;
  const batcher = new TerminalInputBatcher(
    (input) =>
      new Promise<void>((resolve, reject) => {
        sent.push(text(input));
        replies.push({ resolve, reject });
      }),
    () => idle++,
    () => true,
    transport,
  );
  return { batcher, sent, replies, idleCount: () => idle };
}
const bytes = (value: string) => new TextEncoder().encode(value);

test("pipelined input goes out without waiting for the previous reply", async () => {
  const { batcher, sent, replies, idleCount } = pipelinedBatcher();
  batcher.send(bytes("a"));
  await Bun.sleep(0);
  batcher.send(bytes("b"));
  await Bun.sleep(0);
  batcher.send([{ key: "Enter", mods: 0 }]);
  await Bun.sleep(0);
  // Nothing was answered, and every key is already on the wire, in order.
  expect(replies).toHaveLength(3);
  expect(sent).toEqual(["a", "b", "<Enter>"]);
  expect(idleCount()).toBe(0);
  replies.splice(0).forEach((reply) => reply.resolve());
  await Bun.sleep(0);
  expect(idleCount()).toBe(1);
});

test("pipelined input typed within one tick shares a call", async () => {
  const { batcher, sent } = pipelinedBatcher();
  batcher.send(bytes("a"));
  batcher.send(bytes("b"));
  batcher.send(bytes("\x1b"));
  batcher.send(bytes("c"));
  // Sent at the end of the tick, not inside `send`.
  expect(sent).toEqual([]);
  await Bun.sleep(0);
  // A lone Escape still travels alone.
  expect(sent).toEqual(["ab", "\x1b", "c"]);
});

test("a pipelined call that is rejected does not hold up the next", async () => {
  const { batcher, sent, replies } = pipelinedBatcher();
  batcher.send(bytes("a"));
  await Bun.sleep(0);
  batcher.send(bytes("b"));
  await Bun.sleep(0);
  replies[0].reject(new Error("another collaborator controls this pane"));
  await Bun.sleep(0);
  batcher.send(bytes("c"));
  await Bun.sleep(0);
  expect(sent).toEqual(["a", "b", "c"]);
});

test("the unanswered backlog is capped; input past it waits and merges", async () => {
  const { batcher, sent, replies } = pipelinedBatcher();
  for (let i = 0; i < MAX_PIPELINED_CALLS; i++) {
    batcher.send(bytes("k"));
    await Bun.sleep(0);
  }
  expect(sent).toHaveLength(MAX_PIPELINED_CALLS);
  // The socket stalled: more typing is held here, merged into one call.
  for (const char of "wxyz") {
    batcher.send(bytes(char));
    await Bun.sleep(0);
  }
  expect(sent).toHaveLength(MAX_PIPELINED_CALLS);
  replies.shift()!.resolve();
  await Bun.sleep(0);
  expect(sent).toHaveLength(MAX_PIPELINED_CALLS + 1);
  expect(sent[sent.length - 1]).toBe("wxyz");
  // Back under the cap, input is immediate again.
  replies.shift()!.resolve();
  await Bun.sleep(0);
  batcher.send(bytes("!"));
  await Bun.sleep(0);
  expect(sent[sent.length - 1]).toBe("!");
});

test("a paste never overlaps pipelined input on either side", async () => {
  const { batcher, sent, replies } = pipelinedBatcher();
  let finishPaste = () => {};
  batcher.send(bytes("a"));
  await Bun.sleep(0);
  batcher.send(bytes("b"));
  await Bun.sleep(0);
  const pasted = batcher.run(
    () =>
      new Promise<string>((resolve) => {
        sent.push("PASTE");
        finishPaste = () => resolve("ok");
      }),
  );
  batcher.send(bytes("c"));
  await Bun.sleep(0);
  // The paste waits for both keys to be answered.
  expect(sent).toEqual(["a", "b"]);
  replies[1].resolve();
  await Bun.sleep(0);
  expect(sent).toEqual(["a", "b"]);
  replies[0].resolve();
  await Bun.sleep(0);
  expect(sent).toEqual(["a", "b", "PASTE"]);
  // Keys typed after it wait for its reply.
  batcher.send(bytes("d"));
  await Bun.sleep(0);
  expect(sent).toEqual(["a", "b", "PASTE"]);
  finishPaste();
  expect(await pasted).toBe("ok");
  await Bun.sleep(0);
  expect(sent).toEqual(["a", "b", "PASTE", "cd"]);
});

test("a failed paste rejects its caller and releases pipelined input", async () => {
  const { batcher, sent } = pipelinedBatcher();
  const failed = batcher.run(async () => {
    throw new Error("another collaborator controls this pane");
  });
  batcher.send(bytes("x"));
  await expect(failed).rejects.toThrow("another collaborator controls");
  await Bun.sleep(0);
  expect(sent).toEqual(["x"]);
});

test("pipelined input does not straddle a move to another socket", async () => {
  let socket = 0;
  const { batcher, sent, replies } = pipelinedBatcher(() => socket);
  batcher.send(bytes("a"));
  await Bun.sleep(0);
  socket = 1;
  batcher.send(bytes("b"));
  await Bun.sleep(0);
  batcher.send(bytes("c"));
  await Bun.sleep(0);
  // The bridge orders per socket: wait for what the old one still owes.
  expect(sent).toEqual(["a"]);
  replies[0].resolve();
  await Bun.sleep(0);
  expect(sent).toEqual(["a", "bc"]);
  batcher.send(bytes("d"));
  await Bun.sleep(0);
  expect(sent).toEqual(["a", "bc", "d"]);
});

test("the shared queue pipelines only when the bridge names the capability", async () => {
  const run = async (capabilities: string[] | null) => {
    const calls: string[] = [];
    const client = {
      connectionId: `caps-${capabilities?.join("+") ?? "none"}`,
      generation: 1,
      call(method: string) {
        calls.push(method);
        return new Promise<void>(() => {});
      },
      ...(capabilities
        ? { supports: (name: string) => capabilities.includes(name) }
        : {}),
    };
    queueTerminalInput(client, bytes("a"), "t1");
    await Bun.sleep(0);
    queueTerminalInput(client, [{ key: "Enter", mods: 0 }], "t1");
    await Bun.sleep(0);
    return calls;
  };
  // A bridge that orders input: both calls are out, unanswered.
  expect(await run(["terminal_input_pipeline"])).toEqual([
    "terminal.input",
    "terminal.key",
  ]);
  // An older bridge, or one naming other capabilities: one call in flight.
  expect(await run(["terminal_frame_ack_notify"])).toEqual(["terminal.input"]);
  expect(await run(null)).toEqual(["terminal.input"]);
});
