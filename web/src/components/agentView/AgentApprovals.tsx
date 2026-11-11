import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useStore } from "zustand";
import type {
  AgentApproval,
  AgentApprovalOption,
} from "../../../../shared/agentSession";
import type { AgentSessionStore } from "../../agentSession/session";
import { t } from "../../i18n";
import { Button, type ButtonVariant } from "../ui/Button";
import { DiffView } from "./AgentItems";

const NO_APPROVALS: readonly AgentApproval[] = [];

const OPTION_VARIANT: Record<AgentApprovalOption["kind"], ButtonVariant> = {
  allow: "primary",
  allow_always: "secondary",
  deny: "danger-soft",
};

function Approval({
  store,
  approval,
  onAnswer,
}: {
  store: AgentSessionStore;
  approval: AgentApproval;
  /** Absent for viewers, who see the request but cannot answer it. */
  onAnswer?: (approvalId: string, optionId: string) => Promise<unknown>;
}) {
  // The tool call in question, so the decision needs no scrolling back.
  const tool = useStore(store, (view) => {
    const item = approval.item_id
      ? view.session?.items[approval.item_id]
      : undefined;
    return item?.type === "tool" ? item : undefined;
  });
  const [answering, setAnswering] = useState(false);
  return (
    <section className="agent-approval" aria-label={approval.title}>
      <div className="agent-approval-title">
        <ShieldAlert size={15} aria-hidden="true" />
        <strong>{approval.title}</strong>
      </div>
      {/* Scrolls when the pane is short; the answers below stay in view. */}
      <div className="agent-approval-body">
        {approval.detail ? (
          <p className="agent-approval-detail">{approval.detail}</p>
        ) : null}
        {tool?.command ? (
          <pre className="agent-approval-command">{tool.command}</pre>
        ) : null}
        {tool?.diffs?.map((diff, index) => (
          <DiffView key={`${index}:${diff.path}`} diff={diff} />
        ))}
      </div>
      {onAnswer ? (
        <div className="agent-approval-actions">
          {approval.options.map((option) => (
            <Button
              key={option.id}
              size="md"
              variant={OPTION_VARIANT[option.kind] ?? "secondary"}
              disabled={answering}
              onClick={() => {
                setAnswering(true);
                // On success the block leaves with `approval_resolved`.
                void onAnswer(approval.id, option.id).catch(() =>
                  setAnswering(false),
                );
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : (
        <p className="agent-approval-detail">
          {t("Waiting for someone who can answer.")}
        </p>
      )}
    </section>
  );
}

/** Open approval requests, pinned above the composer until answered. */
export function AgentApprovals({
  store,
  onAnswer,
}: {
  store: AgentSessionStore;
  onAnswer?: (approvalId: string, optionId: string) => Promise<unknown>;
}) {
  const approvals = useStore(
    store,
    (view) => view.session?.approvals ?? NO_APPROVALS,
  );
  if (!approvals.length) return null;
  return (
    <div
      className="agent-approvals"
      role="region"
      aria-label={t("Approval requests")}
      aria-live="polite"
    >
      {approvals.map((approval) => (
        <Approval
          key={approval.id}
          store={store}
          approval={approval}
          onAnswer={onAnswer}
        />
      ))}
    </div>
  );
}
