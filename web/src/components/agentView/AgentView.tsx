import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  AgentPromptDelivery,
  AgentPromptImage,
  AgentQueuedPrompt,
  AgentSessionInfo,
  AgentSessionStatus,
} from "../../../../shared/agentSession";
import { selectPanesWithoutActivity } from "../../agentOrder";
import { storedSessions } from "../../agentSession/history";
import { preparePromptImage } from "../../agentSession/promptImageFile";
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
import {
  agentComposerDraftKey,
  clearTerminalComposerDraft,
  readTerminalComposerDraft,
  writeTerminalComposerDraft,
} from "../../terminalComposer";
import { uploadTerminalImage } from "../../terminalImageUpload";
import { useConnectionClient } from "../../useConnectionClient";
import { promptDraftImageUrl, workspaceFileUrl } from "../../workspaceFileUrl";
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
import { AgentQueue } from "./AgentQueue";
import { AgentResume } from "./AgentResume";
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

/** A page hidden this long stops receiving the transcript. */
const HIDDEN_UNSUBSCRIBE_MS = 30_000;

/** False once the page has been hidden for a while; true again when shown. */
function usePageShown(): boolean {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    let timer = 0;
    const update = () => {
      window.clearTimeout(timer);
      if (!document.hidden) setShown(true);
      else timer = window.setTimeout(setShown, HIDDEN_UNSUBSCRIBE_MS, false);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return shown;
}

/**
 * Follow `paneId`'s session while connected and on screen. The store outlives
 * reconnects, so the transcript stays up while a fresh snapshot is fetched.
 */
function useAgentSession(paneId: string): AgentSessionStore {
  const client = useConnectionClient();
  const connected = useStoreSelector(
    (state) => state.status === "connected" && !state.connectionPaused,
  );
  // Rises when subscriptions were lost with the socket (terminals reattach).
  const epoch = useStoreSelector((state) => state.terminalAttachEpoch);
  const shown = usePageShown();
  const [session] = useState(createAgentSessionStore);
  useEffect(() => {
    void epoch;
    return connected && shown
      ? connectAgentSession(agentSessionTransport(client), paneId, session)
      : undefined;
  }, [client, connected, epoch, paneId, session, shown]);
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
  const epoch = useStore(session, (view) => view.session?.epoch ?? 0);
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
    const request = (method: string, params: Record<string, unknown>) =>
      transport.call(method, { pane_id: paneId, ...params });
    const call = (
      method: string,
      params: Record<string, unknown>,
      failure: string,
    ) =>
      request(method, params).catch((reason) => {
        store.notify({
          kind: "error",
          message: failure,
          detail: reason instanceof Error ? reason.message : String(reason),
        });
        throw reason;
      });
    const quietly =
      (method: string, failure: string) =>
      (params: Record<string, unknown> = {}) =>
        void call(method, params, failure).catch(() => {});
    return {
      send: (
        text: string,
        images: AgentPromptImage[],
        delivery?: AgentPromptDelivery,
      ) =>
        call(
          "agent_session.send",
          {
            text,
            ...(images.length ? { images } : {}),
            ...(delivery ? { delivery } : {}),
          },
          t("Could not send the prompt"),
        ),
      unqueue: (promptId: string) =>
        call(
          "agent_session.unqueue",
          { prompt_id: promptId },
          t("Could not take the prompt back"),
        ),
      // An image for a prompt: made small enough here, then put on the host.
      upload: async (file: File) => {
        const prepared = await preparePromptImage(file);
        return (
          transport.uploadImage?.(prepared) ??
          uploadTerminalImage(client, prepared)
        );
      },
      /** Where an image at `path` on the host loads from. */
      imageUrl: (workspaceId: string, path: string) =>
        transport.imageUrl?.(path) ??
        workspaceFileUrl(client, workspaceId, path, { inline: true }),
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
      meta: {
        onSetMode: (mode: string) =>
          quietly(
            "agent_session.set_mode",
            t("Could not change the mode"),
          )({
            mode,
          }),
        onSetModel: (model: string) =>
          quietly(
            "agent_session.set_model",
            t("Could not change the model"),
          )({
            model,
          }),
        onSetEffort: (effort: string) =>
          quietly(
            "agent_session.set_effort",
            t("Could not change the reasoning effort"),
          )({ effort }),
        onCompact: () =>
          quietly(
            "agent_session.compact",
            t("Could not compact the conversation"),
          )(),
      },
      // Neither notifies: the list is an offer that may be missing, and a
      // refused resume reads on its row.
      history: () => request("agent_session.history", {}).then(storedSessions),
      resume: (sessionId: string) =>
        request("agent_session.resume", { session_id: sessionId }),
    };
  }, [client, paneId]);

  // Rows share which of them are open; the map lives as long as the
  // conversation is on screen, so a row that scrolls out of the mounted
  // window comes back as it was left.
  const expanded = useMemo(() => {
    void epoch;
    return new Map<string, boolean>();
  }, [epoch]);
  const workspaceId = pane?.workspace_id;
  const cwd = info?.cwd;
  const draftKey = agentComposerDraftKey(s.connectionId, paneId);
  // Files open in the Inspector, which instance admins have.
  const host = useHostCapable();
  const rows = useMemo(
    () => ({
      expanded,
      imageUrl: workspaceId
        ? (path: string) => actions.imageUrl(workspaceId, path)
        : undefined,
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
      actions,
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

  // Taken back into the box, ahead of what is typed there.
  const editQueued = async (prompt: AgentQueuedPrompt) => {
    await actions.unqueue(prompt.id);
    const typed = readTerminalComposerDraft(draftKey);
    writeTerminalComposerDraft(
      draftKey,
      typed.trim() ? `${prompt.text}\n\n${typed}` : prompt.text,
    );
  };

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
          <div className="agent-body">
            {/* Another conversation's transcript starts over, at its end. */}
            <AgentTranscript key={epoch} ref={transcript} store={session}>
              {canEdit && info.can_resume && info.status !== "exited" ? (
                <AgentResume
                  info={info}
                  load={actions.history}
                  onResume={actions.resume}
                />
              ) : null}
            </AgentTranscript>
            <div ref={setDock} className="agent-dock">
              <AgentApprovals
                store={session}
                onAnswer={canEdit ? actions.approve : undefined}
              />
              <AgentQueue
                queued={info.queued ?? []}
                onRemove={
                  canEdit
                    ? (prompt) =>
                        void actions.unqueue(prompt.id).catch(() => {})
                    : undefined
                }
                onEdit={
                  canEdit
                    ? (prompt) => void editQueued(prompt).catch(() => {})
                    : undefined
                }
              />
              {info.status === "exited" && info.error ? (
                <div className="agent-ended" role="alert">
                  {info.error}
                </div>
              ) : null}
              {canEdit ? (
                <AgentComposer
                  key={draftKey}
                  draftKey={draftKey}
                  info={info}
                  active={s.active}
                  epoch={epoch}
                  imageUrl={(source) =>
                    workspaceId
                      ? promptDraftImageUrl(
                          client,
                          workspaceId,
                          info.cwd,
                          source,
                        )
                      : null
                  }
                  onSend={(text, images) => {
                    transcript.current?.showLatest();
                    return actions.send(text, images);
                  }}
                  onUploadImage={actions.upload}
                  onInterrupt={actions.interrupt}
                  meta={actions.meta}
                  onPage={(direction) => transcript.current?.page(direction)}
                />
              ) : (
                <AgentMeta info={info} />
              )}
            </div>
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
          onConfirm={() => {
            clearTerminalComposerDraft(draftKey);
            return store.closePane(paneId);
          }}
        />
      </Latched>
    </div>
  );
}
