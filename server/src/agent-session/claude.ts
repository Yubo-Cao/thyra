import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AgentApproval,
  AgentApprovalOption,
  AgentItem,
  AgentSessionMode,
  AgentSessionModel,
  AgentSessionUsage,
  AgentStoredSession,
} from "../../../shared/agentSession";
import {
  type AdapterOptions,
  type AgentAdapter,
  AgentActionError,
  oneLine,
  record,
  text,
  withItemTimes,
} from "./adapter";
import {
  type AgentExit,
  type AgentProcess,
  describeAgentExit,
} from "./agent-process";
import {
  claudeProjectDir,
  isTranscriptEntry,
  listClaudeSessions,
  readClaudeConversation,
  type StoredEntry,
  storedCommand,
  storedPrompt,
} from "./claude-stored";
import {
  describeClaudeTool,
  isTodoTool,
  planEntries,
  resultDiffs,
  toolResultText,
} from "./claude-tools";
import { isAgentSessionId } from "./link";
import { type PromptImage, readPromptImage } from "./prompt-images";
import {
  AgentSessionStore,
  type AgentToolItem,
  boundToolOutput,
} from "./store";

/**
 * Claude Code as an agent session: `claude -p` with stream-json on both
 * pipes. Prompts go in as user messages; text streams back as partial
 * message events; permission prompts, interrupts and mode changes use the
 * control protocol (`control_request` / `control_response` lines) that
 * `--permission-prompt-tool stdio` enables.
 */

/**
 * Claude Code's permission modes. Claude runs its tools without a sandbox in
 * every mode; the modes differ in what it asks first. `bypassPermissions`
 * (`--dangerously-skip-permissions`) asks nothing: full access.
 */
export const CLAUDE_MODES: AgentSessionMode[] = [
  { id: "default", label: "Ask before edits and commands" },
  { id: "acceptEdits", label: "Accept edits, ask before commands" },
  { id: "plan", label: "Plan (read only)" },
  { id: "bypassPermissions", label: "Full access (bypass permissions)" },
];

const CONTROL_TIMEOUT_MS = 15_000;
/** The CLI answers `initialize` in a second or two; past this, prompts go anyway. */
const READY_TIMEOUT_MS = 20_000;
/** An interrupted turn normally ends at once; past this the session is idle. */
const INTERRUPT_SETTLE_MS = 3_000;
/** A child replaced by a resume is killed if it has not ended by then. */
const RETIRE_GRACE_MS = 3_000;
const SUBAGENT_PROGRESS_LINES = 12;
const DENY_MESSAGE =
  "The user denied this action. Stop and wait for the user's next instruction.";
const QUESTION_SKIPPED = "The user chose not to answer this question.";
const QUESTION_UNSUPPORTED =
  "This interface cannot show this question dialog. Ask the user in plain text instead.";

/**
 * The models of the CLI's `initialize` answer, one per model it resolves
 * to: aliases such as `default` and `opus` name the same model, and the
 * session shows the model it runs by that ID (`set_model` takes it too).
 */
export function claudeModels(value: unknown): AgentSessionModel[] {
  const models = new Map<string, AgentSessionModel>();
  /** Models named so far only by the `default` alias, whose label says so. */
  const byDefault = new Set<string>();
  for (const entry of Array.isArray(value) ? value : []) {
    const model = record(entry);
    const id = text(model?.resolvedModel) ?? text(model?.value);
    if (!model || !id || (models.has(id) && !byDefault.has(id))) continue;
    if (model.value === "default") byDefault.add(id);
    else byDefault.delete(id);
    const efforts = Array.isArray(model.supportedEffortLevels)
      ? model.supportedEffortLevels.filter((level) => typeof level === "string")
      : [];
    const description = text(model.description);
    models.set(id, {
      id,
      label: text(model.displayName) ?? id,
      ...(description ? { description } : {}),
      ...(model.supportsEffort === true && efforts.length > 0
        ? { efforts }
        : {}),
    });
  }
  return [...models.values()];
}

/** The command line of a session; the user's arguments come last. */
export function claudeArgv(userArgs: string[]): string[] {
  const has = (flag: string) =>
    userArgs.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
  const argv = [
    "claude",
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--replay-user-messages",
    "--verbose",
    "--permission-prompt-tool",
    "stdio",
  ];
  // The session starts in the permission mode of the user's Claude settings,
  // like the terminal UI, unless the command line chooses one. Without this
  // flag the CLI refuses a later switch to bypassPermissions.
  if (
    !has("--dangerously-skip-permissions") &&
    !has("--allow-dangerously-skip-permissions")
  )
    argv.push("--allow-dangerously-skip-permissions");
  return [...argv, ...userArgs];
}

/** The user's arguments, split by whether they choose the conversation. */
export type ClaudeConversationArgs = {
  /** Everything else: the model, permission flags and so on. */
  others: string[];
  /** `--resume <value>`: the conversation to continue. */
  resume?: string;
  /** `--continue`: continue the directory's newest conversation. */
  continues: boolean;
  /** `--fork-session` and `--session-id`, as given. */
  identity: string[];
};

/**
 * Pick the arguments that say which conversation a session is in. A bare
 * `--resume` (the terminal UI's picker) chooses none and is dropped: the
 * page offers the list instead.
 */
export function claudeConversationArgs(args: string[]): ClaudeConversationArgs {
  const choice: ClaudeConversationArgs = {
    others: [],
    continues: false,
    identity: [],
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const next = args[index + 1];
    if (arg === "--resume" || arg === "-r") {
      if (next !== undefined && !next.startsWith("-")) {
        choice.resume = next;
        index += 1;
      }
    } else if (arg.startsWith("--resume=")) {
      choice.resume = arg.slice("--resume=".length) || choice.resume;
    } else if (arg === "--continue" || arg === "-c") {
      choice.continues = true;
    } else if (arg === "--fork-session" || arg.startsWith("--session-id=")) {
      choice.identity.push(arg);
    } else if (arg === "--session-id") {
      choice.identity.push(arg);
      if (next !== undefined) {
        choice.identity.push(next);
        index += 1;
      }
    } else choice.others.push(arg);
  }
  return choice;
}

/** A stored conversation as a transcript, with where its item IDs ended. */
type StoredTranscript = {
  items: AgentItem[];
  nextLocalId: number;
  turn: number;
};

type PermissionRequest = {
  requestId: string;
  toolName: string;
  toolUseId: string | undefined;
  input: Record<string, unknown>;
  suggestions: unknown[];
  /** `AskUserQuestion`: the question whose options are the approval's. */
  question?: { text: string; labels: Map<string, string> };
};

type StreamBlock = {
  id: string;
  type: "assistant" | "thinking";
  /** The complete block arrived in an `assistant` message. */
  confirmed: boolean;
};

export class ClaudeAdapter implements AgentAdapter {
  private readonly store: AgentSessionStore;
  private process: AgentProcess | null = null;
  /** The user's arguments, naming the conversation the session is in. */
  private args: string[];
  /** Children replaced by a resume that have not ended yet. */
  private readonly retired = new Set<AgentProcess>();
  /** The current child answered `initialize` (or was given up waiting for). */
  private childReady = false;
  /** A stored transcript is being read; prompts and the idle status wait. */
  private restoring: Promise<void> | null = null;
  private stopping = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextControlId = 1;
  private nextSettingsId = 1;
  private nextLocalId = 1;
  private turn = 0;
  private readonly control = new Map<
    string,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly permissions = new Map<string, PermissionRequest>();
  /** Prompts written to the CLI that it has not echoed back yet. */
  private readonly unacked = new Set<string>();
  /** The CLI echoes prompts (`--replay-user-messages`); unknown until seen. */
  private echoes: boolean | null = null;
  private interrupting = false;
  /** The turn is ending because an approval was denied, not interrupted. */
  private denying = false;
  /** Between a turn's first sign of life and its result. */
  private turnActive = false;
  private messageId = "";
  /** Text and thinking blocks of the message being streamed, by index. */
  private readonly blocks = new Map<number, StreamBlock>();
  private readonly openTools = new Set<string>();
  private readonly deniedTools = new Set<string>();
  private readonly subagentProgress = new Map<string, string[]>();
  private usage: AgentSessionUsage = {};
  /** What the CLI's `initialize` listed. */
  private models: AgentSessionModel[] = [];

  constructor(private readonly options: AdapterOptions) {
    this.store = options.store;
    this.args = options.args;
  }

  start() {
    this.store.updateInfo({ modes: CLAUDE_MODES });
    const choice = claudeConversationArgs(this.options.args);
    let resume = choice.resume;
    let fresh: string | null = null;
    if (!resume && choice.continues) {
      // Named here, so that what is shown is what the CLI continues.
      resume = listClaudeSessions(this.projectDir(), { limit: 1 })[0]?.id;
      if (!resume)
        fresh =
          "No conversation is stored for this directory; this is a new one.";
    }
    this.args = [
      ...choice.others,
      ...choice.identity,
      ...(resume ? ["--resume", resume] : []),
    ];
    if (!this.launch()) return;
    if (fresh) this.notice("info", fresh);
    // A value that is not an ID (a title, a search) is left to the CLI.
    if (!resume || !isAgentSessionId(resume)) return;
    const id = resume;
    // A fork continues under an ID of its own, which the CLI reports.
    const forks = choice.identity.includes("--fork-session");
    this.restoring = ClaudeAdapter.storedTranscript(
      this.storedPath(id),
      this.options.cwd,
    )
      .then((stored) => {
        if (this.store.phase !== "exited")
          this.adopt(stored, forks ? undefined : id);
      })
      .catch((error) => {
        if (this.store.phase !== "exited")
          this.notice(
            "info",
            `The earlier messages of ${id} could not be read (${(error as Error).message}).`,
          );
      })
      .finally(() => {
        this.restoring = null;
        this.settleStart();
      });
  }

  /** Start the CLI with the current arguments; false when it cannot start. */
  private launch(): boolean {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.childReady = false;
    let child: AgentProcess;
    try {
      child = this.options.spawn({
        argv: claudeArgv(this.args),
        cwd: this.options.cwd,
        env: this.options.env,
        // A child replaced by a resume is no longer heard.
        onLine: (line) => {
          if (this.process === child) this.handleLine(line);
        },
        onExit: (exit) => {
          if (this.process === child) this.handleExit(exit);
          else this.retired.delete(child);
        },
      });
    } catch (error) {
      this.process = null;
      this.store.setPhase(
        "exited",
        `could not start claude: ${(error as Error).message}`,
      );
      this.options.onExit(this.store.info.error);
      return false;
    }
    this.process = child;
    this.readyTimer = setTimeout(() => this.ready(), READY_TIMEOUT_MS);
    this.request({ subtype: "initialize" }, READY_TIMEOUT_MS)
      .then((response) => {
        if (this.process !== child) return;
        const mode = text(response.current_permission_mode);
        this.models = claudeModels(response.models);
        this.store.updateInfo({
          ...(mode ? { mode } : {}),
          models: this.models.length > 0 ? this.models : undefined,
        });
        // The model and effort before the first turn reports them.
        void this.readSettings();
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.process === child) this.ready();
      });
    return true;
  }

  /** The model and effort the CLI runs the next turn with. */
  private async readSettings() {
    const child = this.process;
    const settings = await this.request(
      { subtype: "get_settings" },
      CONTROL_TIMEOUT_MS,
      `thyra-settings-${this.nextSettingsId++}`,
    ).catch(() => null);
    const applied = record(settings?.applied);
    if (!applied || this.process !== child) return;
    const effort = text(applied.effort);
    this.showModel(text(applied.model), effort ? { effort } : {});
  }

  /** A model, with the efforts it takes, in the session's info. */
  private showModel(model: string | undefined, extra: { effort?: string }) {
    const known = model ?? this.store.info.model;
    const efforts = this.models.find((entry) => entry.id === known)?.efforts;
    this.store.updateInfo({
      ...(model ? { model } : {}),
      efforts,
      ...(efforts ? {} : { effort: undefined }),
      ...(efforts ? extra : {}),
    });
  }

  private ready() {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.childReady = true;
    this.settleStart();
  }

  /** Idle once the CLI is ready and no stored transcript is still being read. */
  private settleStart() {
    if (this.childReady && !this.restoring && this.store.phase === "starting")
      this.store.setPhase("idle");
  }

  private projectDir(): string {
    return claudeProjectDir(this.options.cwd, this.options.env);
  }

  private storedPath(id: string): string {
    return join(this.projectDir(), `${id}.jsonl`);
  }

  async history(): Promise<AgentStoredSession[]> {
    return listClaudeSessions(this.projectDir(), {
      exclude: this.store.info.agent_session_id,
    });
  }

  /**
   * Continue a stored conversation: the CLI holds one conversation per
   * process, so the child is replaced by one started with `--resume`.
   */
  async resume(id: string) {
    if (this.restoring) await this.restoring;
    this.requireIdleForResume();
    let stored: StoredTranscript;
    try {
      stored = await ClaudeAdapter.storedTranscript(
        this.storedPath(id),
        this.options.cwd,
      );
    } catch (error) {
      throw new AgentActionError(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `no conversation ${id} is stored for this directory`
          : `conversation ${id} could not be read: ${(error as Error).message}`,
      );
    }
    // A prompt may have arrived while the file was read.
    this.requireIdleForResume();

    const previous = this.process;
    this.process = null;
    if (previous) {
      this.retired.add(previous);
      previous.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (this.retired.has(previous)) previous.kill("SIGKILL");
      }, RETIRE_GRACE_MS);
      timer.unref?.();
    }
    for (const waiting of this.control.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new AgentActionError("the conversation was replaced"));
    }
    this.control.clear();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.permissions.clear();
    this.unacked.clear();
    this.blocks.clear();
    this.openTools.clear();
    this.deniedTools.clear();
    this.subagentProgress.clear();
    this.echoes = null;
    this.interrupting = false;
    this.denying = false;
    this.turnActive = false;
    this.messageId = "";
    this.usage = {};

    this.args = [...claudeConversationArgs(this.args).others, "--resume", id];
    this.adopt(stored, id);
    this.store.setPhase("starting");
    this.launch();
  }

  private requireIdleForResume() {
    this.requireRunningProcess();
    if (this.store.phase === "running")
      throw new AgentActionError(
        this.store.approvals.length > 0
          ? "an approval is open; answer it or interrupt the turn first"
          : "a turn is running; wait for it or interrupt it first",
      );
  }

  /** Show a stored transcript in place of the session's own. */
  private adopt(stored: StoredTranscript, id: string | undefined) {
    this.store.resetItems(stored.items);
    // Items made from here on continue the restored ones' numbering.
    this.nextLocalId = Math.max(this.nextLocalId, stored.nextLocalId);
    this.turn = Math.max(this.turn, stored.turn);
    this.store.updateInfo({
      usage: undefined,
      ...(id ? { agent_session_id: id } : {}),
    });
  }

  /**
   * A stored conversation as transcript items. Its entries go through the
   * handlers that showed the same messages when they were live, in an
   * adapter that has no process and a store nobody listens to, so a
   * restored transcript reads like the live one did.
   */
  static async storedTranscript(
    path: string,
    cwd: string,
  ): Promise<StoredTranscript> {
    let at = 0;
    const store = new AgentSessionStore({
      info: { pane_id: "", kind: "claude", cwd, started_at: 0, modes: [] },
      onEvent: () => undefined,
      now: () => at,
    });
    const replay = new ClaudeAdapter({
      store,
      cwd,
      args: [],
      env: {},
      spawn: () => {
        throw new Error("a stored conversation has no process");
      },
      onExit: () => undefined,
    });
    for await (const entry of readClaudeConversation(path)) {
      // Items carry the time their entry was written. A prompt queued
      // during a turn is stamped when it was typed, before entries that
      // precede it: times never run backwards down the transcript.
      at = Math.max(at, Date.parse(text(entry.timestamp) ?? "") || 0);
      replay.replayStored(entry);
    }
    // A call left without a result did not finish.
    replay.endTurn(false);
    const items = withItemTimes(store.snapshot().items);
    store.dispose();
    return { items, nextLocalId: replay.nextLocalId, turn: replay.turn };
  }

  private replayStored(entry: StoredEntry) {
    if (!isTranscriptEntry(entry)) return;
    if (entry.type === "assistant") return this.handleAssistant(entry);
    if (entry.type === "system") return this.handleSystem(entry);
    const prompt = storedPrompt(entry) ?? storedCommand(entry);
    if (prompt !== null) {
      // The turn before a prompt is over, as its result said when live. A
      // prompt taken during a turn (stored as an attachment) joined it.
      if (entry.type === "user") this.endTurn(false);
      this.store.upsertItem({
        id: `user-${this.nextLocalId++}`,
        type: "user",
        text: prompt,
      });
      return;
    }
    if (entry.type !== "user") return;
    // Tool results and interruptions, in the shape the CLI streams them.
    const content = record(entry.message)?.content;
    const denial = text(entry.toolDenialKind);
    if (denial) this.denying = true;
    this.handleUser({
      ...entry,
      tool_use_result: entry.toolUseResult,
      tool_result_meta: (Array.isArray(content) ? content : []).flatMap(
        (value) => {
          const id = text(record(value)?.tool_use_id);
          return denial && id ? [{ id, non_execution_kind: denial }] : [];
        },
      ),
    });
  }

  async send(prompt: string, images: PromptImage[] = []) {
    // A prompt waits for a transcript that is being restored at startup.
    if (this.restoring) await this.restoring;
    this.requireRunningProcess();
    // The text, then the images in order: the shape the terminal UI gives
    // a prompt with pasted images. The CLI shrinks large images itself.
    const content: Record<string, unknown>[] = prompt.trim()
      ? [{ type: "text", text: prompt }]
      : [];
    for (const [index, image] of images.entries())
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mediaType,
          data: (await readPromptImage(image, index + 1)).toString("base64"),
        },
      });
    // The process may have ended while the files were read.
    if (images.length > 0) this.requireRunningProcess();
    // The CLI acknowledges a prompt by this ID, whatever its content.
    const uuid = randomUUID();
    this.unacked.add(uuid);
    this.store.upsertItem({
      id: `user-${this.nextLocalId++}`,
      type: "user",
      text: prompt,
      ...(images.length > 0
        ? { images: images.map(({ path }) => ({ path })) }
        : {}),
    });
    this.write({
      type: "user",
      uuid,
      session_id: this.store.info.agent_session_id ?? "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: images.length > 0 ? content : prompt,
      },
    });
    this.interrupting = false;
    this.store.setPhase("running");
  }

  async interrupt() {
    if (this.store.phase !== "running" || !this.process) return;
    this.interrupting = true;
    try {
      await this.request({ subtype: "interrupt" });
    } catch (error) {
      this.interrupting = false;
      throw error;
    }
    // The turn's result normally follows at once. A session that stays busy
    // with nothing to interrupt would otherwise never return to idle.
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.store.phase === "running") this.endTurn(true);
    }, INTERRUPT_SETTLE_MS);
  }

  async approve(approvalId: string, optionId: string) {
    this.requireRunningProcess();
    const request = this.permissions.get(approvalId);
    const approval = this.store.approval(approvalId);
    if (!request || !approval)
      throw new AgentActionError("this approval is no longer pending");
    const option = approval.options.find((entry) => entry.id === optionId);
    if (!option) throw new AgentActionError("unknown approval option");
    let response: Record<string, unknown>;
    if (option.kind === "deny") {
      // Denying a tool stops the turn, as it does in Claude Code's own UI;
      // a skipped question lets the agent carry on without the answer.
      response = request.question
        ? { behavior: "deny", message: QUESTION_SKIPPED }
        : { behavior: "deny", message: DENY_MESSAGE, interrupt: true };
    } else if (request.question) {
      response = {
        behavior: "allow",
        updatedInput: {
          ...request.input,
          answers: {
            [request.question.text]:
              request.question.labels.get(option.id) ?? option.label,
          },
        },
      };
    } else {
      response = {
        behavior: "allow",
        updatedInput: request.input,
        ...(option.kind === "allow_always"
          ? { updatedPermissions: request.suggestions }
          : {}),
      };
    }
    this.answerPermission(request, response);
    if (option.kind === "deny" && !request.question) {
      this.interrupting = true;
      this.denying = true;
    }
    this.markTool(
      request.toolUseId,
      option.kind === "deny" ? "denied" : "running",
    );
  }

  async setMode(mode: string) {
    this.requireRunningProcess();
    if (!CLAUDE_MODES.some((entry) => entry.id === mode))
      throw new AgentActionError(`unknown mode: ${mode}`);
    const response = await this.request({
      subtype: "set_permission_mode",
      mode,
    });
    this.store.updateInfo({ mode: text(response.mode) ?? mode });
  }

  async setModel(model: string) {
    this.requireRunningProcess();
    if (!this.models.some((entry) => entry.id === model))
      throw new AgentActionError(`unknown model: ${model}`);
    const response = await this.request({ subtype: "set_model", model });
    this.showModel(text(response.model) ?? model, {});
    // Each model keeps an effort of its own in the user's settings.
    await this.readSettings();
  }

  async setEffort(effort: string) {
    this.requireRunningProcess();
    if (!this.store.info.efforts?.includes(effort))
      throw new AgentActionError(`unknown effort: ${effort}`);
    // What the CLI's `--effort` sets; it holds from the next turn.
    await this.request({
      subtype: "apply_flag_settings",
      settings: { effortLevel: effort },
    });
    await this.readSettings();
  }

  /** The CLI's own `/compact`, which a prompt runs as a command. */
  async compact() {
    await this.send("/compact");
  }

  stop(force = false) {
    this.stopping = true;
    const signal = force ? "SIGKILL" : "SIGTERM";
    this.process?.kill(signal);
    for (const child of this.retired) child.kill(signal);
  }

  private requireRunningProcess() {
    if (!this.process || this.store.phase === "exited")
      throw new AgentActionError("the agent has exited");
  }

  private write(message: Record<string, unknown>) {
    this.process?.write(JSON.stringify(message));
  }

  /** Send a control request; resolves with the response body. */
  /** `id` names a side request outside the numbered sequence. */
  private request(
    request: Record<string, unknown>,
    timeoutMs = CONTROL_TIMEOUT_MS,
    id = `thyra-${this.nextControlId++}`,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.control.delete(id);
        reject(new AgentActionError("the agent did not answer in time"));
      }, timeoutMs);
      this.control.set(id, { resolve, reject, timer });
      this.write({ type: "control_request", request_id: id, request });
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
    const sessionId = text(message.session_id);
    if (sessionId && sessionId !== this.store.info.agent_session_id)
      this.store.updateInfo({ agent_session_id: sessionId });
    switch (message.type) {
      case "system":
        return this.handleSystem(message);
      case "stream_event":
        return this.handleStreamEvent(message);
      case "assistant":
        return this.handleAssistant(message);
      case "user":
        return this.handleUser(message);
      case "result":
        return this.handleResult(message);
      case "control_request":
        return this.handleControlRequest(message);
      case "control_response":
        return this.handleControlResponse(message);
      case "control_cancel_request":
        return this.cancelPermission(text(message.request_id) ?? "");
      case "command_lifecycle":
        return this.handleLifecycle(message);
      case "rate_limit_event":
        return this.handleRateLimit(message);
    }
  }

  private handleSystem(message: Record<string, unknown>) {
    switch (message.subtype) {
      case "init": {
        const mode = text(message.permissionMode);
        const model = text(message.model);
        const cwd = text(message.cwd);
        this.store.updateInfo({
          ...(mode ? { mode } : {}),
          ...(cwd ? { cwd } : {}),
        });
        if (model && model !== this.store.info.model) this.showModel(model, {});
        this.beginActivity();
        return;
      }
      case "status": {
        const mode = text(message.permissionMode);
        if (mode) this.store.updateInfo({ mode });
        return;
      }
      case "session_state_changed":
        if (message.state === "idle" && this.unacked.size === 0)
          this.endTurn(true, false);
        return;
      case "compact_boundary":
        this.notice("info", "Conversation compacted.");
        return;
      case "local_command_output":
      case "informational": {
        const content = text(message.content);
        if (content?.trim())
          this.notice(message.level === "warning" ? "error" : "info", content);
        return;
      }
      case "api_retry": {
        const status =
          typeof message.error_status === "number"
            ? ` (HTTP ${message.error_status})`
            : "";
        // One notice per turn, replaced by each further attempt.
        this.store.upsertItem({
          id: `retry-${this.turn}`,
          type: "notice",
          level: "info",
          text: `The API request failed${status}; retrying (attempt ${message.attempt} of ${message.max_retries}).`,
        });
        return;
      }
      case "permission_denied":
        this.markTool(text(message.tool_use_id), "denied");
        return;
    }
  }

  /**
   * What became of a prompt this host wrote: the CLI reports `queued`,
   * `started`, then `completed` or `cancelled` for its `uuid`.
   */
  private handleLifecycle(message: Record<string, unknown>) {
    const uuid = text(message.command_uuid) ?? "";
    if (message.state === "started") {
      this.echoes = true;
      this.unacked.delete(uuid);
      this.beginActivity();
    } else if (message.state === "completed" || message.state === "cancelled") {
      this.unacked.delete(uuid);
      // A prompt cancelled while it waited gets no turn and no result.
      if (
        !this.turnActive &&
        this.unacked.size === 0 &&
        this.store.phase === "running"
      )
        this.endTurn(true);
    }
  }

  /** Anything the main loop does means a turn is running. */
  private beginActivity() {
    this.turnActive = true;
    if (this.store.phase === "idle" || this.store.phase === "starting") {
      this.ready();
      this.store.setPhase("running");
    }
  }

  private handleStreamEvent(message: Record<string, unknown>) {
    // A sub-agent's stream belongs to its Task item, not the transcript.
    if (message.parent_tool_use_id) return;
    const event = record(message.event);
    if (!event) return;
    this.beginActivity();
    const index = typeof event.index === "number" ? event.index : -1;
    switch (event.type) {
      case "message_start": {
        const started = record(event.message);
        this.finishBlocks();
        this.messageId = text(started?.id) ?? `message-${this.nextLocalId++}`;
        this.noteUsage(record(started?.usage));
        return;
      }
      case "content_block_start": {
        const block = record(event.content_block);
        if (block?.type === "text" || block?.type === "thinking") {
          const type = block.type === "text" ? "assistant" : "thinking";
          this.blocks.set(index, {
            id: `${this.messageId}:${index}`,
            type,
            confirmed: false,
          });
          const initial = text(block.text) ?? text(block.thinking) ?? "";
          if (initial) this.streamText(index, initial);
        } else if (block?.type === "tool_use") {
          const name = text(block.name) ?? "tool";
          const id = text(block.id);
          if (id && !isTodoTool(name)) this.upsertTool(id, name, {}, "pending");
        }
        return;
      }
      case "content_block_delta": {
        const delta = record(event.delta);
        const piece =
          delta?.type === "text_delta"
            ? text(delta.text)
            : delta?.type === "thinking_delta"
              ? text(delta.thinking)
              : undefined;
        if (piece) this.streamText(index, piece);
        return;
      }
      case "content_block_stop":
        this.finishBlock(index);
        return;
      case "message_delta":
        this.noteUsage(record(event.usage));
        return;
      case "message_stop":
        this.finishBlocks();
        return;
    }
  }

  /** Append streamed text, creating the item at its first character. */
  private streamText(index: number, piece: string) {
    const block = this.blocks.get(index);
    if (!block) return;
    if (this.store.item(block.id)) this.store.appendDelta(block.id, piece);
    else
      this.store.upsertItem({
        id: block.id,
        type: block.type,
        text: piece,
        streaming: true,
      });
  }

  private finishBlock(index: number, finalText?: string) {
    const block = this.blocks.get(index);
    if (!block) return;
    const item = this.store.item(block.id);
    if (!item || (item.type !== "assistant" && item.type !== "thinking"))
      return;
    this.store.upsertItem({
      id: item.id,
      type: item.type,
      text: finalText ?? item.text,
      streaming: false,
    });
  }

  private finishBlocks() {
    for (const index of this.blocks.keys()) this.finishBlock(index);
    this.blocks.clear();
  }

  private noteUsage(usage: Record<string, unknown> | null) {
    if (!usage) return;
    const count = (key: string) =>
      typeof usage[key] === "number" ? (usage[key] as number) : 0;
    const context =
      count("input_tokens") +
      count("cache_creation_input_tokens") +
      count("cache_read_input_tokens") +
      count("output_tokens");
    if (context <= 0) return;
    this.usage = { ...this.usage, context_tokens: context };
    this.store.updateInfo({ usage: this.usage });
  }

  private handleAssistant(message: Record<string, unknown>) {
    const body = record(message.message);
    const content = Array.isArray(body?.content) ? body.content : [];
    const parent = text(message.parent_tool_use_id);
    if (parent) return this.foldSubagent(parent, content);
    this.beginActivity();
    const messageId = text(body?.id) ?? "";
    for (const value of content) {
      const block = record(value);
      if (block?.type === "text" || block?.type === "thinking") {
        const type = block.type === "text" ? "assistant" : "thinking";
        const complete = text(block.text) ?? text(block.thinking) ?? "";
        // The complete block of a streamed one: the earliest still open.
        const streamed =
          messageId === this.messageId
            ? [...this.blocks].find(
                ([, entry]) => entry.type === type && !entry.confirmed,
              )
            : undefined;
        if (streamed) {
          streamed[1].confirmed = true;
          if (this.store.item(streamed[1].id))
            this.finishBlock(streamed[0], complete);
          else if (complete.trim())
            this.store.upsertItem({
              id: streamed[1].id,
              type,
              text: complete,
              streaming: false,
            });
        } else if (complete.trim()) {
          this.store.upsertItem({
            id: `${messageId || "message"}:a${this.nextLocalId++}`,
            type,
            text: complete,
            streaming: false,
          });
        }
      } else if (block?.type === "tool_use") {
        const id = text(block.id);
        const name = text(block.name) ?? "tool";
        if (!id) continue;
        if (isTodoTool(name)) {
          const entries = planEntries(block.input);
          if (entries)
            this.store.upsertItem({
              id: `plan-${this.turn}`,
              type: "plan",
              entries,
            });
          continue;
        }
        this.openTools.add(id);
        this.upsertTool(id, name, block.input, "running");
      }
    }
    const failure = text(message.error);
    if (failure) this.notice("error", `Claude reported an error: ${failure}`);
  }

  private upsertTool(
    id: string,
    name: string,
    input: unknown,
    status: AgentToolItem["status"],
  ) {
    const previous = this.store.item(id);
    // An approval that is already open keeps the call pending.
    const pending = [...this.permissions.values()].some(
      (request) => request.toolUseId === id,
    );
    this.store.upsertItem({
      id,
      type: "tool",
      name,
      status: pending ? "pending" : status,
      ...describeClaudeTool(name, input, this.options.cwd),
      ...(previous?.type === "tool" && previous.output !== undefined
        ? { output: previous.output }
        : {}),
    });
  }

  private markTool(id: string | undefined, status: AgentToolItem["status"]) {
    const item = id ? this.store.item(id) : undefined;
    if (!id || item?.type !== "tool") return;
    if (status === "denied") this.deniedTools.add(id);
    this.store.upsertItem({ ...item, status });
  }

  /** A sub-agent's tool calls show as progress lines on its Task item. */
  private foldSubagent(parent: string, content: unknown[]) {
    const item = this.store.item(parent);
    if (item?.type !== "tool" || !this.openTools.has(parent)) return;
    const lines = this.subagentProgress.get(parent) ?? [];
    for (const value of content) {
      const block = record(value);
      if (block?.type !== "tool_use") continue;
      const name = text(block.name) ?? "tool";
      const view = describeClaudeTool(name, block.input, this.options.cwd);
      lines.push(view.title === name ? name : `${name}: ${view.title}`);
    }
    if (lines.length === 0) return;
    this.subagentProgress.set(parent, lines.slice(-SUBAGENT_PROGRESS_LINES));
    this.store.upsertItem({
      ...item,
      output: this.subagentProgress.get(parent)!.join("\n"),
    });
  }

  private handleUser(message: Record<string, unknown>) {
    if (message.isReplay === true) {
      this.echoes = true;
      this.unacked.delete(text(message.uuid) ?? "");
      return;
    }
    if (message.parent_tool_use_id) return;
    const content = record(message.message)?.content;
    if (!Array.isArray(content)) return;
    const results = content.filter(
      (value) => record(value)?.type === "tool_result",
    );
    // Calls a rule, a hook or the user refused never ran.
    const notRun = new Set(
      (Array.isArray(message.tool_result_meta)
        ? message.tool_result_meta
        : []
      ).flatMap((value) => {
        const meta = record(value);
        const id = text(meta?.id);
        return id &&
          /reject|den(y|ied)|block/i.test(text(meta?.non_execution_kind) ?? "")
          ? [id]
          : [];
      }),
    );
    for (const value of content) {
      const block = record(value);
      if (block?.type === "tool_result") {
        const id = text(block.tool_use_id);
        if (!id) continue;
        this.openTools.delete(id);
        this.subagentProgress.delete(id);
        const item = this.store.item(id);
        if (item?.type !== "tool") continue;
        // `tool_use_result` describes the message's only result.
        const diffs =
          results.length === 1 && block.is_error !== true
            ? resultDiffs(message.tool_use_result)
            : null;
        this.store.upsertItem({
          ...item,
          ...(diffs ? { diffs } : {}),
          ...boundToolOutput(toolResultText(block.content)),
          status:
            this.deniedTools.has(id) || notRun.has(id)
              ? "denied"
              : block.is_error === true
                ? "failed"
                : "done",
        });
      } else if (
        block?.type === "text" &&
        text(block.text)?.startsWith("[Request interrupted by user") &&
        !this.denying
      ) {
        this.notice("info", "Interrupted.");
      }
    }
  }

  private handleResult(message: Record<string, unknown>) {
    const models = record(message.modelUsage);
    if (models) {
      let window = 0;
      let output = 0;
      for (const [name, value] of Object.entries(models)) {
        const usage = record(value);
        if (typeof usage?.outputTokens === "number")
          output += usage.outputTokens;
        if (
          typeof usage?.contextWindow === "number" &&
          (name === this.store.info.model || usage.contextWindow > window)
        )
          window = usage.contextWindow;
      }
      this.usage = {
        ...this.usage,
        ...(window > 0 ? { context_window: window } : {}),
        ...(output > 0 ? { output_tokens: output } : {}),
      };
      this.store.updateInfo({ usage: this.usage });
    }
    const aborted =
      this.interrupting ||
      String(message.terminal_reason ?? "").startsWith("aborted");
    if (message.is_error === true && !aborted) {
      const errors = Array.isArray(message.errors)
        ? message.errors.filter((entry) => typeof entry === "string")
        : [];
      this.notice(
        "error",
        errors.join("\n") ||
          text(message.result) ||
          `The turn ended with an error (${String(message.subtype)}).`,
      );
    }
    // No echo before the first result: this CLI does not acknowledge prompts.
    if (this.echoes === null) this.echoes = false;
    if (!this.echoes) this.unacked.clear();
    const queued =
      typeof message.queued_turn_count === "number"
        ? message.queued_turn_count
        : 0;
    this.endTurn(this.unacked.size === 0 && queued === 0, aborted);
  }

  /**
   * Close what the finished turn left open. The session is idle afterwards
   * unless another prompt is already on its way to the CLI.
   */
  private endTurn(idle: boolean, aborted = true) {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.finishBlocks();
    for (const request of [...this.permissions.values()])
      this.cancelPermission(request.requestId);
    for (const id of this.openTools) {
      const item = this.store.item(id);
      if (item?.type !== "tool") continue;
      if (item.status !== "pending" && item.status !== "running") continue;
      this.markTool(id, aborted ? "failed" : "done");
    }
    this.openTools.clear();
    this.subagentProgress.clear();
    this.interrupting = false;
    this.denying = false;
    this.turnActive = false;
    this.turn += 1;
    if (idle) {
      this.unacked.clear();
      if (this.store.phase === "running") this.store.setPhase("idle");
    }
  }

  private handleControlResponse(message: Record<string, unknown>) {
    const response = record(message.response);
    const id = text(response?.request_id);
    const waiting = id ? this.control.get(id) : undefined;
    if (!response || !id || !waiting) return;
    this.control.delete(id);
    clearTimeout(waiting.timer);
    if (response.subtype === "success")
      waiting.resolve(record(response.response) ?? {});
    else
      waiting.reject(
        new AgentActionError(text(response.error) ?? "the agent refused"),
      );
  }

  private handleControlRequest(message: Record<string, unknown>) {
    const requestId = text(message.request_id);
    const request = record(message.request);
    if (!requestId || !request) return;
    if (request.subtype !== "can_use_tool") {
      // Dialogs, hooks and MCP messages this host does not offer: say so,
      // so the CLI does not wait for an answer.
      this.write({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: requestId,
          error: `${String(request.subtype)} is not supported by this client`,
        },
      });
      return;
    }
    const toolName = text(request.tool_name) ?? "tool";
    const input = record(request.input) ?? {};
    const toolUseId = text(request.tool_use_id);
    const pending: PermissionRequest = {
      requestId,
      toolName,
      toolUseId,
      input,
      suggestions:
        Array.isArray(request.permission_suggestions) &&
        request.suppress_always_allow_rule !== true
          ? request.permission_suggestions
          : [],
    };
    let options: AgentApprovalOption[];
    let title: string;
    let detail: string | undefined;
    if (toolName === "AskUserQuestion") {
      const question = singleQuestion(input);
      if (!question) {
        this.answerPermission(pending, {
          behavior: "deny",
          message: QUESTION_UNSUPPORTED,
        });
        return;
      }
      pending.question = { text: question.text, labels: question.labels };
      title = question.text;
      detail = question.detail;
      options = [
        ...question.options,
        { id: "deny", label: "Skip", kind: "deny" },
      ];
    } else {
      const view = describeClaudeTool(toolName, input, this.options.cwd);
      title =
        text(request.title) ??
        (view.title === toolName ? toolName : `${toolName}: ${view.title}`);
      detail =
        toolName === "ExitPlanMode"
          ? text(input.plan)
          : (text(request.description) ??
            text(request.decision_reason) ??
            (request.agent_id ? "Requested by a sub-agent." : undefined));
      options = [
        { id: "allow", label: "Allow", kind: "allow" },
        ...(pending.suggestions.length > 0
          ? [
              {
                id: "allow_always",
                label: alwaysLabel(pending.suggestions),
                kind: "allow_always" as const,
              },
            ]
          : []),
        { id: "deny", label: "Deny", kind: "deny" },
      ];
    }
    this.permissions.set(requestId, pending);
    const item = toolUseId ? this.store.item(toolUseId) : undefined;
    if (item?.type === "tool") this.markTool(toolUseId, "pending");
    const approval: AgentApproval = {
      id: requestId,
      ...(item?.type === "tool" ? { item_id: item.id } : {}),
      title: oneLine(title, 400),
      ...(detail ? { detail: detail.slice(0, 8000) } : {}),
      options,
    };
    this.store.addApproval(approval);
  }

  private answerPermission(
    request: PermissionRequest,
    response: Record<string, unknown>,
  ) {
    this.permissions.delete(request.requestId);
    this.write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: request.requestId,
        response: {
          ...response,
          ...(request.toolUseId ? { toolUseID: request.toolUseId } : {}),
        },
      },
    });
    this.store.resolveApproval(request.requestId);
  }

  /** The CLI withdrew a prompt (interrupt, another answer, turn over). */
  private cancelPermission(requestId: string) {
    const request = this.permissions.get(requestId);
    if (!request) return;
    this.permissions.delete(requestId);
    this.store.resolveApproval(requestId);
    const item = request.toolUseId
      ? this.store.item(request.toolUseId)
      : undefined;
    if (item?.type === "tool" && item.status === "pending")
      this.markTool(request.toolUseId, "running");
  }

  private handleRateLimit(message: Record<string, unknown>) {
    const info = record(message.rate_limit_info);
    if (info?.status !== "rejected") return;
    const resets =
      typeof info.resetsAt === "number"
        ? ` It resets at ${new Date(info.resetsAt * 1000).toISOString()}.`
        : "";
    this.store.upsertItem({
      id: `rate-limit-${this.turn}`,
      type: "notice",
      level: "error",
      text: `The usage limit was reached.${resets}`,
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
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.process = null;
    for (const [id, waiting] of this.control) {
      clearTimeout(waiting.timer);
      waiting.reject(new AgentActionError("the agent has exited"));
      this.control.delete(id);
    }
    this.endTurn(false);
    const error =
      this.stopping || exit.code === 0
        ? undefined
        : describeAgentExit("claude", exit);
    this.store.setPhase("exited", error);
    this.options.onExit(error);
  }
}

function alwaysLabel(suggestions: unknown[]): string {
  for (const value of suggestions) {
    const update = record(value);
    if (update?.type === "setMode" && typeof update.mode === "string")
      return update.mode === "acceptEdits"
        ? "Allow all edits this session"
        : `Allow and switch to ${update.mode}`;
    if (update?.type === "addRules" && Array.isArray(update.rules)) {
      const rule = record(update.rules[0]);
      const tool = text(rule?.toolName);
      const content = text(rule?.ruleContent);
      if (tool)
        return oneLine(
          `Always allow ${tool}${content ? `(${content})` : ""}`,
          120,
        );
    }
    if (update?.type === "addDirectories" && Array.isArray(update.directories))
      return oneLine(
        `Always allow in ${String(update.directories[0] ?? "")}`,
        120,
      );
  }
  return "Always allow";
}

/**
 * An `AskUserQuestion` call this interface can show: one question with
 * choices, exactly one of which is picked.
 */
function singleQuestion(input: Record<string, unknown>): {
  text: string;
  detail?: string;
  options: AgentApprovalOption[];
  labels: Map<string, string>;
} | null {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const question = record(questions[0]);
  const prompt = text(question?.question);
  if (questions.length !== 1 || !question || !prompt) return null;
  if (question.multiSelect === true || !Array.isArray(question.options))
    return null;
  const labels = new Map<string, string>();
  const details: string[] = [];
  const options = question.options.flatMap(
    (value, index): AgentApprovalOption[] => {
      const option = record(value);
      const label = text(option?.label);
      if (!label) return [];
      const id = `answer-${index + 1}`;
      labels.set(id, label);
      const description = text(option?.description);
      if (description) details.push(`${label}: ${description}`);
      return [{ id, label: oneLine(label, 120), kind: "allow" }];
    },
  );
  if (options.length === 0) return null;
  return {
    text: prompt,
    ...(details.length > 0 ? { detail: details.join("\n") } : {}),
    options,
    labels,
  };
}
