import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConnectionClient } from "../../api";
import { thyraLocalStorage } from "../../browserStorage";
import { t } from "../../i18n";

/**
 * How a device that types into a pane another device displays previews it:
 * `screen` scales the live terminal down at a reduced frame rate, `text`
 * shows the last lines as plain text and receives no frames at all.
 */
export type TerminalPreviewMode = "screen" | "text";

const PREVIEW_MODE_KEY = "terminalPreviewMode";
/** An input-only preview gets at most one frame per second. */
export const INPUT_ONLY_FRAME_INTERVAL_MS = 1000;
const TEXT_PREVIEW_LINES = 60;
const TEXT_PREVIEW_POLL_MS = 1500;

export function loadTerminalPreviewMode(): TerminalPreviewMode {
  return thyraLocalStorage.getItem(PREVIEW_MODE_KEY) === "text"
    ? "text"
    : "screen";
}

export function saveTerminalPreviewMode(mode: TerminalPreviewMode) {
  thyraLocalStorage.setItem(PREVIEW_MODE_KEY, mode);
}

/** The text of a `terminal.preview_text` reply, or null for anything else. */
export function previewText(result: unknown): string | null {
  const text = (result as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text.replace(/\r/g, "") : null;
}

/**
 * The last lines of a pane, polled through the bridge (which reads Herdr's
 * passive snapshot) while the page is visible. Refreshes soon after
 * `inputEpoch` changes (the user sent input).
 */
export function TerminalTextPreview({
  client,
  paneId,
  inputEpoch,
}: {
  client: ConnectionClient;
  paneId: string;
  inputEpoch: number;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const scroller = useRef<HTMLPreElement | null>(null);
  const followBottom = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      timer = null;
      if (cancelled) return;
      if (document.visibilityState === "visible" && client.isCurrent()) {
        try {
          const next = previewText(
            await client.call("terminal.preview_text", {
              pane_id: paneId,
              lines: TEXT_PREVIEW_LINES,
            }),
          );
          if (cancelled) return;
          if (next !== null) setText(next.replace(/\s+$/, ""));
          setError("");
        } catch (failure) {
          if (cancelled) return;
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        }
      }
      if (!cancelled) timer = setTimeout(poll, TEXT_PREVIEW_POLL_MS);
    };
    // Soon after input, the pane has usually echoed it.
    timer = setTimeout(poll, inputEpoch === 0 ? 0 : 250);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, paneId, inputEpoch]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && followBottom.current)
      element.scrollTop = element.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={scroller}
      className="terminal-text-preview"
      aria-label={t("Last lines of the pane")}
      aria-live="off"
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        followBottom.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      {text ?? (error || t("Loading terminal"))}
    </pre>
  );
}
