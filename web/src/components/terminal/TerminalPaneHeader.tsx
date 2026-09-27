import {
  Columns2,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  MousePointer2,
  Rows2,
  SquareTerminal,
  X,
} from "lucide-react";
import type { PointerEvent } from "react";
import { agentStatusText } from "../../agentOrder";
import { t } from "../../i18n";
import { store } from "../../store";
import { copyTextFromUserGesture } from "../../terminalClipboard";
import type { Pane } from "../../types";
import type { usePaneControl } from "../../usePaneControl";
import { agentClass } from "../../utils";
import { shouldShowAgentStatusLabel } from "../agentSession";
import { AgentStatusIcon } from "../AgentStatusIcon";
import { terminalConfirmDialog } from "../lazyPanels";
import {
  type TerminalVoiceTyping,
  TerminalVoiceButton,
} from "../TerminalVoiceTyping";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Token } from "../ui/Token";

const preventPaneActionFocus = (e: PointerEvent<HTMLElement>) => {
  e.preventDefault();
  e.currentTarget.blur();
};

async function copyPaneId(paneId: string) {
  try {
    await copyTextFromUserGesture(paneId);
    store.notify({
      kind: "success",
      message: t("Pane ID copied"),
      detail: paneId,
      autoDismissMs: 2500,
    });
  } catch (error) {
    store.notify({
      kind: "error",
      message: t("Could not copy pane ID"),
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The pane's identity, layout control, and split/zoom/close actions. */
export function TerminalPaneHeader({
  pane,
  paneName,
  isActivePane,
  control,
  voiceTyping,
  voiceTypingDisabledReason,
  paneZoomed,
  canClosePane,
  endpointAvailable,
  onClosePane,
}: {
  pane: Pane;
  paneName: string;
  isActivePane: boolean;
  control: ReturnType<typeof usePaneControl>;
  voiceTyping: TerminalVoiceTyping;
  voiceTypingDisabledReason: string | null;
  paneZoomed: boolean;
  canClosePane: boolean;
  endpointAvailable: boolean;
  onClosePane: () => void;
}) {
  const { access } = control;
  const scrollReason =
    endpointAvailable && store.terminalScrollReason(pane.terminal_id);
  return (
    <>
      <div
        className={`terminal-pane-head ui-bar ${isActivePane ? "is-active" : ""}`}
      >
        <div className="terminal-pane-identity" title={pane.cwd ?? paneName}>
          {pane.agent ? (
            <AgentStatusIcon agent={pane.agent} status={pane.agent_status} />
          ) : (
            <SquareTerminal
              className="terminal-pane-shell-icon"
              size={14}
              aria-hidden="true"
            />
          )}
          <span className="terminal-pane-name">{paneName}</span>
          <Token
            code
            className="terminal-pane-id"
            role="button"
            tabIndex={0}
            title={t("Pane {paneId} - click to copy", {
              paneId: pane.pane_id,
            })}
            aria-label={t("Copy pane ID {paneId}", { paneId: pane.pane_id })}
            onPointerDown={preventPaneActionFocus}
            onClick={() => void copyPaneId(pane.pane_id)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              void copyPaneId(pane.pane_id);
            }}
          >
            {pane.pane_id}
          </Token>
          {pane.agent && shouldShowAgentStatusLabel(pane.agent_status) ? (
            <span
              className={`${agentClass(pane.agent_status)} terminal-pane-status`}
            >
              {agentStatusText(pane.agent_status)}
            </span>
          ) : null}
        </div>
        <span className="ui-bar-spacer" />
        {scrollReason ? (
          <Token tone="warning" role="status" title={scrollReason}>
            {t("No history")}
          </Token>
        ) : null}
        <div className="pane-control" aria-label={t("Pane control")}>
          {access.viewOnly ? (
            <Token tone="info" icon={<Eye size={11} />}>
              {t("Viewing")}
            </Token>
          ) : access.ownsLayout ? (
            <Token
              tone="accent"
              icon={<MousePointer2 size={11} />}
              title={t(
                "You control this pane's layout. Collaborators can still type.",
              )}
            >
              {t("Layout")}
            </Token>
          ) : null}
          {!access.ownsLayout || access.viewOnly ? (
            <Button
              disabled={control.busy || access.protectedUntil > Date.now()}
              onPointerDown={preventPaneActionFocus}
              onClick={control.takeControl}
              title={
                access.protectedUntil > Date.now()
                  ? t("Another collaborator has protected layout control")
                  : access.ownerName
                    ? t(
                        "{owner} controls layout. Take layout control for 15 seconds; collaborators can still type",
                        { owner: access.ownerName },
                      )
                    : t(
                        "Take layout control for 15 seconds; collaborators can still type",
                      )
              }
            >
              <MousePointer2 size={13} />
              <span>{t("Take control")}</span>
            </Button>
          ) : null}
          <Button
            icon
            aria-pressed={access.viewOnly}
            onPointerDown={preventPaneActionFocus}
            onClick={access.viewOnly ? control.takeControl : control.watch}
            disabled={control.busy}
            title={
              access.viewOnly
                ? t("Stop viewing and take control")
                : t("View only: stop sending input and resizing this pane")
            }
            aria-label={access.viewOnly ? t("Stop viewing") : t("View only")}
          >
            {access.viewOnly ? <EyeOff size={14} /> : <Eye size={14} />}
          </Button>
        </div>
        <div className="terminal-pane-toolbar" aria-label={t("Pane actions")}>
          <TerminalVoiceButton
            voice={voiceTyping}
            className="terminal-pane-action"
            iconSize={14}
            disabledReason={voiceTypingDisabledReason}
          />
          {!paneZoomed ? (
            <>
              <IconButton
                className="terminal-pane-action"
                disabled={access.viewOnly}
                label={t("Split pane right")}
                onPointerDown={preventPaneActionFocus}
                onClick={() => store.splitPane(pane.pane_id, "right")}
                icon={<Columns2 size={14} />}
              />
              <IconButton
                className="terminal-pane-action"
                disabled={access.viewOnly}
                label={t("Split pane down")}
                onPointerDown={preventPaneActionFocus}
                onClick={() => store.splitPane(pane.pane_id, "down")}
                icon={<Rows2 size={14} />}
              />
            </>
          ) : null}
          {canClosePane || paneZoomed ? (
            <IconButton
              className="terminal-pane-action"
              disabled={access.viewOnly}
              label={paneZoomed ? t("Restore pane") : t("Maximize pane")}
              onPointerDown={preventPaneActionFocus}
              onClick={() => store.zoomPane(pane.pane_id)}
              icon={
                paneZoomed ? <Minimize2 size={14} /> : <Maximize2 size={14} />
              }
            />
          ) : null}
          {canClosePane ? (
            <IconButton
              className="terminal-pane-action"
              tone="danger"
              disabled={access.viewOnly}
              label={t("Close pane")}
              onPointerEnter={() => void terminalConfirmDialog.preload()}
              onPointerDown={preventPaneActionFocus}
              onClick={onClosePane}
              icon={<X size={14} />}
            />
          ) : null}
        </div>
      </div>
      {control.error ? (
        <div className="pane-control-error" role="alert">
          {control.error}
        </div>
      ) : null}
    </>
  );
}
