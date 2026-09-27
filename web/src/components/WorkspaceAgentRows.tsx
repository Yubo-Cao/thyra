import { useRef } from "react";
import { useLongPress } from "./useLongPress";
import {
  focusTreeItem,
  keyboardContextMenuPoint,
  treeKeyboardAction,
} from "./treeKeyboard";
import { useWorkspaceCan } from "../capabilities";
import { store, useStoreSelector } from "../store";
import type { Pane } from "../types";
import { formatMemoryLimit, shortId } from "../utils";
import { agentStatusText } from "../agentOrder";
import { t } from "../i18n";
import {
  customTabLabel,
  paneDisplayName,
  paneLocationName,
} from "../paneIdentity";
import {
  agentStateKind,
  shouldShowAgentStatusLabel,
  type AgentStateKind,
} from "./agentSession";
import { AgentStatusIcon } from "./AgentStatusIcon";
import { PanePresence } from "./PanePresence";
import { TREE_DEPTH_INDENT } from "./treeIndent";
import { ContextMenu } from "./ui/ContextMenu";
import { Token, type TokenTone } from "./ui/Token";
import "./WorkspaceAgentRows.css";

const AGENT_STATUS_TONES: Record<AgentStateKind, TokenTone> = {
  working: "warning",
  blocked: "danger",
  done: "success",
  idle: "accent",
  unknown: "neutral",
};

/** Token tone for an agent status label (rows, the history header). */
export function agentStatusTone(status?: string): TokenTone {
  return AGENT_STATUS_TONES[agentStateKind(status)];
}

export interface AgentMenuState {
  pane: Pane;
  x: number;
  y: number;
}

export function AgentRow({
  pane,
  selected,
  depth = 0,
  showPaneId,
  variant = "nested",
  workspaceLabel,
  onSelect,
  onOpenMenu,
  drag,
}: {
  pane: Pane;
  selected: boolean;
  depth?: number;
  showPaneId: boolean;
  variant?: "nested" | "standalone";
  workspaceLabel?: string;
  onSelect?: (pane: Pane) => void;
  onOpenMenu: (x: number, y: number) => void;
  drag?: {
    isDragging: boolean;
    dropPosition: "before" | "after" | null;
    onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
    onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragEnd: () => void;
  };
}) {
  const tab = useStoreSelector((state) =>
    state.tabs.find(
      (candidate) =>
        candidate.tab_id === pane.tab_id &&
        candidate.workspace_id === pane.workspace_id,
    ),
  );
  const tabLabel = customTabLabel(tab?.label);
  const openMenu = (x: number, y: number) => {
    onOpenMenu(x, y);
  };
  const longPress = useLongPress(openMenu);
  const showStatus = shouldShowAgentStatusLabel(pane.agent_status);
  const nested = variant === "nested";
  const locationName = paneLocationName(pane);
  const name = paneDisplayName(pane, {
    tabLabel,
    tabPaneCount: tab?.pane_count,
  });
  const agentName = pane.agent ?? "Agent";

  return (
    <div
      className={`agent-row ${nested ? "is-nested" : "is-standalone"} ${
        selected ? "is-selected" : ""
      } ${pane.focused ? "is-focused" : ""} ${
        drag?.isDragging ? "is-dragging" : ""
      } ${drag?.dropPosition ? `drop-${drag.dropPosition}` : ""}`}
      style={
        nested ? { paddingLeft: 18 + depth * TREE_DEPTH_INDENT } : undefined
      }
      role={nested ? "treeitem" : "button"}
      data-pane-id={pane.pane_id}
      draggable={!!drag}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      tabIndex={nested ? (selected ? 0 : -1) : 0}
      aria-level={nested ? depth + 1 : undefined}
      aria-selected={nested ? selected : undefined}
      aria-pressed={nested ? undefined : selected}
      onClick={(e) => {
        if (longPress.consumeClick(e)) return;
        void store.focusPane(pane.pane_id);
        onSelect?.(pane);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const action = treeKeyboardAction(event.key, event.shiftKey);
        if (!action) return;
        if (
          nested &&
          (action === "next" ||
            action === "previous" ||
            action === "first" ||
            action === "last")
        ) {
          event.preventDefault();
          focusTreeItem(event.currentTarget, action);
          return;
        }
        if (nested && (action === "expand" || action === "collapse")) {
          event.preventDefault();
          focusTreeItem(
            event.currentTarget,
            action === "expand" ? "next" : "previous",
          );
          return;
        }
        if (action !== "activate" && action !== "context-menu") return;
        event.preventDefault();
        event.stopPropagation();
        if (action === "activate") {
          void store.focusPane(pane.pane_id);
          onSelect?.(pane);
        } else {
          const point = keyboardContextMenuPoint(event.currentTarget);
          openMenu(point.x, point.y);
        }
      }}
      {...longPress.handlers}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
      title={[name, agentName, pane.pane_id, tabLabel, pane.cwd]
        .filter(Boolean)
        .join(" · ")}
      aria-label={
        tabLabel
          ? t("{name}, {agent} pane {pane}, tab {tab}, status {status}", {
              name,
              agent: agentName,
              pane: pane.pane_id,
              tab: tabLabel,
              status: agentStatusText(pane.agent_status),
            })
          : t("{name}, {agent} pane {pane}, status {status}", {
              name,
              agent: agentName,
              pane: pane.pane_id,
              status: agentStatusText(pane.agent_status),
            })
      }
    >
      <AgentStatusIcon agent={pane.agent} status={pane.agent_status} />
      <div className="agent-info">
        <div className="agent-title">
          <span className="agent-title-label">
            {nested ? name : (workspaceLabel ?? pane.workspace_id)}
          </span>
          {pane.memory_incident ? (
            <Token
              tone="danger"
              className="agent-row-status"
              title={
                pane.memory_incident.processes === 1
                  ? t(
                      "The kernel killed {count} process in this pane at its {limit} memory limit",
                      {
                        count: pane.memory_incident.processes,
                        limit: formatMemoryLimit(
                          pane.memory_incident.limit_bytes,
                        ),
                      },
                    )
                  : t(
                      "The kernel killed {count} processes in this pane at its {limit} memory limit",
                      {
                        count: pane.memory_incident.processes,
                        limit: formatMemoryLimit(
                          pane.memory_incident.limit_bytes,
                        ),
                      },
                    )
              }
            >
              {t("killed")}
            </Token>
          ) : null}
          {showStatus ? (
            <Token
              tone={agentStatusTone(pane.agent_status)}
              className="agent-row-status"
            >
              {agentStatusText(pane.agent_status)}
            </Token>
          ) : null}
          <PanePresence paneIds={[pane.pane_id]} />
          {showPaneId ? (
            <Token code className="agent-row-id" title={pane.pane_id}>
              {shortId(pane.pane_id)}
            </Token>
          ) : null}
        </div>
        {!nested ? (
          <div className="agent-sub muted">
            {[
              name,
              tabLabel && tabLabel !== name ? tabLabel : "",
              locationName !== name ? locationName : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AgentContextMenu({
  state,
  onClose,
  onFocus,
  onBrowseFiles,
  onReviewChanges,
  onViewHistory,
  onExportSession,
  onClosePane,
}: {
  state: AgentMenuState | null;
  onClose: () => void;
  onFocus: (pane: Pane) => void;
  onBrowseFiles?: (pane: Pane) => void;
  onReviewChanges?: (pane: Pane) => void;
  onViewHistory?: (pane: Pane) => void;
  onExportSession: (pane: Pane) => void;
  onClosePane: (pane: Pane) => void;
}) {
  // The last pane keeps the menu's content while it animates closed.
  const lastPaneRef = useRef<Pane | null>(null);
  if (state) lastPaneRef.current = state.pane;
  const pane = lastPaneRef.current;
  const canEdit = useWorkspaceCan(pane?.workspace_id, "edit");
  if (!pane) return null;

  const paneName = paneDisplayName(pane);
  const locationName = paneLocationName(pane);
  return (
    <ContextMenu
      position={state ? { x: state.x, y: state.y } : null}
      onClose={onClose}
      aria-label={t("Pane actions")}
      header={{
        title: paneName,
        subtitle: [
          pane.agent ?? t("Agent"),
          pane.pane_id,
          agentStatusText(pane.agent_status),
          locationName && locationName !== paneName ? locationName : "",
        ]
          .filter(Boolean)
          .join(" · "),
      }}
      items={[
        {
          title: t("Open"),
          items: [
            {
              id: "open-terminal",
              label: t("Open terminal"),
              onAction: () => onFocus(pane),
            },
            {
              id: "browse-files",
              label: t("Browse files at agent CWD"),
              onAction: () => onBrowseFiles?.(pane),
            },
            {
              id: "review-changes",
              label: t("Review workspace changes"),
              onAction: () => onReviewChanges?.(pane),
            },
          ],
        },
        {
          title: t("Session"),
          items: [
            {
              id: "view-history",
              label: t("View agent history"),
              onAction: () => onViewHistory?.(pane),
            },
            {
              id: "export-session",
              label: t("Export session"),
              onAction: () => onExportSession(pane),
            },
          ],
        },
        ...(canEdit
          ? [
              {
                title: t("Pane"),
                danger: true,
                items: [
                  {
                    id: "close-pane",
                    label: t("Close pane"),
                    onAction: () => onClosePane(pane),
                  },
                ],
              },
            ]
          : []),
      ]}
    />
  );
}
