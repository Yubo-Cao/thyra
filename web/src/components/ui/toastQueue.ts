import type { ReactNode } from "react";
import { createStore } from "zustand/vanilla";

// Imperative toast API. This module has no React or HeroUI runtime imports, so
// the store and the always-loaded shell can raise toasts without loading the
// overlay chunk; <ToastRegion /> loads the HeroUI region on the first toast
// and replays everything raised before it arrived.

export type ToastTone = "neutral" | "info" | "success" | "warning" | "danger";

export type ToastContent = {
  /** Headline, already translated with t(). */
  title: ReactNode;
  /** Secondary text or a small block such as command output. */
  description?: ReactNode;
  tone?: ToastTone;
  /** Show a spinner instead of the tone icon; defaults the timeout to 0. */
  loading?: boolean;
  /** One inline action; the toast closes after it runs. */
  action?: { label: string; onAction: () => void };
};

export type ToastOptions = {
  /** Auto-dismiss delay in ms; 0 keeps the toast until dismissed. */
  timeout?: number;
  /** Called once when the toast closes for any reason. */
  onClose?: () => void;
};

/** What the loaded region does with queue operations. */
export interface ToastSink {
  add(content: ToastContent, options: Required<ToastOptions>): string;
  /** Returns the toast's (possibly new) key, or null when it already closed. */
  update(
    key: string,
    content: ToastContent,
    options: Required<ToastOptions>,
  ): string | null;
  close(key: string): void;
}

export const DEFAULT_TOAST_TIMEOUT_MS = 6000;

type Entry = {
  content: ToastContent;
  options: ToastOptions;
  key?: string;
};

function resolvedTimeout(content: ToastContent, options: ToastOptions) {
  if (options.timeout !== undefined) return Math.max(0, options.timeout);
  return content.loading ? 0 : DEFAULT_TOAST_TIMEOUT_MS;
}

/** Buffers toasts until a region attaches, then forwards to its sink. */
export class ToastController {
  private sink: ToastSink | null = null;
  private readonly entries = new Map<string, Entry>();
  private sequence = 0;

  /** True once any toast was raised; the region host mounts from then on. */
  readonly requested = createStore<boolean>()(() => false);

  /** Ids of toasts that are open (or waiting for the region), oldest first. */
  get openIds(): string[] {
    return [...this.entries.keys()];
  }

  show(content: ToastContent, options: ToastOptions = {}): string {
    const id = `toast-${++this.sequence}`;
    const entry: Entry = { content, options };
    this.entries.set(id, entry);
    if (this.sink) this.forward(id, entry);
    this.requested.setState(true, true);
    return id;
  }

  /** Merge new content into an open toast; false if it already closed. */
  update(
    id: string,
    content: Partial<ToastContent>,
    options?: ToastOptions,
  ): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.content = { ...entry.content, ...content };
    if (options) entry.options = { ...entry.options, ...options };
    if (!this.sink || entry.key === undefined) return true;
    const key = this.sink.update(
      entry.key,
      entry.content,
      this.sinkOptions(id, entry),
    );
    if (key === null) {
      this.entries.delete(id);
      return false;
    }
    entry.key = key;
    return true;
  }

  close(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (this.sink && entry.key !== undefined) {
      this.sink.close(entry.key);
      return;
    }
    this.entries.delete(id);
    entry.options.onClose?.();
  }

  clear(): void {
    for (const id of [...this.entries.keys()]) this.close(id);
  }

  /** Called by the loaded region; replays buffered toasts in order. */
  attach(sink: ToastSink): () => void {
    this.sink = sink;
    for (const [id, entry] of this.entries) {
      if (entry.key === undefined) this.forward(id, entry);
    }
    return () => {
      if (this.sink !== sink) return;
      this.sink = null;
      // A later region re-adds whatever is still open.
      for (const entry of this.entries.values()) entry.key = undefined;
    };
  }

  private forward(id: string, entry: Entry) {
    entry.key = this.sink!.add(entry.content, this.sinkOptions(id, entry));
  }

  private sinkOptions(id: string, entry: Entry): Required<ToastOptions> {
    const sink = this.sink;
    return {
      timeout: resolvedTimeout(entry.content, entry.options),
      onClose: () => {
        // Ignore closes from a detached region (it clears its queue on
        // unmount, e.g. StrictMode remounts); the next region re-adds them.
        if (this.sink !== sink || this.entries.get(id) !== entry) return;
        this.entries.delete(id);
        entry.options.onClose?.();
      },
    };
  }
}

/** The app-wide queue rendered by <ToastRegion />. */
export const toastController = new ToastController();

type ToneShortcut = (
  title: ReactNode,
  content?: Omit<ToastContent, "title" | "tone">,
  options?: ToastOptions,
) => string;

const withTone =
  (tone: ToastTone): ToneShortcut =>
  (title, content, options) =>
    toastController.show({ ...content, title, tone }, options);

/**
 * Raise toasts from anywhere, including the store:
 * `const id = toast.show({ title: t("Saving"), loading: true })`, then
 * `toast.update(id, { title: t("Saved"), tone: "success", loading: false }, { timeout: 4000 })`.
 */
export const toast = {
  show: (content: ToastContent, options?: ToastOptions) =>
    toastController.show(content, options),
  info: withTone("info"),
  success: withTone("success"),
  warning: withTone("warning"),
  danger: withTone("danger"),
  update: (
    id: string,
    content: Partial<ToastContent>,
    options?: ToastOptions,
  ) => toastController.update(id, content, options),
  close: (id: string) => toastController.close(id),
  clear: () => toastController.clear(),
};
