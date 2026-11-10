// Typed input for one terminal, sent in typing order. Bytes and semantic
// keys share the queue, so text, keys and pastes reach the pane in the order
// they were typed.
//
// Pipelined (the bridge names `terminal_input_pipeline`): each `terminal.input`
// or `terminal.key` call goes out as it is typed, without waiting for the
// previous reply; the bridge writes one page's input to a terminal in arrival
// order. Input typed within one tick is merged into one call. At most
// MAX_PIPELINED_CALLS calls stay unanswered; past that, input waits and
// merges as below, so a stalled socket holds a bounded backlog. The bridge
// orders per socket, so after the page moves to another socket, input waits
// for the calls sent on the previous one.
//
// Otherwise (an older bridge): one call is in flight, and keystrokes typed
// meanwhile are merged into the next call. Order holds because nothing else
// is in flight.
//
// A paste or composer send (`run`) uses another method, which the bridge
// orders separately, so it never overlaps typed input in either mode: it
// starts once every earlier call was answered, and later input waits for it.

import type { TerminalKey } from "../../shared/terminalKey";
import { bytesToB64 } from "./utils";

const MAX_BATCH_BYTES = 64 * 1024;
const MAX_BATCH_KEYS = 256;
/** Unanswered pipelined calls allowed before input waits for a reply. */
export const MAX_PIPELINED_CALLS = 32;

export type TerminalInput = Uint8Array | TerminalKey[];
type Group =
  | { bytes: Uint8Array[]; size: number }
  | { keys: TerminalKey[] }
  | { task: () => Promise<unknown> };

function isLoneEscape(group: Group): boolean {
  return (
    "bytes" in group &&
    group.bytes.length === 1 &&
    group.bytes[0].length === 1 &&
    group.bytes[0][0] === 0x1b
  );
}

function concat(group: Uint8Array[]): Uint8Array {
  if (group.length === 1) return group[0];
  let length = 0;
  for (const chunk of group) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of group) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export class TerminalInputBatcher {
  /** Calls sent and not yet answered. */
  private unanswered = 0;
  /** A `run` task is the call in flight; nothing overlaps it. */
  private exclusive = false;
  private flushScheduled = false;
  /** Something was queued since `idle` last ran. */
  private busy = false;
  /** The socket the unanswered calls were sent on. */
  private sentOn = 0;
  private queue: Group[] = [];

  constructor(
    private readonly sendNow: (input: TerminalInput) => Promise<unknown>,
    private readonly idle: () => void = () => {},
    /** Whether the bridge orders pipelined input; read at every send. */
    private readonly pipelined: () => boolean = () => false,
    /** Identifies the socket in use; the bridge orders per socket. */
    private readonly transport: () => number = () => 0,
  ) {}

  send(input: TerminalInput): void {
    if (input.length === 0) return;
    this.enqueue(input);
    if (!this.pipelined()) {
      this.pump();
      return;
    }
    // Sent at the end of this tick: input typed in the same tick shares the
    // call, and nothing waits for a reply.
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.pump();
    });
  }

  /**
   * Runs another call for the same pane (a paste, a composer send) in its
   * typing order: after everything already queued, before anything typed
   * later. Settles with the task's own result.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.busy = true;
      this.queue.push({
        task: async () => {
          try {
            resolve(await task());
          } catch (error) {
            reject(error);
          }
        },
      });
      this.pump();
    });
  }

  private enqueue(input: TerminalInput): void {
    this.busy = true;
    const last = this.queue[this.queue.length - 1];
    if (Array.isArray(input)) {
      if (last && "keys" in last && last.keys.length < MAX_BATCH_KEYS)
        last.keys.push(...input);
      else this.queue.push({ keys: [...input] });
      return;
    }
    const escape = input.length === 1 && input[0] === 0x1b;
    // A lone Escape stays its own call so it cannot merge with the next key
    // into an Alt chord.
    if (
      last &&
      "bytes" in last &&
      !escape &&
      !isLoneEscape(last) &&
      last.size + input.length <= MAX_BATCH_BYTES
    ) {
      last.bytes.push(input);
      last.size += input.length;
    } else {
      this.queue.push({ bytes: [input], size: input.length });
    }
  }

  /** Sends from the head of the queue for as long as the mode allows. */
  private pump(): void {
    while (!this.exclusive) {
      const next = this.queue[0];
      if (!next) break;
      if ("task" in next) {
        if (this.unanswered > 0) return;
        this.queue.shift();
        this.exclusive = true;
        this.start(next.task);
        return;
      }
      const limit = this.pipelined() ? MAX_PIPELINED_CALLS : 1;
      if (this.unanswered >= limit) return;
      const transport = this.transport();
      if (this.unanswered > 0 && transport !== this.sentOn) return;
      this.sentOn = transport;
      this.queue.shift();
      const input = "keys" in next ? next.keys : concat(next.bytes);
      this.start(() => this.sendNow(input));
    }
    if (
      this.busy &&
      this.unanswered === 0 &&
      this.queue.length === 0 &&
      !this.exclusive
    ) {
      this.busy = false;
      this.idle();
    }
  }

  private start(call: () => Promise<unknown>): void {
    this.unanswered += 1;
    let pending: Promise<unknown>;
    try {
      pending = call();
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending
      .catch(() => {})
      .finally(() => {
        this.unanswered -= 1;
        this.exclusive = false;
        this.pump();
      });
  }
}

/** The part of a connection client the input queue needs. */
export type TerminalInputClient = {
  readonly connectionId: string;
  readonly generation: number;
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  supports?(capability: "terminal_input_pipeline"): boolean;
  transportEpoch?(): number;
};

const queues = new Map<string, TerminalInputBatcher>();

function terminalInputQueue(
  client: TerminalInputClient,
  terminalId: string,
): TerminalInputBatcher {
  // Keyed by connection generation and terminal, not client object: wrapper
  // clients are recreated across renders and must share one ordered queue.
  const key = `${client.connectionId}\0${client.generation}\0${terminalId}`;
  let queue = queues.get(key);
  if (!queue) {
    queue = new TerminalInputBatcher(
      (batch) =>
        Array.isArray(batch)
          ? client.call("terminal.key", {
              terminal_id: terminalId,
              keys: batch,
            })
          : client.call("terminal.input", {
              terminal_id: terminalId,
              data: bytesToB64(batch),
            }),
      () => {
        if (queues.get(key) === queue) queues.delete(key);
      },
      () => client.supports?.("terminal_input_pipeline") === true,
      () => client.transportEpoch?.() ?? 0,
    );
    queues.set(key, queue);
  }
  return queue;
}

/** Sends typed bytes or semantic keys through the terminal's ordered queue. */
export function queueTerminalInput(
  client: TerminalInputClient,
  input: TerminalInput,
  terminalId: string,
): void {
  terminalInputQueue(client, terminalId).send(input);
}

/**
 * Runs `task` (a paste or composer call for the same pane) in the terminal's
 * ordered queue, so it cannot overtake keys typed before it on a slow link.
 */
export function queueTerminalCall<T>(
  client: TerminalInputClient,
  terminalId: string,
  task: () => Promise<T>,
): Promise<T> {
  return terminalInputQueue(client, terminalId).run(task);
}
