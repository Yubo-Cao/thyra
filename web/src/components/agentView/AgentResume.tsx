import { History } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type {
  AgentSessionInfo,
  AgentStoredSession,
} from "../../../../shared/agentSession";
import { HISTORY_PREVIEW, storedSessionAge } from "../../agentSession/history";
import { t } from "../../i18n";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";

const NONE: readonly AgentStoredSession[] = [];

/**
 * The agent's stored conversations for the session's working directory, as
 * an offer under an empty transcript: choosing one continues it here. Asked
 * for once per session, never polled; with nothing stored, or when the list
 * cannot be read, nothing shows.
 */
export function AgentResume({
  info,
  load,
  onResume,
}: {
  info: AgentSessionInfo;
  load: () => Promise<AgentStoredSession[]>;
  /** Rejects with the host's reason when it refuses. */
  onResume: (sessionId: string) => Promise<unknown>;
}) {
  const [sessions, setSessions] = useState(NONE);
  const [all, setAll] = useState(false);
  // The conversation asked for: being resumed, or refused for `refused`.
  const [chosen, setChosen] = useState<{ id: string; refused?: string } | null>(
    null,
  );
  const heading = useId();
  const list = useRef<HTMLUListElement | null>(null);

  // Another agent process or conversation in the pane has another list.
  const { started_at: startedAt, agent_session_id: conversation } = info;
  useEffect(() => {
    void startedAt;
    void conversation;
    let current = true;
    load()
      .catch(() => NONE)
      .then((next) => {
        if (!current) return;
        setSessions(next);
        setChosen(null);
      });
    return () => {
      current = false;
    };
  }, [load, startedAt, conversation]);

  // "Show more" leaves with its press: the focus moves to what it revealed.
  useEffect(() => {
    const rows = list.current?.querySelectorAll<HTMLElement>("button");
    if (all) rows?.[HISTORY_PREVIEW]?.focus();
  }, [all]);

  if (!sessions.length) return null;
  // A resume that succeeded stays pending until its transcript replaces this.
  const resuming = chosen && chosen.refused === undefined ? chosen.id : null;
  const disabled = resuming !== null || info.status !== "idle";
  const shown = all ? sessions : sessions.slice(0, HISTORY_PREVIEW);
  return (
    <section className="agent-resume" aria-labelledby={heading}>
      <div id={heading} className="agent-resume-title">
        <History size={13} aria-hidden="true" />
        {t("Continue a previous conversation")}
      </div>
      <ul ref={list} className="agent-resume-list">
        {shown.map((session) => {
          const title = session.title.trim() || t("Untitled conversation");
          return (
            <li key={session.id}>
              <Button
                fullWidth
                className="agent-resume-row"
                disabled={disabled}
                aria-busy={resuming === session.id || undefined}
                onClick={() => {
                  setChosen({ id: session.id });
                  onResume(session.id).catch((reason) =>
                    setChosen({
                      id: session.id,
                      refused:
                        reason instanceof Error
                          ? reason.message
                          : String(reason),
                    }),
                  );
                }}
              >
                {/* On the text, not the row: shown on hover, for a cut title. */}
                <span className="agent-row-title" title={title}>
                  {title}
                </span>
                {resuming === session.id ? (
                  <Spinner size="sm" label={t("Loading the conversation")} />
                ) : (
                  <span className="agent-resume-age">
                    {storedSessionAge(session.updated_at)}
                  </span>
                )}
              </Button>
              {chosen?.id === session.id && chosen.refused !== undefined ? (
                <p className="agent-resume-refused" role="alert">
                  {t("Could not continue this conversation: {reason}", {
                    reason: chosen.refused,
                  })}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {sessions.length > shown.length ? (
        <Button className="agent-resume-more" onClick={() => setAll(true)}>
          {t("Show {count} more", { count: sessions.length - shown.length })}
        </Button>
      ) : null}
    </section>
  );
}
