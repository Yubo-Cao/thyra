import {
  AlignLeft,
  Columns2,
  Eye,
  EyeOff,
  Keyboard,
  Maximize2,
  Minimize2,
  MonitorCheck,
  MousePointer2,
  Rows2,
  Scaling,
  SquareTerminal,
  TextCursorInput,
  X,
} from "lucide-react";
import type { TerminalPreviewMode } from "./TerminalPreview";
import type { PointerEvent } from "react";
import { agentStatusText } from "../../agentOrder";
import { t } from "../../i18n";
import { shortcutTitle } from "../../shortcutPreferences";
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
  previewMode,
  onPreviewModeChange,
  promptEditor,
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
  /** How an input-only device previews the pane. */
  previewMode?: TerminalPreviewMode;
  onPreviewModeChange?: (mode: TerminalPreviewMode) => void;
  /** The desktop prompt editor toggle, on agent panes this viewer may type in. */
  promptEditor?: { open: boolean; toggle: () => void };
}) {
  const { access } = control;
  // Another device sizes this pane: offer typing here without resizing it.
  const foreignDisplay = !!access.display && !access.display.mine;
  const displayName = access.display?.name ?? t("another device");
  const pinnedHere = access.display?.mine === true && access.display.pinned;
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
          ) : access.inputOnly ? (
            <Token
              tone="accent"
              icon={<Keyboard size={11} />}
              title={t("You type here; {device} keeps the pane size", {
                device: displayName,
              })}
            >
              {t("Typing")}
            </Token>
          ) : access.ownsLayout ? (
            <Token
              tone="accent"
              icon={<MousePointer2 size={11} />}
              title={t(
                "You control this pane. Others watch until they take control.",
              )}
            >
              {t("In control")}
            </Token>
          ) : null}
          {!access.readOnly &&
          foreignDisplay &&
          (!access.ownsLayout || access.viewOnly) ? (
            <Button
              variant={access.display?.active ? "primary" : "ghost"}
              disabled={control.busy || access.protectedUntil > Date.now()}
              onPointerDown={preventPaneActionFocus}
              onClick={control.typeHere}
              title={t("Type here, keep size on {device}", {
                device: displayName,
              })}
              aria-label={t("Type here, keep size on {device}", {
                device: displayName,
              })}
            >
              <Keyboard size={13} />
              <span>{t("Type here")}</span>
            </Button>
          ) : null}
          {!access.readOnly &&
          foreignDisplay &&
          (!access.ownsLayout || access.viewOnly || access.inputOnly) ? (
            <Button
              variant={
                access.display?.active || access.inputOnly ? "ghost" : "primary"
              }
              disabled={control.busy || access.protectedUntil > Date.now()}
              onPointerDown={preventPaneActionFocus}
              onClick={control.takeControl}
              title={t("Take control and resize here")}
              aria-label={t("Take control and resize here")}
            >
              <Scaling size={13} />
              <span>{t("Resize here")}</span>
            </Button>
          ) : null}
          {!access.readOnly &&
          !foreignDisplay &&
          (!access.ownsLayout || access.viewOnly) ? (
            <Button
              disabled={control.busy || access.protectedUntil > Date.now()}
              onPointerDown={preventPaneActionFocus}
              onClick={control.takeControl}
              title={
                access.protectedUntil > Date.now()
                  ? t("Another collaborator has protected control")
                  : access.ownerName
                    ? t(
                        "{owner} controls this pane. Take control; it stays yours for at least 15 seconds",
                        { owner: access.ownerName },
                      )
                    : t(
                        "Take control of this pane; it stays yours for at least 15 seconds",
                      )
              }
            >
              <MousePointer2 size={13} />
              <span>{t("Take control")}</span>
            </Button>
          ) : null}
          {/* Viewers (and share-link guests) only watch: no pane controls. */}
          {access.readOnly ? null : (
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
          )}
          {access.inputOnly && onPreviewModeChange ? (
            <IconButton
              aria-pressed={previewMode === "text"}
              onPointerDown={preventPaneActionFocus}
              onClick={() =>
                onPreviewModeChange(previewMode === "text" ? "screen" : "text")
              }
              label={
                previewMode === "text"
                  ? t("Show the screen preview")
                  : t("Show the last lines as text")
              }
              icon={<AlignLeft size={14} />}
            />
          ) : null}
          {access.readOnly ? null : (
            <IconButton
              aria-pressed={pinnedHere}
              disabled={control.busy || access.viewOnly}
              onPointerDown={preventPaneActionFocus}
              onClick={() => void control.toggleDisplayPin()}
              label={
                pinnedHere
                  ? t("Stop keeping this pane sized for this device")
                  : t("Display on this device: keep this pane sized for it")
              }
              icon={<MonitorCheck size={14} />}
            />
          )}
        </div>
        <div
          className="terminal-pane-toolbar"
          aria-label={t("Pane actions")}
          style={access.readOnly ? { display: "none" } : undefined}
        >
          {promptEditor ? (
            <IconButton
              className="terminal-pane-action"
              aria-pressed={promptEditor.open}
              label={shortcutTitle(
                promptEditor.open
                  ? t("Hide prompt editor")
                  : t("Show prompt editor"),
                "promptEditor.toggle",
              )}
              onPointerDown={preventPaneActionFocus}
              onClick={promptEditor.toggle}
              icon={<TextCursorInput size={14} />}
            />
          ) : null}
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
