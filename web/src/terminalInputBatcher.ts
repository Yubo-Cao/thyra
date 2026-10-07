// Keystrokes typed while an earlier `terminal.input` or `terminal.key` call is
// still unanswered are merged into the next call. On a fast link every key
// still goes out on its own; on a slow one, a burst costs one request and one
// repaint instead of one per key, and order is preserved because only one
// call is in flight. Bytes and semantic keys share the queue, so text, keys
// and pastes reach the pane in the order they were typed.

import type { TerminalKey } from "../../shared/terminalKey";

const MAX_BATCH_BYTES = 64 * 1024;
const MAX_BATCH_KEYS = 256;

export type TerminalInput = Uint8Array | TerminalKey[];
type Group = { bytes: Uint8Array[]; size: number } | { keys: TerminalKey[] };

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
  private inflight = false;
  private queue: Group[] = [];

  constructor(
    private readonly sendNow: (input: TerminalInput) => Promise<unknown>,
    private readonly idle: () => void = () => {},
  ) {}

  send(input: TerminalInput): void {
    if (input.length === 0) return;
    if (!this.inflight) {
      this.dispatch(input);
      return;
    }
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

  private dispatch(input: TerminalInput): void {
    this.inflight = true;
    this.sendNow(input)
      .catch(() => {})
      .finally(() => {
        this.inflight = false;
        const next = this.queue.shift();
        if (!next) {
          this.idle();
          return;
        }
        this.dispatch("keys" in next ? next.keys : concat(next.bytes));
      });
  }
}
