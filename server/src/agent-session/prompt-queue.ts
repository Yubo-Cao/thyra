import type { PromptImage } from "./prompt-images";
import type { AgentSessionStore } from "./store";

type Entry = { id: string; text: string; images: PromptImage[]; at: number };

/**
 * Prompts held by the host until the running turn ends: shown in
 * `info.queued`, and sent one at a time, each once the session is idle again.
 * The queue lives in the host, so it outlasts pages and bridge restarts.
 */
export class PromptQueue {
  private entries: Entry[] = [];
  private nextId = 1;
  private sending = false;

  constructor(
    private readonly store: AgentSessionStore,
    private readonly deliver: (
      text: string,
      images: PromptImage[],
    ) => Promise<void>,
  ) {}

  get size(): number {
    return this.entries.length;
  }

  /** Hold a prompt: last, or (`first`) ahead of the others. */
  add(text: string, images: PromptImage[], first = false) {
    const entry = { id: `q${this.nextId++}`, text, images, at: Date.now() };
    if (first) this.entries.unshift(entry);
    else this.entries.push(entry);
    this.publish();
    this.drain();
  }

  /** Take a prompt back; false once it has been sent (or never was). */
  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length === before) return false;
    this.publish();
    return true;
  }

  /** Send the next prompt when the session is idle; call on every change. */
  drain() {
    if (this.store.phase === "exited" && this.entries.length > 0) {
      this.entries = [];
      this.publish();
    }
    if (this.sending || this.store.phase !== "idle") return;
    const next = this.entries.shift();
    if (!next) return;
    this.publish();
    this.sending = true;
    this.deliver(next.text, next.images)
      .catch((error: unknown) => {
        this.store.upsertItem({
          id: `queued-${next.id}-failed`,
          type: "notice",
          level: "error",
          text: `A queued prompt was not sent: ${error instanceof Error ? error.message : String(error)}`,
        });
      })
      .finally(() => {
        this.sending = false;
        this.drain();
      });
  }

  private publish() {
    this.store.updateInfo({
      queued: this.entries.length
        ? this.entries.map(({ id, text, images, at }) => ({
            id,
            text,
            ...(images.length
              ? { images: images.map(({ path }) => ({ path })) }
              : {}),
            at,
          }))
        : undefined,
    });
  }
}
