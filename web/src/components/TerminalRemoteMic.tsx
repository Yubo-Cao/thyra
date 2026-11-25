import { LoaderCircle, Mic, Square } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { RemoteMicStatus } from "../../../shared/remoteMic";
import { t } from "../i18n";
import { shortcutMatches, shortcutTitle } from "../shortcutPreferences";
import {
  REMOTE_MIC_HOLD_MS,
  REMOTE_MIC_REPEAT_MS,
  REMOTE_MIC_TAIL_MS,
  type RemoteMicSession,
} from "../voice/remoteMicProtocol";
import "./TerminalRemoteMic.css";
import { IconButton } from "./ui/IconButton";
import { keyboardOverlayOpen } from "./ui/overlayState";

export type RemoteMicPhase = "idle" | "starting" | "recording" | "stopping";
export type TerminalRemoteMic = ReturnType<typeof useTerminalRemoteMic>;

const delay = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * The host microphone for one terminal pane: the `terminal.remoteMic`
 * shortcut (Ctrl+M) streams this computer's microphone to the Thyra host's
 * virtual default source and holds the agent's voice key in the pane
 * (Claude Code's hold-mode `voice:pushToTalk`) by repeating it the way a
 * held key auto-repeats. Hold mode, unlike tap mode, starts with text
 * already in the prompt. The second press keeps streaming briefly so the
 * last words reach the host, lets go of the key (the agent stops and
 * inserts or sends), then releases the mic.
 *
 * Panes whose agent has no voice input (Codex, Cursor, a shell) dictate
 * instead: a hidden Claude Code on the host transcribes the stream, and the
 * text is pasted into the pane. Where the host microphone cannot reach the
 * pane, or the host cannot dictate, the shortcut runs `fallback` (Thyra's own
 * voice typing) instead.
 *
 * Starting needs this pane to hold the keyboard focus; once recording, the
 * shortcut stops it from anywhere. Leaving the pane, unmounting or losing
 * the stream stops it too.
 */
export function useTerminalRemoteMic({
  enabled,
  container,
  connectionId,
  terminalId,
  pressVoiceKey,
  dictate,
  insertText,
  fallback,
  onError,
}: {
  /** The active pane, and the caller may type into it. */
  enabled: boolean;
  container: HTMLElement | null;
  connectionId: string;
  terminalId: () => string | null;
  pressVoiceKey: (terminalId: string) => Promise<void>;
  /** The pane's agent has no voice input of its own: dictate and paste. */
  dictate: () => boolean;
  insertText: (text: string) => Promise<void>;
  /** Used where the host microphone cannot serve the pane. */
  fallback: () => void;
  onError: (message: string) => void;
}) {
  const [phase, setPhase] = useState<RemoteMicPhase>("idle");
  const [level, setLevel] = useState(0);
  const phaseRef = useRef<RemoteMicPhase>("idle");
  const sessionRef = useRef<RemoteMicSession | null>(null);
  /** Stops repeating the voice key, which lets go of it. */
  const releaseRef = useRef<(() => void) | null>(null);
  const runRef = useRef(0);
  /** The running stream dictates (pastes) instead of holding a key. */
  const dictatingRef = useRef(false);
  /** The host's last answer, read synchronously inside the key press. */
  const statusRef = useRef<RemoteMicStatus | null>(null);
  const latest = useRef({
    connectionId,
    terminalId,
    pressVoiceKey,
    dictate,
    insertText,
    fallback,
    onError,
  });
  latest.current = {
    connectionId,
    terminalId,
    pressVoiceKey,
    dictate,
    insertText,
    fallback,
    onError,
  };

  const refreshStatus = useCallback(() => {
    void import("../voice/remoteMic")
      .then(({ remoteMicStatus }) => remoteMicStatus())
      .then(
        (status) => {
          statusRef.current = status;
        },
        () => undefined,
      );
  }, []);
  useEffect(() => {
    if (enabled) refreshStatus();
  }, [enabled, refreshStatus]);

  const set = (next: RemoteMicPhase) => {
    phaseRef.current = next;
    setPhase(next);
    if (next === "idle") setLevel(0);
  };

  const pressKey = async (terminal: string) => {
    try {
      await latest.current.pressVoiceKey(terminal);
      return true;
    } catch (error) {
      latest.current.onError(
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  };

  /**
   * Press the voice key now and again every REMOTE_MIC_REPEAT_MS until the
   * returned function runs, like a held key. A failed press stops the
   * repeat and reports through `onFail`.
   */
  const holdKey = (terminal: string, onFail: () => void) => {
    let held = true;
    let timer = 0;
    const press = async () => {
      if (!held) return;
      if (await pressKey(terminal)) {
        if (held) timer = window.setTimeout(press, REMOTE_MIC_REPEAT_MS);
      } else if (held) {
        held = false;
        onFail();
      }
    };
    void press();
    return () => {
      held = false;
      window.clearTimeout(timer);
    };
  };

  const releaseKey = () => {
    releaseRef.current?.();
    releaseRef.current = null;
  };

  const finish = useCallback(async () => {
    if (phaseRef.current !== "recording") return;
    const run = runRef.current;
    set("stopping");
    // The last syllables are still on their way to the host.
    await delay(REMOTE_MIC_TAIL_MS);
    if (dictatingRef.current) {
      const session = sessionRef.current;
      sessionRef.current = null;
      try {
        const text = (await session?.transcribe())?.trim();
        if (text) await latest.current.insertText(text);
      } catch (error) {
        latest.current.onError(
          error instanceof Error ? error.message : String(error),
        );
      }
      if (runRef.current === run) set("idle");
      return;
    }
    // The agent stops once the repeats stop; keep the source up meanwhile.
    releaseKey();
    await delay(REMOTE_MIC_HOLD_MS);
    const session = sessionRef.current;
    sessionRef.current = null;
    await session?.stop();
    if (runRef.current === run) set("idle");
  }, []);

  const cancelStart = useCallback(() => {
    runRef.current++;
    releaseKey();
    sessionRef.current?.cancel();
    sessionRef.current = null;
    set("idle");
  }, []);

  const start = useCallback(() => {
    const terminal = latest.current.terminalId();
    if (!terminal) {
      latest.current.onError(t("No active pane"));
      return;
    }
    const dictating = latest.current.dictate();
    const status = statusRef.current;
    // Refreshed for the next press; this one goes by what is known.
    refreshStatus();
    if (
      status &&
      (!status.available ||
        !status.connections.includes(latest.current.connectionId) ||
        (dictating && !status.dictation))
    ) {
      latest.current.fallback();
      return;
    }
    dictatingRef.current = dictating;
    // Created inside the key press, so the browser lets it play.
    let context: AudioContext;
    try {
      context = new AudioContext({ latencyHint: "interactive" });
    } catch (error) {
      latest.current.onError(
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const run = ++runRef.current;
    set("starting");
    // Loaded on first use, like voice typing.
    void import("../voice/remoteMic")
      .then(({ startRemoteMic }) =>
        startRemoteMic({
          connectionId: latest.current.connectionId,
          terminalId: terminal,
          context,
          dictate: dictating,
          onLevel: (value) => {
            if (runRef.current === run) setLevel(value);
          },
          onEnd: (message) => {
            if (runRef.current !== run) return;
            latest.current.onError(message);
            // Let go of the key too, so the agent stops recording.
            releaseKey();
            sessionRef.current = null;
            set("idle");
          },
        }),
      )
      .then(
        async (session) => {
          if (runRef.current !== run) {
            session.cancel();
            return;
          }
          sessionRef.current = session;
          if (dictating) {
            set("recording");
            return;
          }
          releaseRef.current = holdKey(terminal, () => {
            if (runRef.current !== run) return;
            if (phaseRef.current === "recording") void finish();
            else cancelStart();
          });
          set("recording");
        },
        (error: unknown) => {
          void context.close().catch(() => undefined);
          if (runRef.current !== run) return;
          set("idle");
          latest.current.onError(
            error instanceof Error ? error.message : String(error),
          );
        },
      );
  }, [cancelStart, finish, refreshStatus]);

  const toggle = useCallback(() => {
    const current = phaseRef.current;
    if (current === "idle") start();
    else if (current === "starting") cancelStart();
    else if (current === "recording") void finish();
  }, [cancelStart, finish, start]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!shortcutMatches(event, "terminal.remoteMic")) return;
      const busy = phaseRef.current !== "idle";
      if (!busy) {
        const focused =
          !!container && container.contains(document.activeElement);
        if (!enabled || !focused || keyboardOverlayOpen()) return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggle();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [container, enabled, toggle]);

  // Leaving the pane ends the dictation as the second press would.
  useEffect(() => {
    if (enabled) return;
    if (phaseRef.current === "recording") void finish();
    else if (phaseRef.current === "starting") cancelStart();
  }, [cancelStart, enabled, finish]);

  useEffect(
    () => () => {
      if (phaseRef.current === "recording") void finish();
      else cancelStart();
    },
    [cancelStart, finish],
  );

  return { phase, level, toggle, dictating: dictatingRef.current };
}

/** A small badge over the pane while the host microphone is live. */
export function TerminalRemoteMicIndicator({
  mic,
}: {
  mic: TerminalRemoteMic;
}) {
  if (mic.phase === "idle") return null;
  const label =
    mic.phase === "starting"
      ? t("Starting the host microphone…")
      : mic.phase === "stopping"
        ? mic.dictating
          ? t("Transcribing with Claude Code…")
          : t("Sending to the agent…")
        : t("Host microphone on");
  return (
    <div
      className={`terminal-remote-mic is-${mic.phase}`}
      role="status"
      aria-live="polite"
      style={{ "--remote-mic-level": mic.level } as CSSProperties}
    >
      <span className="terminal-remote-mic-icon" aria-hidden="true">
        {mic.phase === "recording" ? (
          <Mic size={14} />
        ) : (
          <LoaderCircle size={14} className="terminal-remote-mic-spin" />
        )}
      </span>
      <span className="terminal-remote-mic-label">{label}</span>
      {mic.phase !== "stopping" ? (
        <IconButton
          size="sm"
          label={shortcutTitle(
            mic.phase === "starting"
              ? t("Cancel")
              : mic.dictating
                ? t("Stop and paste into the pane")
                : t("Stop and send to the agent"),
            "terminal.remoteMic",
          )}
          icon={<Square size={12} />}
          onMouseDown={(event) => event.preventDefault()}
          onClick={mic.toggle}
        />
      ) : null}
    </div>
  );
}
