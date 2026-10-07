import "./TerminalHistory.css";
import { ArrowDownToLine } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConnectionClient } from "../../api";
import { TerminalEngine } from "../../terminalEngine";
import { t } from "../../i18n";
import { Button } from "../ui/Button";
import { applyTerminalFollowScale } from "./terminalSession";

/** Herdr's pane.read returns at most this many lines. */
const HISTORY_LINES = 1000;

/**
 * A read-only viewer's own copy of a pane's scrollback. Herdr keeps one
 * history position per pane, shared by everyone watching it, so a viewer
 * never scrolls Herdr: it reads the history once (`terminal.history`, a
 * passive snapshot) and browses it here, over the live terminal, until it
 * scrolls back to the bottom, presses Escape or chooses Back to live.
 */
export function TerminalHistory({
  client,
  paneId,
  live,
  follow,
  lines,
  onClose,
}: {
  client: ConnectionClient;
  paneId: string;
  /** The live terminal, whose size, font and colors the copy uses. */
  live: TerminalEngine;
  /** The live terminal is scaled to another device's size. */
  follow: boolean;
  /** How many lines above the bottom to open at. */
  lines: number;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new TerminalEngine(element, {
      ...live.options,
      scrollback: HISTORY_LINES + live.rows,
      disableStdin: true,
      cursorBlink: false,
    });
    term.resize(live.cols, live.rows);
    applyTerminalFollowScale(term, element, follow);
    let ready = false;
    let disposed = false;
    const atBottom = () =>
      term.buffer.active.viewportY >= term.buffer.active.baseY;
    const scrolled = term.onScroll(() => {
      if (ready && atBottom()) close.current();
    });
    Promise.all([
      client.call("terminal.history", {
        pane_id: paneId,
        lines: HISTORY_LINES,
      }),
      term.ready,
    ]).then(
      ([result]: [{ text?: unknown } | null, void]) => {
        if (disposed) return;
        const text = typeof result?.text === "string" ? result.text : "";
        // Lines end in CRLF already; hide the snapshot's cursor.
        term.write(
          `${text.replace(/\r?\n/g, "\r\n").replace(/\s+$/, "")}\x1b[?25l`,
          () => {
            if (disposed) return;
            setLoading(false);
            term.scrollToBottom();
            term.scrollLines(-Math.max(1, lines));
            ready = true;
            // Nothing above the screen: there is no history to browse.
            if (atBottom()) close.current();
            else element.focus({ preventScroll: true });
          },
        );
      },
      (failure: unknown) => {
        if (disposed) return;
        setLoading(false);
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    const onKey = (event: KeyboardEvent) => {
      const page = Math.max(1, term.rows - 1);
      const moves: Record<string, () => void> = {
        Escape: () => close.current(),
        PageUp: () => term.scrollLines(-page),
        PageDown: () => term.scrollLines(page),
        ArrowUp: () => term.scrollLines(-1),
        ArrowDown: () => term.scrollLines(1),
        Home: () => term.scrollToTop(),
        End: () => close.current(),
      };
      const move = moves[event.key];
      if (!move) return;
      event.preventDefault();
      event.stopPropagation();
      move();
    };
    element.addEventListener("keydown", onKey);
    return () => {
      disposed = true;
      element.removeEventListener("keydown", onKey);
      scrolled.dispose();
      term.dispose();
    };
  }, [client, paneId, live, follow, lines]);

  return (
    <div className="terminal-history" role="region" aria-label={t("History")}>
      <div
        ref={host}
        className="terminal-view terminal-history-view"
        tabIndex={-1}
      />
      {loading || error ? (
        <div className="terminal-history-status" role="status">
          {error || t("Loading history")}
        </div>
      ) : null}
      <Button
        variant="secondary"
        className="terminal-history-live"
        onClick={() => close.current()}
      >
        <ArrowDownToLine size={14} aria-hidden="true" />
        {t("Back to live")}
      </Button>
    </div>
  );
}
