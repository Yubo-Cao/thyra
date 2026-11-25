import { REMOTE_MIC_CLOSE, REMOTE_MIC_PATH } from "../../../shared/remoteMic";
import type { TerminalKey } from "../../../shared/terminalKey";
import { t } from "../i18n";

/**
 * The key Thyra holds in the pane for the agent's own voice input. Claude
 * Code binds it with `"f12": "voice:pushToTalk"` in the Chat context of
 * ~/.claude/keybindings.json, in hold mode (`voice.mode: "hold"`, with
 * `voice.autoSubmit: true` to send on release). Tap mode refuses to start
 * once the prompt has text; hold mode starts on the first press of a
 * non-character key and stops 200 ms after the last repeat.
 * Ctrl+M itself cannot be that key: terminals send it as Enter.
 */
export const REMOTE_MIC_VOICE_KEY: TerminalKey = { key: "F", fn: 12, mods: 0 };

/** How often the held voice key repeats; Claude Code lets go after 200 ms. */
export const REMOTE_MIC_REPEAT_MS = 80;
/** Audio sent after the stop press is decided, before the key is let go. */
export const REMOTE_MIC_TAIL_MS = 300;
/** The source stays up this long after letting go, while the agent stops. */
export const REMOTE_MIC_HOLD_MS = 500;

export type RemoteMicSession = {
  /** Flush the last frames, close the stream and release the mic. */
  stop: () => Promise<void>;
  /** Release everything at once. */
  cancel: () => void;
};

export type RemoteMicCallbacks = {
  onLevel: (level: number) => void;
  /** The stream ended without `stop`/`cancel`; the message says why. */
  onEnd: (message: string) => void;
};

export function remoteMicUrl(
  location: Pick<Location, "protocol" | "host">,
  connectionId: string,
  terminalId: string,
): string {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const query = new URLSearchParams({
    connection_id: connectionId,
    terminal_id: terminalId,
  });
  return `${protocol}://${location.host}${REMOTE_MIC_PATH}?${query}`;
}

/** Why the bridge ended a stream, for a toast. */
export function remoteMicCloseMessage(code: number, reason: string): string {
  switch (code) {
    case REMOTE_MIC_CLOSE.superseded:
      return t("Another page is now using the host microphone.");
    case REMOTE_MIC_CLOSE.idle:
      return t("The host microphone stopped: no audio arrived.");
    case REMOTE_MIC_CLOSE.shutdown:
      return t("The host microphone stopped: Thyra is restarting.");
    default:
      return reason || t("The connection to the host microphone was lost.");
  }
}
