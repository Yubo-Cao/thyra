import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { workspaceCan } from "../capabilities";
import { t } from "../i18n";
import { store, useStoreSelector, useEndpointCreationReason } from "../store";
import { AgentStatusIcon } from "./AgentStatusIcon";
import { PanePresence } from "./PanePresence";
import { summarizeTabAgents } from "./agentSession";
import { requestCloseTab, tabName } from "./TabBar";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { IconButton } from "./ui/IconButton";
import { useShallow } from "zustand/react/shallow";

/**
 * Bottom-sheet tab switcher for narrow layouts. The tab strip hides itself on
 * mobile when a workspace has a single tab, so this sheet is the touch
 * affordance for creating, switching, and closing tabs there.
 */
export function MobileTabSheet({
  open,
  onClose,
  onShowSession,
}: {
  open: boolean;
  onClose: () => void;
  onShowSession: () => void;
}) {
  const s = useStoreSelector(
    useShallow((state) => ({
      panes: state.panes,
      tabs: state.tabs,
      workspaces: state.workspaces,
    })),
  );
  const transitionPendingRef = useRef(false);
  const [transitionPending, setTransitionPending] = useState(false);

  // A switch or create in flight keeps the sheet open until it lands.
  const closeIfIdle = () => {
    if (!transitionPendingRef.current) onClose();
  };

  const runTabTransition = async (operation: () => Promise<unknown>) => {
    if (transitionPendingRef.current) return;
    transitionPendingRef.current = true;
    setTransitionPending(true);
    try {
      await operation();
      onClose();
      onShowSession();
    } finally {
      transitionPendingRef.current = false;
      setTransitionPending(false);
    }
  };

  const focusedWs = s.workspaces.find((w) => w.focused);
  const canEdit = workspaceCan(focusedWs, "edit");
  const createReason = useEndpointCreationReason(
    "tab.create",
    focusedWs?.workspace_id,
  );
  const tabs = focusedWs
    ? s.tabs
        .filter((tab) => tab.workspace_id === focusedWs.workspace_id)
        .sort((a, b) => a.number - b.number)
    : [];

  return (
    <Dialog
      open={open && !!focusedWs}
      onOpenChange={(next) => {
        if (!next) closeIfIdle();
      }}
      title={t("Tabs")}
      closeLabel={t("Close tab switcher")}
      busy={transitionPending}
      className="mobile-tab-sheet"
      footer={
        focusedWs ? (
          <Button
            variant="secondary"
            fullWidth
            title={createReason ?? undefined}
            disabled={transitionPending || !!createReason}
            onClick={() =>
              void runTabTransition(() =>
                store.createTab(focusedWs.workspace_id),
              )
            }
          >
            <Plus size={15} />
            <span>{createReason ?? t("New Tab")}</span>
          </Button>
        ) : null
      }
    >
      <div className="mobile-tab-sheet-list" role="list">
        {tabs.map((tab) => {
          const name = tabName(tab);
          const agentSummary = summarizeTabAgents(s.panes, tab.tab_id);
          return (
            <div key={tab.tab_id} role="listitem">
              <Button
                fullWidth
                className="mobile-tab-sheet-focus"
                aria-current={tab.focused || undefined}
                disabled={transitionPending}
                onClick={() =>
                  void runTabTransition(() => store.focusTab(tab.tab_id))
                }
              >
                {agentSummary ? (
                  <span
                    className="tabbar-agent-marker"
                    aria-label={t("{agent}, status {status}", {
                      agent: agentSummary.primaryAgent,
                      status: agentSummary.status,
                    })}
                  >
                    <AgentStatusIcon
                      agent={agentSummary.primaryAgent}
                      status={agentSummary.status}
                    />
                    {agentSummary.additionalAgents > 0 ? (
                      <span className="tabbar-agent-more">
                        +{agentSummary.additionalAgents}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                <span className="mobile-tab-sheet-name">{name}</span>
                <PanePresence
                  paneIds={s.panes
                    .filter((pane) => pane.tab_id === tab.tab_id)
                    .map((pane) => pane.pane_id)}
                />
              </Button>
              {canEdit ? (
                <IconButton
                  label={t("Close {name}", { name })}
                  icon={<X size={14} />}
                  disabled={transitionPending}
                  onClick={() => {
                    // The close confirmation lives in the app shell, which
                    // this modal sheet makes inert: close the sheet first.
                    closeIfIdle();
                    requestCloseTab(tab.tab_id);
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
