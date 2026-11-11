import {
  AGENT_SESSION_HISTORY_LIMIT,
  AGENT_SESSION_ITEM_LIMIT,
  type AgentApprovalOption,
  type AgentFileDiff,
  type AgentItem,
  type AgentPlanEntry,
  type AgentPromptImage,
  type AgentSessionMode,
  type AgentStoredSession,
  type AgentToolKind,
} from "../../../shared/agentSession";
import {
  type AdapterOptions,
  type AgentAdapter,
  AgentActionError,
  displayPath,
  oneLine,
  record,
  remainingInput,
  text,
  withItemTimes,
} from "./adapter";
import {
  type AgentExit,
  type AgentProcess,
  describeAgentExit,
} from "./agent-process";
import { DIFF_PATCH_LIMIT } from "./claude-tools";
import { hunksOf, patchForWholeFile, truncatePatch } from "./diff";
import { isUploadedImagePath } from "../http/image-upload";
import { isAgentSessionId } from "./link";
import type { PromptImage } from "./prompt-images";
import {
  type AgentItemInput,
  type AgentSessionStore,
  type AgentToolItem,
  boundToolOutput,
} from "./store";

/**
 * Codex as an agent session: `codex app-server` speaking JSON-RPC over its
 * pipes, one line per message. The host starts one thread or resumes a
 * stored one, starts a turn per prompt (or steers the running one), answers
 * the server's approval requests and maps thread items to transcript items.
 */

export const CODEX_MODES: AgentSessionMode[] = [
  { id: "untrusted", label: "Ask before commands" },
  { id: "on-request", label: "Ask when needed" },
  { id: "never", label: "Never ask" },
];

const REQUEST_TIMEOUT_MS = 30_000;
const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
/** Turns of a stored thread are read newest first, this many at a time. */
const TURN_PAGE_SIZE = 20;
const TURN_PAGE_LIMIT = 100;

export type CodexLaunch = {
  /** Options `codex app-server` takes itself. */
  serverArgs: string[];
  /** `thread/start` settings the user's arguments choose. */
  thread: {
    model?: string;
    sandbox?: string;
    approvalPolicy?: string;
    cwd?: string;
  };
  /** `resume <id>` or `resume --last`: the stored thread to continue. */
  resume?: { id: string } | { last: true };
};

/**
 * `thyra agent codex` takes the `codex` options that have an app-server
 * counterpart, and `resume [<id> | --last]` among them; anything else is
 * refused rather than silently dropped. A bare `resume` (the terminal UI's
 * picker) starts a new thread: the page offers the list instead.
 */
export function parseCodexArgs(args: string[]): CodexLaunch {
  const launch: CodexLaunch = { serverArgs: [], thread: {} };
  const queue = [...args];
  let resuming = false;
  while (queue.length > 0) {
    const arg = queue.shift()!;
    if (arg === "resume" && !resuming) {
      resuming = true;
      continue;
    }
    if (resuming && !launch.resume) {
      if (arg === "--last") {
        launch.resume = { last: true };
        continue;
      }
      if (!arg.startsWith("-")) {
        if (!isAgentSessionId(arg)) throw new Error(`not a thread ID: ${arg}`);
        launch.resume = { id: arg };
        continue;
      }
    }
    const [flag, inline] = arg.startsWith("--")
      ? (arg.split(/=(.*)/s, 2) as [string, string | undefined])
      : [arg, undefined];
    const value = () => {
      const next = inline ?? queue.shift();
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case "-m":
      case "--model":
        launch.thread.model = value();
        break;
      case "-s":
      case "--sandbox": {
        const mode = value();
        if (!SANDBOX_MODES.includes(mode))
          throw new Error(`unknown sandbox mode: ${mode}`);
        launch.thread.sandbox = mode;
        break;
      }
      case "-a":
      case "--ask-for-approval": {
        const policy = value();
        if (!CODEX_MODES.some((mode) => mode.id === policy))
          throw new Error(`unknown approval policy: ${policy}`);
        launch.thread.approvalPolicy = policy;
        break;
      }
      case "--dangerously-bypass-approvals-and-sandbox":
      case "--yolo":
        launch.thread.approvalPolicy = "never";
        launch.thread.sandbox = "danger-full-access";
        break;
      case "-C":
      case "--cd":
        launch.thread.cwd = value();
        break;
      case "-c":
      case "--config":
        launch.serverArgs.push("-c", value());
        break;
      case "--enable":
      case "--disable":
        launch.serverArgs.push(flag, value());
        break;
      case "--strict-config":
        launch.serverArgs.push(flag);
        break;
      default:
        throw new Error(
          `thyra agent codex does not support the argument ${arg} (supported: -m, -s, -a, -C, -c, --enable, --disable, --strict-config, --yolo, resume [<id> | --last])`,
        );
    }
  }
  return launch;
}

/** `cat x` from `/bin/bash -lc 'cat x'`: the command the model wrote. */
export function unwrapShellCommand(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/.exec(
    command.trim(),
  );
  if (!match) return command;
  const script = match[1]!.trim();
  if (/^'[^']*'$/.test(script)) return script.slice(1, -1);
  if (/^"[^"\\$`]*"$/.test(script)) return script.slice(1, -1);
  return script;
}

function fileChangeDiffs(changes: unknown): AgentFileDiff[] {
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((value): AgentFileDiff[] => {
    const change = record(value);
    const path = text(change?.path);
    if (!change || !path) return [];
    const kind = record(change.kind)?.type;
    const diff = text(change.diff) ?? "";
    // Codex gives a new or deleted file's content, and hunks for an update.
    const patch =
      kind === "add" && !diff.startsWith("@@")
        ? patchForWholeFile(diff, "+")
        : kind === "delete" && !diff.startsWith("@@")
          ? patchForWholeFile(diff, "-")
          : hunksOf(diff);
    return [{ path, patch: truncatePatch(patch, DIFF_PATCH_LIMIT).patch }];
  });
}

function toolStatus(
  status: unknown,
  exitCode?: unknown,
): AgentToolItem["status"] {
  if (status === "inProgress") return "running";
  if (status === "declined") return "denied";
  if (status === "failed") return "failed";
  return typeof exitCode === "number" && exitCode !== 0 ? "failed" : "done";
}

function mcpResultText(result: unknown, error: unknown): string | undefined {
  const message = text(record(error)?.message);
  if (message) return message;
  const content = record(result)?.content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.map((value) => {
    const block = record(value);
    return block?.type === "text" ? (text(block.text) ?? "") : "";
  });
  return parts.filter(Boolean).join("\n") || undefined;
}

/**
 * A thread item as a transcript item; null for items the transcript does not
 * show (the user's own prompt, hook prompts, sub-agent bookkeeping).
 */
export function codexItem(
  item: Record<string, unknown>,
  cwd: string,
): AgentItemInput | null {
  const id = text(item.id);
  if (!id) return null;
  const tool = (
    kind: AgentToolKind,
    name: string,
    title: string,
    status: AgentToolItem["status"],
    extra: Partial<AgentToolItem> = {},
  ): AgentItemInput => ({
    id,
    type: "tool",
    kind,
    name,
    title: title || name,
    status,
    ...extra,
  });
  switch (item.type) {
    case "agentMessage":
    case "plan": {
      const body = text(item.text) ?? "";
      return body.trim()
        ? { id, type: "assistant", text: body, streaming: false }
        : null;
    }
    case "reasoning": {
      const parts = [item.summary, item.content].flatMap((value) =>
        Array.isArray(value)
          ? value.filter((part) => typeof part === "string")
          : [],
      );
      const body = parts.join("\n\n");
      return body.trim()
        ? { id, type: "thinking", text: body, streaming: false }
        : null;
    }
    case "commandExecution": {
      const command = unwrapShellCommand(text(item.command) ?? "");
      const actions = Array.isArray(item.commandActions)
        ? item.commandActions.map((action) => record(action)?.type)
        : [];
      const kind: AgentToolKind =
        actions.length > 0 && actions.every((type) => type === "read")
          ? "read"
          : actions.length > 0 &&
              actions.every((type) => type === "search" || type === "listFiles")
            ? "search"
            : "command";
      const output = text(item.aggregatedOutput);
      return tool(
        kind,
        "shell",
        oneLine(command),
        toolStatus(item.status, item.exitCode),
        {
          ...(command ? { command } : {}),
          ...(output ? boundToolOutput(output) : {}),
        },
      );
    }
    case "fileChange": {
      const diffs = fileChangeDiffs(item.changes);
      const first = diffs[0] ? displayPath(diffs[0].path, cwd) : "";
      return tool(
        "edit",
        "apply_patch",
        diffs.length > 1 ? `${first} (+${diffs.length - 1} more)` : first,
        toolStatus(item.status),
        diffs.length > 0 ? { diffs } : {},
      );
    }
    case "mcpToolCall": {
      const output = mcpResultText(item.result, item.error);
      return tool(
        "other",
        `${text(item.server) ?? "mcp"}.${text(item.tool) ?? "tool"}`,
        `${text(item.server) ?? "mcp"}: ${text(item.tool) ?? "tool"}`,
        toolStatus(item.status),
        {
          input: remainingInput(record(item.arguments) ?? {}, []),
          ...(output ? boundToolOutput(output) : {}),
        },
      );
    }
    case "dynamicToolCall":
      return tool(
        "other",
        text(item.tool) ?? "tool",
        text(item.tool) ?? "tool",
        item.success === false ? "failed" : toolStatus(item.status),
        { input: remainingInput(record(item.arguments) ?? {}, []) },
      );
    case "collabAgentToolCall":
      return tool(
        "task",
        text(item.tool) ?? "agent",
        oneLine(text(item.prompt) ?? text(item.tool) ?? "agent"),
        toolStatus(item.status),
      );
    case "webSearch": {
      const action = record(item.action);
      return tool(
        action?.type === "openPage" ? "fetch" : "search",
        "web_search",
        oneLine(text(item.query) || text(action?.url) || "web search"),
        "done",
      );
    }
    case "imageView":
      return tool(
        "read",
        "view_image",
        displayPath(text(item.path) ?? "", cwd),
        "done",
      );
    case "contextCompaction":
      return {
        id,
        type: "notice",
        level: "info",
        text: "Conversation compacted.",
      };
    case "enteredReviewMode":
    case "exitedReviewMode":
      return {
        id,
        type: "notice",
        level: "info",
        text:
          item.type === "enteredReviewMode"
            ? "Review started."
            : "Review finished.",
      };
    default:
      return null;
  }
}

/** The text of a `userMessage` item's content. */
function promptText(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .map((value) => text(record(value)?.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

/**
 * The images of a `userMessage` item's content that a page attached: local
 * files at paths the upload endpoint gives. Other images stay unnamed.
 */
function promptImages(content: unknown): { images?: AgentPromptImage[] } {
  const images = (Array.isArray(content) ? content : []).flatMap((value) => {
    const part = record(value);
    return part?.type === "localImage" && isUploadedImagePath(part.path)
      ? [{ path: part.path }]
      : [];
  });
  return images.length > 0 ? { images } : {};
}

/** What the end of a turn adds to the transcript, when it did not just end. */
function turnEndNotice(
  turn: Record<string, unknown>,
  denied: boolean,
): { level: "info" | "error"; text: string } | null {
  if (turn.status === "failed")
    return {
      level: "error",
      text: text(record(turn.error)?.message) ?? "The turn failed.",
    };
  // A turn stopped by a denied approval shows the denial, not an interruption.
  return turn.status === "interrupted" && !denied
    ? { level: "info", text: "Interrupted." }
    : null;
}

/**
 * The turns of a stored thread as transcript items, oldest first. Each item
 * maps as its notification did when the turn was live and keeps the time it
 * started at. Nothing of a stored turn is still under way: a call without
 * an outcome takes its turn's.
 */
export function codexThreadItems(turns: unknown[], cwd: string): AgentItem[] {
  const items: AgentItem[] = [];
  let at = 0;
  for (const value of turns) {
    const turn = record(value);
    if (!turn) continue;
    if (typeof turn.startedAt === "number")
      at = Math.max(at, turn.startedAt * 1000);
    let denied = false;
    for (const entry of Array.isArray(turn.items) ? turn.items : []) {
      const item = record(entry);
      const id = text(item?.id);
      if (!item || !id) continue;
      if (typeof item.startedAtMs === "number") at = item.startedAtMs;
      if (item.status === "declined") denied = true;
      if (item.type === "userMessage") {
        const body = promptText(item.content);
        const attached = promptImages(item.content);
        if (body.trim() || attached.images)
          items.push({ id, type: "user", text: body, ...attached, at });
        continue;
      }
      const mapped = codexItem(item, cwd);
      if (!mapped) continue;
      const open =
        mapped.type === "tool" &&
        (mapped.status === "running" || mapped.status === "pending");
      items.push({
        ...mapped,
        ...(open
          ? { status: turn.status === "completed" ? "done" : "failed" }
          : {}),
        at,
      } as AgentItem);
    }
    const notice = turnEndNotice(turn, denied);
    if (typeof turn.completedAt === "number")
      at = Math.max(at, turn.completedAt * 1000);
    if (notice)
      items.push({
        id: `${text(turn.id) ?? "turn"}:end`,
        type: "notice",
        ...notice,
        at,
      });
  }
  return withItemTimes(items);
}

type PendingApproval = {
  requestId: string | number;
  method: string;
  itemId?: string;
  /** What to answer for each option of the approval. */
  results: Map<string, { result: unknown; denied?: boolean }>;
};

export class CodexAdapter implements AgentAdapter {
  private readonly store: AgentSessionStore;
  private readonly launch: CodexLaunch;
  private process: AgentProcess | null = null;
  private stopping = false;
  private nextRequestId = 1;
  private nextLocalId = 1;
  private readonly requests = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private threadId = "";
  private turnId: string | null = null;
  /** Sends run one after another: a steer needs the turn the last one began. */
  private sending: Promise<void> = Promise.resolve();
  /** Prompts this host sent that Codex has not listed as items yet. */
  private readonly ownPrompts: string[] = [];
  /** The turn is ending because an approval was denied, not interrupted. */
  private denying = false;
  /** Prompts accepted from pages that Codex has not taken yet. */
  private undelivered = 0;
  /** An approval policy chosen with `setMode`, for the next turn. */
  private nextPolicy: string | null = null;
  private readonly approvals = new Map<string, PendingApproval>();
  /** Items with streamed text that has not been completed. */
  private readonly streaming = new Set<string>();
  private readonly openTools = new Set<string>();
  /** A stored thread is being resumed; prompts wait for it to be settled. */
  private resuming = false;

  constructor(private readonly options: AdapterOptions) {
    this.store = options.store;
    this.launch = parseCodexArgs(options.args);
  }

  start() {
    try {
      this.process = this.options.spawn({
        argv: ["codex", "app-server", ...this.launch.serverArgs],
        cwd: this.options.cwd,
        env: this.options.env,
        onLine: (line) => this.handleLine(line),
        onExit: (exit) => this.handleExit(exit),
      });
    } catch (error) {
      this.store.setPhase(
        "exited",
        `could not start codex: ${(error as Error).message}`,
      );
      this.options.onExit(this.store.info.error);
      return;
    }
    void this.openThread().catch((error) => {
      if (this.stopping || this.store.phase === "exited") return;
      // Without a thread there is nothing to talk to; end the process and
      // let its exit carry the reason.
      this.failure = `codex did not start a thread: ${(error as Error).message}`;
      this.process?.kill("SIGTERM");
    });
  }

  private failure: string | null = null;

  private async openThread() {
    await this.request("initialize", {
      clientInfo: { name: "thyra", title: "Thyra", version: "1" },
      capabilities: null,
    });
    this.write({ method: "initialized" });
    const cwd = this.launch.thread.cwd ?? this.options.cwd;
    const resume = this.launch.resume;
    let id = resume && "id" in resume ? resume.id : undefined;
    let note: string | null = null;
    if (resume && "last" in resume) {
      id = (await this.storedThreads(cwd, 1))[0]?.id;
      if (!id)
        note = "No thread is stored for this directory; this is a new one.";
    }
    if (id) {
      // The thread resumes with or without its earlier messages.
      const turns = await this.storedTurns(id).catch((error) => {
        note = `The earlier messages of ${id} could not be read (${(error as Error).message}).`;
        return [];
      });
      await this.resumeThread(id, turns);
    } else {
      this.adoptThread(
        await this.request("thread/start", { cwd, ...this.threadSettings() }),
      );
    }
    if (note) this.notice("info", note);
    if (this.store.phase === "starting") this.store.setPhase("idle");
  }

  /** What the user's arguments choose for a thread, started or resumed. */
  private threadSettings(): Record<string, unknown> {
    const { model, sandbox, approvalPolicy } = this.launch.thread;
    return {
      ...(model ? { model } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
    };
  }

  /** The session is in the thread a `thread/start` or `thread/resume` answered. */
  private adoptThread(opened: Record<string, unknown>) {
    const threadId = text(record(opened.thread)?.id);
    if (!threadId) throw new Error("no thread ID");
    this.threadId = threadId;
    const policy = text(opened.approvalPolicy);
    this.store.updateInfo({
      agent_session_id: threadId,
      cwd: text(opened.cwd) ?? this.launch.thread.cwd ?? this.options.cwd,
      modes: CODEX_MODES,
      ...(text(opened.model) ? { model: text(opened.model) } : {}),
      ...(policy ? { mode: policy } : {}),
    });
  }

  /** Stored threads of a directory, newest first, from Codex's own index. */
  private async storedThreads(
    cwd: string,
    limit: number,
  ): Promise<AgentStoredSession[]> {
    const listed = await this.request("thread/list", {
      cwd,
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      // The index answers at once; repairing it from every rollout file
      // takes many seconds on a long history.
      useStateDbOnly: true,
    });
    return (Array.isArray(listed.data) ? listed.data : []).flatMap(
      (value): AgentStoredSession[] => {
        const thread = record(value);
        const id = text(thread?.id);
        // A thread without a prompt was never a conversation.
        const title = text(thread?.name) || text(thread?.preview) || "";
        if (!thread || !id || !title.trim()) return [];
        return [
          {
            id,
            title: oneLine(title, 200),
            updated_at:
              (typeof thread.updatedAt === "number" ? thread.updatedAt : 0) *
              1000,
          },
        ];
      },
    );
  }

  async history(): Promise<AgentStoredSession[]> {
    this.requireThread();
    const threads = await this.storedThreads(
      this.store.info.cwd,
      AGENT_SESSION_HISTORY_LIMIT + 1,
    );
    return threads
      .filter((thread) => thread.id !== this.threadId)
      .slice(0, AGENT_SESSION_HISTORY_LIMIT);
  }

  /**
   * The turns of a stored thread, oldest first: as many of the newest as
   * the transcript can hold, read a page at a time.
   */
  private async storedTurns(id: string): Promise<unknown[]> {
    const pages: unknown[][] = [];
    let cursor: string | undefined;
    let items = 0;
    for (let page = 0; page < TURN_PAGE_LIMIT; page++) {
      const listed = await this.request("thread/turns/list", {
        threadId: id,
        limit: TURN_PAGE_SIZE,
        sortDirection: "desc",
        itemsView: "full",
        ...(cursor ? { cursor } : {}),
      });
      const turns = Array.isArray(listed.data) ? listed.data : [];
      pages.push(turns);
      for (const turn of turns) {
        const held = record(turn)?.items;
        items += Array.isArray(held) ? held.length : 0;
      }
      cursor = text(listed.nextCursor);
      if (!cursor || turns.length === 0 || items >= AGENT_SESSION_ITEM_LIMIT)
        break;
    }
    return pages.flat().reverse();
  }

  /** Continue a stored thread on this server, showing these turns of it. */
  private async resumeThread(id: string, turns: unknown[]) {
    const resumed = await this.request("thread/resume", {
      threadId: id,
      excludeTurns: true,
      // Only a directory the user named moves the thread; else it keeps its own.
      ...(this.launch.thread.cwd ? { cwd: this.launch.thread.cwd } : {}),
      ...this.threadSettings(),
    });
    if (!text(record(resumed.thread)?.id)) throw new Error("no thread ID");
    const left = this.threadId;
    this.turnId = null;
    this.nextPolicy = null;
    this.denying = false;
    this.ownPrompts.length = 0;
    this.approvals.clear();
    this.streaming.clear();
    this.openTools.clear();
    this.store.resetItems(
      codexThreadItems(turns, text(resumed.cwd) ?? this.store.info.cwd),
    );
    this.store.updateInfo({ usage: undefined });
    this.adoptThread(resumed);
    // Codex gives a thread one writer and keeps a thread somebody follows
    // loaded: let go of the one the session left, so other clients can
    // open it again.
    if (left && left !== this.threadId)
      void this.request("thread/unsubscribe", { threadId: left }).catch(
        () => undefined,
      );
  }

  async resume(id: string) {
    this.requireThread();
    if (this.resuming)
      throw new AgentActionError("a conversation is already being resumed");
    if (this.store.phase === "running" || this.turnId || this.undelivered > 0)
      throw new AgentActionError(
        "a turn is running; wait for it or interrupt it first",
      );
    this.resuming = true;
    try {
      await this.resumeThread(id, await this.storedTurns(id));
    } finally {
      this.resuming = false;
    }
  }

  async send(prompt: string, images: PromptImage[] = []): Promise<void> {
    this.requireThread();
    if (this.resuming)
      throw new AgentActionError(
        "a conversation is being resumed; send the prompt again in a moment",
      );
    this.store.upsertItem({
      id: `user-${this.nextLocalId++}`,
      type: "user",
      text: prompt,
      ...(images.length > 0
        ? { images: images.map(({ path }) => ({ path })) }
        : {}),
    });
    this.ownPrompts.push(prompt);
    this.undelivered += 1;
    this.store.setPhase("running");
    const sent = this.sending.then(() => this.deliver(prompt, images));
    this.sending = sent.catch(() => undefined);
    return sent;
  }

  private async deliver(prompt: string, images: PromptImage[]) {
    // Codex reads an attached image from its file, and shrinks it itself.
    const input = [
      ...(prompt.trim() || images.length === 0
        ? [{ type: "text", text: prompt, text_elements: [] }]
        : []),
      ...images.map(({ path }) => ({ type: "localImage", path })),
    ];
    try {
      if (this.turnId) {
        try {
          await this.request("turn/steer", {
            threadId: this.threadId,
            expectedTurnId: this.turnId,
            input,
          });
          return;
        } catch {
          // The turn ended first (or moved on): the prompt starts the next.
        }
      }
      const policy = this.nextPolicy;
      const started = await this.request("turn/start", {
        threadId: this.threadId,
        input,
        ...(policy ? { approvalPolicy: policy } : {}),
      });
      if (policy === this.nextPolicy) this.nextPolicy = null;
      this.turnId ??= text(record(started.turn)?.id) ?? null;
    } catch (error) {
      const index = this.ownPrompts.indexOf(prompt);
      if (index >= 0) this.ownPrompts.splice(index, 1);
      this.notice(
        "error",
        `The prompt was not delivered: ${(error as Error).message}`,
      );
      throw error;
    } finally {
      this.undelivered -= 1;
      if (!this.turnId && this.undelivered === 0) this.settle();
    }
  }

  /** Idle once no turn runs and no prompt is on its way to one. */
  private settle() {
    if (this.store.phase === "running") this.store.setPhase("idle");
  }

  async interrupt() {
    if (this.store.phase !== "running" || !this.turnId) return;
    await this.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.turnId,
    });
  }

  async approve(approvalId: string, optionId: string) {
    this.requireThread();
    const pending = this.approvals.get(approvalId);
    if (!pending)
      throw new AgentActionError("this approval is no longer pending");
    const answer = pending.results.get(optionId);
    if (!answer) throw new AgentActionError("unknown approval option");
    this.approvals.delete(approvalId);
    this.write({ id: pending.requestId, result: answer.result });
    this.store.resolveApproval(approvalId);
    this.markTool(pending.itemId, answer.denied ? "denied" : "running");
    if (answer.denied) this.denying = true;
  }

  async setMode(mode: string) {
    this.requireThread();
    if (!CODEX_MODES.some((entry) => entry.id === mode))
      throw new AgentActionError(`unknown mode: ${mode}`);
    // Codex takes a new approval policy with a turn; it holds from the next.
    this.nextPolicy = mode;
    this.store.updateInfo({ mode });
  }

  stop(force = false) {
    this.stopping = true;
    this.process?.kill(force ? "SIGKILL" : "SIGTERM");
  }

  private requireThread() {
    if (!this.process || this.store.phase === "exited")
      throw new AgentActionError("the agent has exited");
    if (!this.threadId)
      throw new AgentActionError("the agent is still starting");
  }

  private write(message: Record<string, unknown>) {
    this.process?.write(JSON.stringify(message));
  }

  private request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new AgentActionError("the agent did not answer in time"));
      }, REQUEST_TIMEOUT_MS);
      this.requests.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  private handleLine(line: string) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const message = record(value);
    if (!message) return;
    const method = text(message.method);
    const hasId =
      typeof message.id === "number" || typeof message.id === "string";
    if (!method) {
      if (typeof message.id === "number") this.handleResponse(message);
      return;
    }
    const params = record(message.params) ?? {};
    if (hasId)
      return this.handleServerRequest(
        message.id as string | number,
        method,
        params,
      );
    // Other threads are sub-agents; their work shows through the parent's items.
    const threadId = text(params.threadId);
    if (threadId && this.threadId && threadId !== this.threadId) return;
    this.handleNotification(method, params);
  }

  private handleResponse(message: Record<string, unknown>) {
    const waiting = this.requests.get(message.id as number);
    if (!waiting) return;
    this.requests.delete(message.id as number);
    clearTimeout(waiting.timer);
    const error = record(message.error);
    if (error)
      waiting.reject(
        new AgentActionError(text(error.message) ?? "the agent refused"),
      );
    else waiting.resolve(record(message.result) ?? {});
  }

  private handleNotification(method: string, params: Record<string, unknown>) {
    switch (method) {
      case "turn/started": {
        this.turnId = text(record(params.turn)?.id) ?? this.turnId;
        this.store.setPhase("running");
        return;
      }
      case "turn/completed":
        return this.finishTurn(record(params.turn) ?? {});
      case "item/started":
      case "item/completed":
        return this.handleItem(
          record(params.item) ?? {},
          method === "item/completed",
        );
      case "item/agentMessage/delta":
        return this.streamText(params, "assistant");
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return this.streamText(params, "thinking");
      case "item/reasoning/summaryPartAdded": {
        const id = text(params.itemId);
        if (id && this.store.item(id)) this.store.appendDelta(id, "\n\n");
        return;
      }
      case "turn/plan/updated": {
        const plan = Array.isArray(params.plan) ? params.plan : [];
        const entries = plan.flatMap((value): AgentPlanEntry[] => {
          const step = record(value);
          const body = text(step?.step);
          if (!body) return [];
          return [
            {
              text: body,
              status:
                step?.status === "completed"
                  ? "done"
                  : step?.status === "inProgress"
                    ? "in_progress"
                    : "pending",
            },
          ];
        });
        this.store.upsertItem({
          id: `plan-${text(params.turnId) ?? this.turnId ?? "turn"}`,
          type: "plan",
          entries,
        });
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = record(params.tokenUsage);
        const last = record(usage?.last);
        const total = record(usage?.total);
        this.store.updateInfo({
          usage: {
            ...(typeof last?.totalTokens === "number"
              ? { context_tokens: last.totalTokens }
              : {}),
            ...(typeof usage?.modelContextWindow === "number"
              ? { context_window: usage.modelContextWindow }
              : {}),
            ...(typeof total?.outputTokens === "number"
              ? { output_tokens: total.outputTokens }
              : {}),
          },
        });
        return;
      }
      case "thread/settings/updated": {
        const settings = record(params.threadSettings);
        const policy = text(settings?.approvalPolicy);
        this.store.updateInfo({
          ...(text(settings?.model) ? { model: text(settings?.model) } : {}),
          ...(policy && !this.nextPolicy ? { mode: policy } : {}),
        });
        return;
      }
      case "model/rerouted": {
        const model = text(params.toModel);
        if (model) this.store.updateInfo({ model });
        return;
      }
      case "serverRequest/resolved": {
        // Answered elsewhere or withdrawn (an interrupted turn).
        const id = `codex-${String(params.requestId)}`;
        const pending = this.approvals.get(id);
        if (!pending) return;
        this.approvals.delete(id);
        this.store.resolveApproval(id);
        return;
      }
      case "error": {
        const message = text(record(params.error)?.message);
        if (!message) return;
        // One notice per turn while Codex retries, replaced by each attempt.
        if (params.willRetry === true)
          this.store.upsertItem({
            id: `retry-${text(params.turnId) ?? "turn"}`,
            type: "notice",
            level: "info",
            text: `${message} Retrying.`,
          });
        else this.notice("error", message);
        return;
      }
    }
  }

  private streamText(
    params: Record<string, unknown>,
    type: "assistant" | "thinking",
  ) {
    const id = text(params.itemId);
    const delta = text(params.delta);
    if (!id || !delta) return;
    if (this.store.item(id)) {
      this.store.appendDelta(id, delta);
      return;
    }
    // A message cut short by a steer is never completed: it ends here.
    this.finishStreaming();
    this.streaming.add(id);
    this.store.upsertItem({ id, type, text: delta, streaming: true });
  }

  private finishStreaming(only?: string) {
    for (const id of only ? [only] : [...this.streaming]) {
      this.streaming.delete(id);
      const item = this.store.item(id);
      if (item?.type === "assistant" || item?.type === "thinking") {
        this.store.upsertItem({ ...item, streaming: false });
      }
    }
  }

  private handleItem(item: Record<string, unknown>, completed: boolean) {
    const id = text(item.id);
    if (!id) return;
    if (item.type === "userMessage") {
      if (!completed) this.showForeignPrompt(id, item.content);
      return;
    }
    const mapped = codexItem(item, this.options.cwd);
    if (!mapped) {
      if (completed) this.finishStreaming(id);
      return;
    }
    if (mapped.type === "assistant" || mapped.type === "thinking") {
      // Streamed text is complete only with `item/completed`.
      if (!completed) return;
      this.streaming.delete(id);
      this.store.upsertItem(mapped);
      return;
    }
    if (mapped.type === "tool") {
      if (completed) this.openTools.delete(id);
      else this.openTools.add(id);
      const waiting = [...this.approvals.values()].some(
        (approval) => approval.itemId === id,
      );
      this.store.upsertItem(
        waiting && !completed ? { ...mapped, status: "pending" } : mapped,
      );
      return;
    }
    this.store.upsertItem(mapped);
  }

  /** A prompt that did not come from this host (another client, a hook). */
  private showForeignPrompt(id: string, content: unknown) {
    const body = promptText(content);
    const own = this.ownPrompts.indexOf(body);
    if (own >= 0) {
      this.ownPrompts.splice(own, 1);
      return;
    }
    const attached = promptImages(content);
    if (body.trim() || attached.images)
      this.store.upsertItem({ id, type: "user", text: body, ...attached });
  }

  private finishTurn(turn: Record<string, unknown>) {
    this.closeOpenItems(turn.status === "completed" ? "done" : "failed");
    const notice = turnEndNotice(turn, this.denying);
    if (notice) this.notice(notice.level, notice.text);
    this.denying = false;
    this.turnId = null;
    if (this.undelivered === 0) this.settle();
  }

  /** End streaming items, open approvals and tool calls a turn left behind. */
  private closeOpenItems(toolStatus: AgentToolItem["status"]) {
    this.finishStreaming();
    for (const id of [...this.approvals.keys()]) {
      this.approvals.delete(id);
      this.store.resolveApproval(id);
    }
    for (const id of this.openTools) {
      const item = this.store.item(id);
      if (item?.type !== "tool") continue;
      if (item.status === "pending" || item.status === "running")
        this.markTool(id, toolStatus);
    }
    this.openTools.clear();
  }

  private markTool(id: string | undefined, status: AgentToolItem["status"]) {
    const item = id ? this.store.item(id) : undefined;
    if (item?.type !== "tool") return;
    this.store.upsertItem({ ...item, status });
  }

  private handleServerRequest(
    requestId: string | number,
    method: string,
    params: Record<string, unknown>,
  ) {
    const id = `codex-${String(requestId)}`;
    const itemId = text(params.itemId);
    const reason = text(params.reason);
    const results: PendingApproval["results"] = new Map();
    const options: AgentApprovalOption[] = [];
    const offer = (
      option: AgentApprovalOption,
      result: unknown,
      denied = false,
    ) => {
      if (results.has(option.id)) return;
      options.push(option);
      results.set(option.id, { result, denied });
    };
    let title: string;
    let detail = reason;
    if (method === "item/commandExecution/requestApproval") {
      const command = unwrapShellCommand(text(params.command) ?? "");
      title = command ? `Run: ${oneLine(command, 300)}` : "Run a command";
      const cwd = text(params.cwd);
      if (cwd && cwd !== this.store.info.cwd)
        detail = [reason, `In ${cwd}`].filter(Boolean).join("\n");
      const decisions = Array.isArray(params.availableDecisions)
        ? params.availableDecisions
        : ["accept", "acceptForSession", "cancel"];
      for (const decision of decisions) {
        const named = record(decision);
        if (decision === "accept")
          offer({ id: "allow", label: "Allow", kind: "allow" }, { decision });
        else if (decision === "acceptForSession")
          offer(
            {
              id: "allow_session",
              label: "Allow for this session",
              kind: "allow_always",
            },
            { decision },
          );
        else if (named?.acceptWithExecpolicyAmendment) {
          const amendment = record(named.acceptWithExecpolicyAmendment);
          const words = Array.isArray(amendment?.execpolicy_amendment)
            ? amendment.execpolicy_amendment.join(" ")
            : "";
          offer(
            {
              id: "allow_always",
              label: oneLine(`Always allow ${words || "this command"}`, 120),
              kind: "allow_always",
            },
            { decision },
          );
        } else if (decision === "cancel" || decision === "decline")
          offer(
            { id: "deny", label: "Deny", kind: "deny" },
            { decision },
            true,
          );
      }
    } else if (method === "item/fileChange/requestApproval") {
      const item = itemId ? this.store.item(itemId) : undefined;
      title =
        item?.type === "tool" && item.title
          ? `Edit: ${item.title}`
          : "Apply file changes";
      const root = text(params.grantRoot);
      if (root)
        detail = [reason, `Allows writing under ${root}`]
          .filter(Boolean)
          .join("\n");
      offer(
        { id: "allow", label: "Allow", kind: "allow" },
        { decision: "accept" },
      );
      offer(
        {
          id: "allow_session",
          label: "Allow for this session",
          kind: "allow_always",
        },
        { decision: "acceptForSession" },
      );
      offer(
        { id: "deny", label: "Deny", kind: "deny" },
        { decision: "cancel" },
        true,
      );
    } else if (method === "item/permissions/requestApproval") {
      title = "Grant additional permissions";
      const requested = record(params.permissions) ?? {};
      const granted = Object.fromEntries(
        Object.entries(requested).filter(([, value]) => value !== null),
      );
      detail = [reason, JSON.stringify(granted, null, 2)]
        .filter(Boolean)
        .join("\n");
      offer(
        { id: "allow", label: "Allow for this turn", kind: "allow" },
        { permissions: granted, scope: "turn" },
      );
      offer(
        {
          id: "allow_session",
          label: "Allow for this session",
          kind: "allow_always",
        },
        { permissions: granted, scope: "session" },
      );
      // Granting nothing lets the turn go on without the permissions.
      offer(
        { id: "deny", label: "Deny", kind: "deny" },
        { permissions: {}, scope: "turn" },
      );
    } else if (method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      const question = record(questions[0]);
      const choices = Array.isArray(question?.options) ? question.options : [];
      const questionId = text(question?.id);
      if (questions.length !== 1 || !questionId || choices.length === 0) {
        // Free-form and multi-question input has no place to be typed here.
        this.write({ id: requestId, result: { answers: {} } });
        return;
      }
      title = text(question?.question) ?? text(question?.header) ?? "Question";
      const details: string[] = [];
      choices.forEach((value, index) => {
        const choice = record(value);
        const label = text(choice?.label);
        if (!label) return;
        if (text(choice?.description))
          details.push(`${label}: ${text(choice?.description)}`);
        offer(
          {
            id: `answer-${index + 1}`,
            label: oneLine(label, 120),
            kind: "allow",
          },
          { answers: { [questionId]: { answers: [label] } } },
        );
      });
      detail = details.join("\n") || undefined;
      offer({ id: "deny", label: "Skip", kind: "deny" }, { answers: {} });
    } else if (method === "mcpServer/elicitation/request") {
      this.write({
        id: requestId,
        result: { action: "decline", content: null, _meta: null },
      });
      return;
    } else {
      this.write({
        id: requestId,
        error: { code: -32601, message: `${method} is not supported` },
      });
      return;
    }
    if (options.length === 0) {
      this.write({
        id: requestId,
        error: { code: -32603, message: "no decision can be offered" },
      });
      return;
    }
    this.approvals.set(id, { requestId, method, itemId, results });
    const item = itemId ? this.store.item(itemId) : undefined;
    if (item?.type === "tool" && item.status === "running")
      this.markTool(itemId, "pending");
    this.store.addApproval({
      id,
      ...(item?.type === "tool" ? { item_id: item.id } : {}),
      title: oneLine(title, 400),
      ...(detail ? { detail: detail.slice(0, 8000) } : {}),
      options,
    });
  }

  private notice(level: "info" | "error", content: string) {
    this.store.upsertItem({
      id: `notice-${this.nextLocalId++}`,
      type: "notice",
      level,
      text: content,
    });
  }

  private handleExit(exit: AgentExit) {
    this.process = null;
    for (const [id, waiting] of this.requests) {
      clearTimeout(waiting.timer);
      waiting.reject(new AgentActionError("the agent has exited"));
      this.requests.delete(id);
    }
    this.closeOpenItems("failed");
    this.turnId = null;
    const error = this.stopping
      ? undefined
      : (this.failure ??
        (exit.code === 0 ? undefined : describeAgentExit("codex", exit)));
    this.store.setPhase("exited", error);
    this.options.onExit(error);
  }
}
