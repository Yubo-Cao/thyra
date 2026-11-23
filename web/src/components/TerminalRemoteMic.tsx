import { LoaderCircle, Mic, Square } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { t } from "../i18n";
import { shortcutMatches, shortcutTitle } from "../shortcutPreferences";
import {
  REMOTE_MIC_HOLD_MS,
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
 * virtual default source and presses the agent's voice key in the pane
 * (Claude Code's tap-mode `voice:pushToTalk`). The second press keeps
 * streaming briefly so the last words reach the host, presses the key again
 * (the agent stops and sends), then releases the mic.
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
  onError,
}: {
  /** The active pane, and the caller may type into it. */
  enabled: boolean;
  container: HTMLElement | null;
  connectionId: string;
  terminalId: () => string | null;
  pressVoiceKey: (terminalId: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [phase, setPhase] = useState<RemoteMicPhase>("idle");
  const [level, setLevel] = useState(0);
  const phaseRef = useRef<RemoteMicPhase>("idle");
  const sessionRef = useRef<RemoteMicSession | null>(null);
  /** The terminal whose agent was started, to stop the same one. */
  const keyTerminalRef = useRef<string | null>(null);
  const runRef = useRef(0);
  const latest = useRef({ connectionId, terminalId, pressVoiceKey, onError });
  latest.current = { connectionId, terminalId, pressVoiceKey, onError };

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

  const finish = useCallback(async () => {
    if (phaseRef.current !== "recording") return;
    const run = runRef.current;
    set("stopping");
    // The last syllables are still on their way to the host.
    await delay(REMOTE_MIC_TAIL_MS);
    const terminal = keyTerminalRef.current;
    keyTerminalRef.current = null;
    if (terminal) await pressKey(terminal);
    await delay(REMOTE_MIC_HOLD_MS);
    const session = sessionRef.current;
    sessionRef.current = null;
    await session?.stop();
    if (runRef.current === run) set("idle");
  }, []);

  const cancelStart = useCallback(() => {
    runRef.current++;
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
          onLevel: (value) => {
            if (runRef.current === run) setLevel(value);
          },
          onEnd: (message) => {
            if (runRef.current !== run) return;
            latest.current.onError(message);
            // Stop the agent's recording too, as the second press would.
            const pressed = keyTerminalRef.current;
            keyTerminalRef.current = null;
            sessionRef.current = null;
            set("idle");
            if (pressed) void pressKey(pressed);
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
          const pressed = await pressKey(terminal);
          if (runRef.current !== run) {
            // Cancelled while the key was on its way: stop the agent again.
            if (pressed) void pressKey(terminal);
            return;
          }
          if (!pressed) {
            cancelStart();
            return;
          }
          keyTerminalRef.current = terminal;
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
  }, [cancelStart]);

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

  return { phase, level, toggle };
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
        ? t("Sending to the agent…")
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
