import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { thyraEnv } from "../config/environment";
import type { Logger } from "../utils/logger";

/**
 * Claude Code's voice input as a transcription service for panes whose agent
 * has none (Codex, Cursor, a shell): a hidden Claude Code runs in its own
 * pseudo-terminal on the host and records the host's default microphone,
 * which the remote-mic stream makes the browser's microphone.
 *
 * A take holds Claude Code's voice key (F12, hold mode) by repeating it like
 * a held key, lets go, waits for the transcript to settle in its prompt, and
 * takes the prompt out through the external editor (Ctrl+G): EDITOR is a
 * script that copies the file to `out` and empties it, so the prompt is
 * empty again for the next take. Nothing is ever submitted.
 *
 * The process starts on first use and exits after IDLE_MS without takes.
 */

/** F12, bound to `voice:pushToTalk` in the Chat context. */
const VOICE_KEY = "\x1b[24~";
const CTRL_G = "\x07";
const ESCAPE = "\x1b";
/** Hold mode lets go 200 ms after the last repeat. */
const REPEAT_MS = 80;
/** The voice module loads after the prompt first renders. */
const WARMUP_MS = 3_000;
const QUIET_MS = 500;
const START_TIMEOUT_MS = 30_000;
/** Recording ends 200 ms after the last repeat; transcription follows. */
const RELEASE_MS = 300;
/** Its meters and "Transcribing…" redraw constantly; quiet means idle. */
const SETTLE_QUIET_MS = 600;
const SETTLE_TIMEOUT_MS = 15_000;
const EXTRACT_TIMEOUT_MS = 4_000;
const POLL_MS = 50;
/** The dialog takes keys only once it has rendered. */
const TRUST_KEY_DELAY_MS = 400;
const IDLE_MS = 30 * 60_000;

export type TranscriberTerminal = {
  write(data: string): void;
  kill(): void;
  exited: Promise<number>;
};

export type ClaudeTranscriberDeps = {
  /** Start `argv` in a pseudo-terminal; `onData` gets its output. */
  spawn: (
    argv: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      onData: (text: string) => void;
    },
  ) => TranscriberTerminal;
  which: (command: string) => string | null;
  env: Record<string, string | undefined>;
  /** Holds the editor script and the extracted prompt. */
  stateDir: string;
  logger: Pick<Logger, "info" | "warn" | "debug">;
  now?: () => number;
  readFile?: (path: string) => string | null;
};

/** Output with escape sequences removed, for matching visible text. */
export function visibleText(output: string): string {
  return output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[^[\]]/g, "");
}

/**
 * The keys that accept Claude Code's folder trust dialog, or null when the
 * output does not show it. The selected line carries ❯; "Yes" may be either
 * option depending on the version.
 */
export function trustAnswer(visible: string): string[] | null {
  if (!/trust this folder/i.test(visible) || !/Enter to confirm/i.test(visible))
    return null;
  const selected = visible
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.includes("❯"));
  return selected && /\bNo\b/.test(selected) ? ["\x1b[B", "\r"] : ["\r"];
}

/** Whether the prompt is on screen, not just the trust dialog's ❯. */
export function promptAfterDialog(visible: string): boolean {
  const dialog = visible.toLowerCase().lastIndexOf("trust this folder");
  return visible.slice(dialog < 0 ? 0 : dialog).includes("❯");
}

/** The settings the hidden instance runs with, whatever the user's are. */
export const TRANSCRIBER_SETTINGS = {
  voice: { enabled: true, mode: "hold", autoSubmit: false },
  disableAllHooks: true,
};

export function transcriberArgv(claude: string): string[] {
  return [
    claude,
    "--settings",
    JSON.stringify(TRANSCRIBER_SETTINGS),
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
  ];
}

const EDITOR_SCRIPT = `#!/bin/sh
# Thyra's transcriber: hand Claude Code's prompt to Thyra and empty it.
cat "$1" > "$THYRA_TRANSCRIBER_OUT.tmp" && mv -f "$THYRA_TRANSCRIBER_OUT.tmp" "$THYRA_TRANSCRIBER_OUT"
: > "$1"
`;

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createClaudeTranscriber(deps: ClaudeTranscriberDeps) {
  const now = deps.now ?? Date.now;
  const readFile =
    deps.readFile ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });
  const editor = join(deps.stateDir, "transcriber-editor.sh");
  const out = join(deps.stateDir, "transcriber-prompt.txt");

  let terminal: TranscriberTerminal | null = null;
  let starting: Promise<TranscriberTerminal> | null = null;
  let visible = "";
  let lastOutputAt = 0;
  let repeat: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Takes run one at a time; a newer take cancels the one before. */
  let take = 0;

  const command = () =>
    thyraEnv("TRANSCRIBER_CLAUDE", deps.env)?.trim() || deps.which("claude");

  function available(): { available: boolean; reason?: string } {
    const setting = thyraEnv("TRANSCRIBER", deps.env)?.trim().toLowerCase();
    if (setting && ["0", "off", "false", "no"].includes(setting))
      return {
        available: false,
        reason: "Dictation through Claude Code is off (THYRA_TRANSCRIBER).",
      };
    if (!command())
      return {
        available: false,
        reason:
          "Dictating into this pane needs Claude Code (claude) on the host.",
      };
    return { available: true };
  }

  function stop() {
    release();
    const current = terminal;
    terminal = null;
    starting = null;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    try {
      current?.kill();
    } catch {}
  }

  function touch() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      deps.logger.info("transcriber idle, stopping");
      stop();
    }, IDLE_MS);
  }

  async function waitQuiet(quietMs: number, timeoutMs: number) {
    const deadline = now() + timeoutMs;
    while (now() - lastOutputAt < quietMs) {
      if (now() > deadline) return false;
      await delay(POLL_MS);
    }
    return true;
  }

  async function launch(): Promise<TranscriberTerminal> {
    const claude = command();
    if (!claude) throw new Error(available().reason);
    mkdirSync(deps.stateDir, { recursive: true });
    writeFileSync(editor, EDITOR_SCRIPT, { mode: 0o755 });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(deps.env)) {
      if (value === undefined) continue;
      // Not a Herdr pane: keep its hooks and Thyra's own settings out.
      // Nor a child of whichever Claude Code started Thyra.
      if (
        /^(HERDR_|THYRA_|TMUX|ZELLIJ|CLAUDECODE$|CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|SSE_PORT)$)/.test(
          key,
        )
      )
        continue;
      env[key] = value;
    }
    Object.assign(env, {
      TERM: "xterm-256color",
      EDITOR: editor,
      VISUAL: editor,
      THYRA_TRANSCRIBER_OUT: out,
    });
    visible = "";
    lastOutputAt = now();
    let answeredTrust = false;
    let prompted = false;
    const proc = deps.spawn(transcriberArgv(claude), {
      // Not the home folder, where trusting it lasts one session only.
      cwd: deps.stateDir,
      env,
      onData: (text) => {
        lastOutputAt = now();
        visible = (visible + visibleText(text)).slice(-8_000);
        if (!answeredTrust) {
          const keys = trustAnswer(visible);
          if (keys) {
            // Once per folder: Yes is remembered for the state directory.
            answeredTrust = true;
            visible = "";
            deps.logger.info("transcriber trusts its folder");
            void (async () => {
              for (const key of keys) {
                await delay(TRUST_KEY_DELAY_MS);
                proc.write(key);
              }
            })();
            return;
          }
        }
        // The prompt's ❯, drawn after the trust dialog's last redraw.
        if (!prompted && promptAfterDialog(visible)) prompted = true;
      },
    });
    terminal = proc;
    void proc.exited.then((code) => {
      if (terminal !== proc) return;
      deps.logger.warn("transcriber exited", { code });
      terminal = null;
      starting = null;
      release();
    });
    const deadline = now() + START_TIMEOUT_MS;
    while (!prompted || now() - lastOutputAt < QUIET_MS) {
      if (terminal !== proc)
        throw new Error("Claude Code exited while starting");
      if (now() > deadline) {
        deps.logger.warn("transcriber did not start", {
          screen: visible.slice(-600),
        });
        stop();
        throw new Error("Claude Code did not start in time for dictation");
      }
      await delay(POLL_MS);
    }
    await delay(WARMUP_MS);
    deps.logger.info("transcriber ready");
    return proc;
  }

  function ensure(): Promise<TranscriberTerminal> {
    if (terminal && !starting) return Promise.resolve(terminal);
    starting ??= launch().finally(() => {
      starting = null;
    });
    return starting;
  }

  function release() {
    if (repeat) clearInterval(repeat);
    repeat = null;
  }

  /** Let go, wait for the transcript, and take the prompt out. */
  async function collect(proc: TranscriberTerminal): Promise<string> {
    release();
    await delay(RELEASE_MS);
    await waitQuiet(SETTLE_QUIET_MS, SETTLE_TIMEOUT_MS);
    rmSync(out, { force: true });
    proc.write(CTRL_G);
    const deadline = now() + EXTRACT_TIMEOUT_MS;
    for (;;) {
      const text = readFile(out);
      if (text !== null) {
        rmSync(out, { force: true });
        return text.replace(/\s+$/, "");
      }
      if (now() > deadline)
        throw new Error("Claude Code did not hand over the transcript");
      await delay(POLL_MS);
    }
  }

  return {
    available,

    /**
     * Start a take: Claude Code is recording the default microphone once
     * this resolves. The returned take ends with `finish` or `cancel`.
     */
    async begin() {
      const id = ++take;
      const proc = await ensure();
      if (id !== take) throw new Error("dictation was cancelled");
      touch();
      release();
      proc.write(VOICE_KEY);
      repeat = setInterval(() => {
        if (terminal === proc) proc.write(VOICE_KEY);
      }, REPEAT_MS);
      const current = () => id === take && terminal === proc;
      return {
        /** Stop recording and return what was said ("" for nothing). */
        async finish(): Promise<string> {
          if (!current()) throw new Error("dictation was cancelled");
          try {
            return await collect(proc);
          } finally {
            touch();
          }
        },
        /** Stop recording and throw the words away. */
        async cancel() {
          if (!current()) return;
          take++;
          release();
          // Escape discards a recording; the prompt is emptied either way.
          proc.write(ESCAPE);
          try {
            await collect(proc);
          } catch {}
        },
      };
    },

    stop,
  };
}

export type ClaudeTranscriber = ReturnType<typeof createClaudeTranscriber>;
export type TranscriberTake = Awaited<ReturnType<ClaudeTranscriber["begin"]>>;

/** The service with a real Claude Code process. */
export function createHostClaudeTranscriber(
  logger: ClaudeTranscriberDeps["logger"],
  stateDir: string,
) {
  return createClaudeTranscriber({
    logger,
    env: process.env,
    stateDir,
    which: (command) => Bun.which(command),
    spawn: (argv, { cwd, env, onData }) => {
      const decoder = new TextDecoder();
      const proc = Bun.spawn(argv, {
        cwd,
        env,
        terminal: {
          cols: 160,
          rows: 30,
          data(_terminal, data) {
            onData(decoder.decode(data, { stream: true }));
          },
        },
      });
      return {
        write(data) {
          proc.terminal?.write(data);
        },
        kill() {
          proc.kill();
        },
        exited: proc.exited,
      };
    },
  });
}
