import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  AgentSessionInfo,
  AgentSessionStatus,
} from "../../../../shared/agentSession";
import { selectPanesWithoutActivity } from "../../agentOrder";
import {
  type AgentSessionStore,
  connectAgentSession,
  createAgentSessionStore,
} from "../../agentSession/session";
import { agentSessionTransport } from "../../agentSessions";
import { useHostCapable, useWorkspaceCan } from "../../capabilities";
import { t } from "../../i18n";
import { useLayoutPreferences } from "../../layoutPreferences";
import { paneDisplayName } from "../../paneIdentity";
import { paneCanClose } from "../../paneJump";
import { noteTerminalOutput } from "../../startupGate";
import { store, useStoreSelector } from "../../store";
import { useConnectionClient } from "../../useConnectionClient";
import { Latched } from "../LazyBoundary";
import { terminalConfirmDialog } from "../lazyPanels";
import { usePaneSwipe } from "../terminal/paneSwipe";
import { TerminalPaneHeader } from "../terminal/TerminalPaneHeader";
import type { TerminalWorkspaceFileRequest } from "../terminal/terminalSession";
import { Spinner } from "../ui/Spinner";
import { Token, type TokenTone } from "../ui/Token";
import { AgentApprovals } from "./AgentApprovals";
import { AgentComposer, AgentMeta } from "./AgentComposer";
import { AgentViewContext } from "./AgentItems";
import { AgentTranscript, type AgentTranscriptHandle } from "./AgentTranscript";
import "./AgentView.css";

const ConfirmDialog = terminalConfirmDialog.Component;

/** The app's `--mobile-floating-controls-lift` and what it lifts from. */
const CONTROLS_LIFT = "--mobile-floating-controls-lift";
const CONTROLS_LIFT_DEFAULT = 112;
const CONTROLS_BOTTOM = 58;

/**
 * The mobile layout's floating controls keep their usual place over the
 * transcript, and rise above the dock when it grows past them (an open
 * approval request), so they never cover its answers.
 */
function useControlsAboveDock(dock: HTMLElement | null, enabled: boolean) {
  useEffect(() => {
    const app = dock?.closest<HTMLElement>(".app");
    if (!dock || !app || !enabled) return;
    const update = () => {
      const lift = dock.offsetHeight + 12 - CONTROLS_BOTTOM;
      if (lift > CONTROLS_LIFT_DEFAULT)
        app.style.setProperty(CONTROLS_LIFT, `${lift}px`);
      else app.style.removeProperty(CONTROLS_LIFT);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(dock);
    return () => {
      observer.disconnect();
      app.style.removeProperty(CONTROLS_LIFT);
    };
  }, [dock, enabled]);
}

/** The pane header's status dot, in the vocabulary agent panes already use. */
const PANE_STATUS: Record<AgentSessionStatus, string> = {
  starting: "working",
  running: "working",
  awaiting_approval: "blocked",
  idle: "idle",
  exited: "unknown",
};

function SessionStatus({ info }: { info: AgentSessionInfo }) {
  const [tone, label]: [TokenTone, string] | [null, null] =
    info.status === "starting"
      ? ["neutral", t("Starting")]
      : info.status === "running"
        ? ["warning", t("Working")]
        : info.status === "awaiting_approval"
          ? ["danger", t("Needs approval")]
          : info.status === "exited"
            ? info.error
              ? ["danger", t("Ended with an error")]
              : ["neutral", t("Ended")]
            : [null, null];
  return tone ? (
    <Token tone={tone} role="status">
      {label}
    </Token>
  ) : null;
}

/** Follow `paneId`'s session while connected; the store outlives reconnects. */
function useAgentSession(paneId: string): AgentSessionStore {
  const client = useConnectionClient();
  const connected = useStoreSelector(
    (state) => state.status === "connected" && !state.connectionPaused,
  );
  // Rises when subscriptions were lost with the socket (terminals reattach).
  const epoch = useStoreSelector((state) => state.terminalAttachEpoch);
  const [session] = useState(createAgentSessionStore);
  useEffect(() => {
    void epoch;
    return connected
      ? connectAgentSession(agentSessionTransport(client), paneId, session)
      : undefined;
  }, [client, connected, epoch, paneId, session]);
  return session;
}

/**
 * A pane's agent session as an application view: the transcript, open
 * approval requests, and the prompt box, under the pane's usual header.
 */
export function AgentView({
  paneId,
  onOpenWorkspaceFile,
}: {
  paneId: string;
  onOpenWorkspaceFile?: (request: TerminalWorkspaceFileRequest) => void;
}) {
  const s = useStoreSelector(
    useShallow((state) => {
      const panes = selectPanesWithoutActivity(state);
      const pane = panes.find((item) => item.pane_id === paneId);
      const tab = state.tabs.find((item) => item.tab_id === pane?.tab_id);
      const selected =
        state.selectedPaneId &&
        state.layout?.panes.some(
          (item) => item.pane_id === state.selectedPaneId,
        )
          ? state.selectedPaneId
          : state.layout?.focused_pane_id;
      return {
        pane,
        tabLabel: tab?.label,
        tabPaneCount: tab?.pane_count,
        active: selected === paneId,
        zoomed:
          state.layout?.zoomed === true &&
          state.layout.focused_pane_id === paneId,
        canClose: paneCanClose(panes, paneId),
        connectionId: state.activeConnectionId,
        connectionGeneration: state.connectionGeneration,
      };
    }),
  );
  const { pane } = s;
  const client = useConnectionClient();
  const session = useAgentSession(paneId);
  const info = useStore(session, (view) => view.session?.info);
  const error = useStore(session, (view) => view.error);
  const canEdit = useWorkspaceCan(pane?.workspace_id, "edit");
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  usePaneSwipe(root);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  useControlsAboveDock(dock, useLayoutPreferences().mobile && s.active);
  const transcript = useRef<AgentTranscriptHandle | null>(null);
  const [closing, setClosing] = useState(false);
  // The first snapshot is this pane's first output: startup work may run.
  const loaded = info !== undefined;
  useEffect(() => {
    if (loaded) noteTerminalOutput();
  }, [loaded]);

  const actions = useMemo(() => {
    const transport = agentSessionTransport(client);
    const call = (
      method: string,
      params: Record<string, unknown>,
      failure: string,
    ) =>
      transport.call(method, { pane_id: paneId, ...params }).catch((reason) => {
        store.notify({
          kind: "error",
          message: failure,
          detail: reason instanceof Error ? reason.message : String(reason),
        });
        throw reason;
      });
    return {
      send: (text: string) =>
        call("agent_session.send", { text }, t("Could not send the prompt")),
      interrupt: () =>
        void call(
          "agent_session.interrupt",
          {},
          t("Could not stop the agent"),
        ).catch(() => {}),
      approve: (approvalId: string, optionId: string) =>
        call(
          "agent_session.approve",
          { approval_id: approvalId, option_id: optionId },
          t("Could not answer the request"),
        ),
      setMode: (mode: string) =>
        void call(
          "agent_session.set_mode",
          { mode },
          t("Could not change the mode"),
        ).catch(() => {}),
    };
  }, [client, paneId]);

  // Rows share which of them are open; the map lives as long as the view, so
  // a row that scrolls out of the mounted window comes back as it was left.
  const [expanded] = useState(() => new Map<string, boolean>());
  const workspaceId = pane?.workspace_id;
  const cwd = info?.cwd;
  // Files open in the Inspector, which instance admins have.
  const host = useHostCapable();
  const rows = useMemo(
    () => ({
      expanded,
      onOpenFile:
        host && onOpenWorkspaceFile && workspaceId
          ? (path: string) =>
              onOpenWorkspaceFile({
                connectionId: s.connectionId,
                connectionGeneration: s.connectionGeneration,
                workspaceId,
                paneId,
                // Agents name files from their working directory.
                path:
                  cwd && !/^(?:[/~]|[A-Za-z]:[\\/])/.test(path)
                    ? `${cwd.replace(/[\\/]$/, "")}/${path}`
                    : path,
              })
          : undefined,
    }),
    [
      cwd,
      expanded,
      host,
      onOpenWorkspaceFile,
      paneId,
      s.connectionId,
      s.connectionGeneration,
      workspaceId,
    ],
  );

  if (!pane) return null;
  return (
    <div ref={setRoot} className="terminal-shell agent-view">
      <TerminalPaneHeader
        pane={{
          ...pane,
          agent: info?.kind ?? pane.agent,
          agent_status: info ? PANE_STATUS[info.status] : pane.agent_status,
        }}
        paneName={paneDisplayName(pane, {
          tabLabel: s.tabLabel,
          tabPaneCount: s.tabPaneCount,
        })}
        isActivePane={s.active}
        readOnly={!canEdit}
        paneZoomed={s.zoomed}
        canClosePane={s.canClose}
        endpointAvailable={false}
        onClosePane={() => setClosing(true)}
        agentView="agent"
        status={info ? <SessionStatus info={info} /> : null}
      />
      {info ? (
        <AgentViewContext.Provider value={rows}>
          <AgentTranscript ref={transcript} store={session} />
          <div ref={setDock} className="agent-dock">
            <AgentApprovals
              store={session}
              onAnswer={canEdit ? actions.approve : undefined}
            />
            {info.status === "exited" && info.error ? (
              <div className="agent-ended" role="alert">
                {info.error}
              </div>
            ) : null}
            {canEdit ? (
              <AgentComposer
                draftKey={`${s.connectionId}\n${paneId}`}
                info={info}
                active={s.active}
                onSend={(text) => {
                  transcript.current?.showLatest();
                  return actions.send(text);
                }}
                onInterrupt={actions.interrupt}
                onSetMode={actions.setMode}
                onPage={(direction) => transcript.current?.page(direction)}
              />
            ) : (
              <AgentMeta info={info} />
            )}
          </div>
        </AgentViewContext.Provider>
      ) : (
        <div className="agent-loading" role="status">
          <Spinner size="sm" />
          {error ?? t("Loading the session")}
        </div>
      )}
      <Latched open={closing}>
        <ConfirmDialog
          open={closing}
          onOpenChange={setClosing}
          title={t("Close Pane")}
          message={t("Close this pane and end its agent session?")}
          confirmLabel={t("Close")}
          tone="danger"
          onConfirm={() => store.closePane(paneId)}
        />
      </Latched>
    </div>
  );
}
