import { useMemo, useState, memo } from "react";
import {
  Brain,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Info,
  Wrench,
} from "lucide-react";
import { useStoreSelector } from "../store";
import type { Pane } from "../types";
import { t } from "../i18n";
import { uiIntlLocale } from "../uiLocale";
import { copyTextWithFeedback } from "../copyText";
import { useConnectionClient } from "../useConnectionClient";
import { shortId } from "../utils";
import { paneDisplayName } from "../paneIdentity";
import { AgentIcon } from "./AgentIcon";
import { CodePreview } from "./CodePreview";
import {
  type AgentSessionTrajectoryStep,
  type AgentSessionTurn,
  type AgentSessionSummary,
  downloadSession,
  downloadSessionAtif,
  firstLinePreview,
  formatBytes,
  formatCount,
  formatOptionalCompact,
  formatTokenTotal,
  groupTrajectoryTurns,
  toolArgumentsPreview,
} from "./agentSession";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { IconButton } from "./ui/IconButton";
import { Menu } from "./ui/Menu";
import { Tabs } from "./ui/Tabs";
import { Token } from "./ui/Token";
import "./AgentSessionPreviewDialog.css";

function formatStepTime(timestamp?: string) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString(uiIntlLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSessionTime(timestamp?: string) {
  if (!timestamp) return "-";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString(uiIntlLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function stepMetricText(steps: AgentSessionTrajectoryStep[]) {
  const latest: NonNullable<AgentSessionTrajectoryStep["metrics"]> = {};
  for (const step of steps) {
    if (!step.metrics) continue;
    if (step.metrics.prompt_tokens !== undefined) {
      latest.prompt_tokens = step.metrics.prompt_tokens;
    }
    if (step.metrics.cached_tokens !== undefined) {
      latest.cached_tokens = step.metrics.cached_tokens;
    }
    if (step.metrics.completion_tokens !== undefined) {
      latest.completion_tokens = step.metrics.completion_tokens;
    }
  }
  return [
    latest.prompt_tokens !== undefined
      ? t("Input {count}", {
          count: formatOptionalCompact(latest.prompt_tokens),
        })
      : "",
    latest.cached_tokens !== undefined
      ? t("Cached {count}", {
          count: formatOptionalCompact(latest.cached_tokens),
        })
      : "",
    latest.completion_tokens !== undefined
      ? t("Output {count}", {
          count: formatOptionalCompact(latest.completion_tokens),
        })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function meaningfulMessage(step: AgentSessionTrajectoryStep) {
  if (!step.message || (step.metrics && step.message === "Token usage"))
    return "";
  return step.message;
}

type SessionView = "timeline" | "atif" | "raw";

/** Turns, tokens, and last update of a session, with the token breakdown. */
export function SessionOverview({
  summary,
  tokensLabel,
  updated,
  updatedTitle,
  reasoning = false,
}: {
  summary: AgentSessionSummary;
  tokensLabel: string;
  updated: string;
  updatedTitle?: string;
  reasoning?: boolean;
}) {
  const usage = summary.stats.token_usage;
  const counts = [
    t("Input {count}", { count: formatOptionalCompact(usage?.input_tokens) }),
    t("Cached {count}", {
      count: formatOptionalCompact(usage?.cached_input_tokens),
    }),
    t("Output {count}", { count: formatOptionalCompact(usage?.output_tokens) }),
    ...(reasoning
      ? [
          t("Reasoning {count}", {
            count: formatOptionalCompact(usage?.reasoning_output_tokens),
          }),
        ]
      : []),
  ];
  return (
    <section
      className="agent-session-overview"
      aria-label={t("Session overview")}
    >
      <div>
        <strong>{formatCount(summary.stats.turns)}</strong>
        <span>{t("Turns")}</span>
      </div>
      <div>
        <strong>{formatTokenTotal(summary)}</strong>
        <span>{tokensLabel}</span>
      </div>
      <div>
        <strong title={updatedTitle}>{updated}</strong>
        <span>{t("Updated")}</span>
      </div>
      <p>{counts.join(" · ")}</p>
    </section>
  );
}

/**
 * Where an agent pane lives: its workspace, the pane's own name, and its ID.
 * The agent icon beside it already names the agent, so the agent's name is
 * never repeated here.
 */
export function AgentPaneIdentity({
  pane,
  workspaceLabel,
}: {
  pane: Pane;
  workspaceLabel: string;
}) {
  const paneId = shortId(pane.pane_id);
  const paneName = paneDisplayName(pane);
  return (
    <span className="agent-pane-identity">
      <span title={workspaceLabel}>{workspaceLabel}</span>
      {paneName !== paneId ? <span title={paneName}>{paneName}</span> : null}
      <Token code title={pane.pane_id}>
        {paneId}
      </Token>
    </span>
  );
}

export function AgentSessionPreviewDialog({
  pane,
  summary,
  loading,
  error,
  onClose,
}: {
  pane: Pane | null;
  summary: AgentSessionSummary | null;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const connectionClient = useConnectionClient();
  const [mode, setMode] = useState<SessionView>("timeline");
  // The last pane stays rendered while the dialog animates closed.
  const [shownPane, setShownPane] = useState(pane);
  if (pane && pane !== shownPane) setShownPane(pane);
  // Every opening starts on the Timeline.
  const [openedPaneId, setOpenedPaneId] = useState(pane?.pane_id);
  if (pane?.pane_id !== openedPaneId) {
    setOpenedPaneId(pane?.pane_id);
    if (pane) setMode("timeline");
  }
  const turns = useMemo(
    () => groupTrajectoryTurns(summary?.trajectory?.steps ?? []),
    [summary?.trajectory?.steps],
  );

  const current = pane ?? shownPane;
  if (!current) return null;

  const workspaceLabel =
    workspaces.find(
      (workspace) => workspace.workspace_id === current.workspace_id,
    )?.label ?? current.workspace_id;
  const text = summary?.text ?? "";
  const atifText = summary?.trajectory
    ? JSON.stringify(summary.trajectory, null, 2)
    : "";
  const unavailableDetail =
    error ||
    summary?.detail ||
    t("No readable session transcript was reported for this agent.");

  return (
    <Dialog
      open={!!pane}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("Session Inspector")}
      description={
        <AgentPaneIdentity pane={current} workspaceLabel={workspaceLabel} />
      }
      headerStart={<AgentIcon agent={current.agent} />}
      closeLabel={t("Close Session Inspector")}
      size="lg"
      busy={loading}
      className="agent-session-dialog"
      bodyClassName="agent-session-body"
    >
      {summary?.status === "ok" ? (
        <>
          <SessionOverview
            summary={summary}
            tokensLabel={t("Total tokens")}
            updated={formatSessionTime(summary.updated_at)}
            updatedTitle={formatSessionTime(summary.updated_at)}
            reasoning
          />
          <div className="agent-session-file-row">
            <div>
              <span>{t("Session file")}</span>
              <code title={summary.path}>{summary.path}</code>
            </div>
            <span>
              {t("{records} records · {size}", {
                records: formatCount(summary.stats.records),
                size: formatBytes(summary.file?.size),
              })}
            </span>
            <IconButton
              label={t("Copy session file path")}
              tooltip={t("Copy path")}
              icon={<Copy size={13} />}
              onClick={() => void copyTextWithFeedback(summary.path)}
            />
          </div>
        </>
      ) : null}

      {loading ? (
        <div className="agent-session-state">
          <span className="terminal-loading-dot" />
          {t("Loading session")}
        </div>
      ) : summary?.status !== "ok" || error ? (
        <div className="agent-session-state is-error">
          <strong>{t("Session unavailable")}</strong>
          <span>{unavailableDetail}</span>
          {summary?.command ? <code>{summary.command}</code> : null}
        </div>
      ) : (
        <>
          <div className="agent-session-actions">
            <Tabs
              className="agent-session-tabs"
              aria-label={t("Session Inspector view")}
              value={mode}
              onChange={setMode}
              items={[
                { id: "timeline", label: t("Timeline") },
                { id: "atif", label: "ATIF" },
                { id: "raw", label: t("Raw") },
              ]}
            />
            <Menu
              aria-label={t("Export")}
              placement="bottom end"
              trigger={
                <Button variant="secondary">
                  <Download size={14} />
                  {t("Export")}
                </Button>
              }
              items={[
                {
                  id: "atif",
                  label: t("Export ATIF"),
                  onAction: () =>
                    downloadSessionAtif(
                      current,
                      summary.session?.value || summary.path,
                      connectionClient,
                    ),
                },
                {
                  id: "raw",
                  label: t("Export raw"),
                  onAction: () => downloadSession(current, connectionClient),
                },
              ]}
            />
          </div>
          {summary.truncated ? (
            <div className="file-preview-banner">
              {t("Preview truncated. Export raw to get the full session file.")}
            </div>
          ) : null}
          <div className="agent-session-content">
            {mode === "timeline" ? (
              <SessionTimeline turns={turns} />
            ) : mode === "atif" ? (
              atifText ? (
                <CodePreview text={atifText} language="json" />
              ) : (
                <div className="agent-session-state">
                  {t("No ATIF trajectory available.")}
                </div>
              )
            ) : (
              <CodePreview text={text} language="jsonl" />
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}

function SessionTimeline({ turns }: { turns: AgentSessionTurn[] }) {
  if (turns.length === 0) {
    return (
      <div className="agent-session-state">
        {t("No timeline items. Switch to Raw to inspect the session file.")}
      </div>
    );
  }

  return (
    <div className="agent-session-timeline">
      {turns.map((turn) => (
        <SessionTurn turn={turn} key={turn.key} />
      ))}
    </div>
  );
}

// The timeline subscribes to the global store higher up, so it re-renders on
// every unrelated app update. Turn objects are stable (memoized on the
// trajectory steps), making each turn cheap to skip.
const SessionTurn = memo(function SessionTurn({
  turn,
}: {
  turn: AgentSessionTurn;
}) {
  const metrics = stepMetricText(turn.steps);
  const firstTimestamp = turn.steps.find((step) => step.timestamp)?.timestamp;
  // Match tool results back to their calls so output rows can carry the tool
  // name regardless of which step reported the call.
  const toolNameById = new Map<string, string>();
  for (const step of turn.steps) {
    for (const tool of step.tool_calls ?? []) {
      toolNameById.set(tool.tool_call_id, tool.function_name);
    }
  }

  return (
    <article className="agent-session-turn">
      <header>
        <div>
          <strong>
            {turn.number === null
              ? t("Session setup")
              : t("Turn {number}", { number: turn.number })}
          </strong>
          {firstTimestamp ? (
            <time>{formatStepTime(firstTimestamp)}</time>
          ) : null}
        </div>
        <span>
          {turn.steps.length === 1
            ? t("1 event")
            : t("{count} events", { count: turn.steps.length })}
        </span>
      </header>
      <div className="agent-session-turn-body">
        {turn.steps.map((step) => (
          <SessionStepRows
            step={step}
            toolNameById={toolNameById}
            key={step.step_id}
          />
        ))}
        {metrics ? <footer>{metrics}</footer> : null}
      </div>
    </article>
  );
});

// Render one trajectory step in place so the timeline follows the actual
// execution order: reasoning, messages, tool calls and their results appear
// exactly where they happened instead of being regrouped by type.
function SessionStepRows({
  step,
  toolNameById,
}: {
  step: AgentSessionTrajectoryStep;
  toolNameById: Map<string, string>;
}) {
  const message = meaningfulMessage(step);
  const reasoning =
    step.reasoning_content && step.reasoning_content !== message
      ? step.reasoning_content
      : "";
  const observations = step.observation?.results ?? [];
  return (
    <>
      {reasoning ? (
        <details className="agent-session-turn-details">
          <summary>
            <ChevronRight size={12} className="agent-session-details-icon" />
            <Brain size={12} />
            <span>{t("Reasoning")}</span>
            <small>{firstLinePreview(reasoning)}</small>
          </summary>
          <pre>{reasoning}</pre>
        </details>
      ) : null}
      {step.source === "user" && message ? (
        <section className="agent-session-exchange is-user">
          <span>{t("Prompt")}</span>
          <pre>{message}</pre>
        </section>
      ) : null}
      {step.source === "agent" && message ? (
        <section className="agent-session-exchange is-agent">
          <span>{t("Response")}</span>
          <pre>{message}</pre>
        </section>
      ) : null}
      {(step.tool_calls ?? []).map((tool) => (
        <details className="agent-session-turn-details" key={tool.tool_call_id}>
          <summary>
            <ChevronRight size={12} className="agent-session-details-icon" />
            <Wrench size={12} />
            <span>{tool.function_name}</span>
            <small>
              {toolArgumentsPreview(
                tool.arguments,
                typeof tool.extra?.description === "string"
                  ? tool.extra.description
                  : undefined,
              )}
            </small>
          </summary>
          <div className="agent-session-tool-list">
            <code>
              <strong>{tool.function_name}</strong>
              {JSON.stringify(tool.arguments, null, 2)}
            </code>
          </div>
        </details>
      ))}
      {observations.map((result, index) => (
        <details
          className="agent-session-turn-details"
          key={`${result.source_call_id ?? "result"}:${index}`}
        >
          <summary>
            <ChevronRight size={12} className="agent-session-details-icon" />
            <FileText size={12} />
            <span>
              {(result.source_call_id &&
                toolNameById.get(result.source_call_id)) ||
                t("Tool output")}
            </span>
            <small>{firstLinePreview(result.content ?? "")}</small>
          </summary>
          <div className="agent-session-observation-list">
            <pre>{result.content}</pre>
          </div>
        </details>
      ))}
      {step.source === "system" && message && observations.length === 0 ? (
        <details className="agent-session-turn-details">
          <summary>
            <ChevronRight size={12} className="agent-session-details-icon" />
            <Info size={12} />
            <span>{t("System")}</span>
            <small>{firstLinePreview(message)}</small>
          </summary>
          <pre>{message}</pre>
        </details>
      ) : null}
    </>
  );
}
