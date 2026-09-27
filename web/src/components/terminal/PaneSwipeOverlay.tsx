import { ChevronRight } from "lucide-react";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../../i18n";
import { customTabLabel, paneDisplayName } from "../../paneIdentity";
import { store } from "../../store";
import type { Pane } from "../../types";
import { shortId } from "../../utils";
import { AgentIcon } from "../AgentIcon";
import { Token } from "../ui/Token";
import "./PaneSwipeOverlay.css";

const VISIBLE_MS = 1200;
let root: Root | null = null;
let hideTimer = 0;

/** Briefly names the pane a swipe moved to: workspace › tab › pane. */
export function showPaneSwipeOverlay(pane: Pane) {
  const { workspaces, tabs } = store.get();
  const workspace = workspaces.find(
    (item) => item.workspace_id === pane.workspace_id,
  );
  const tab = tabs.find((item) => item.tab_id === pane.tab_id);
  if (!root) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  const chevron = <ChevronRight size={14} aria-hidden="true" />;
  root.render(
    <div className="pane-swipe-overlay" role="status">
      <span>{workspace?.label ?? shortId(pane.workspace_id)}</span>
      {chevron}
      <span>
        {customTabLabel(tab?.label) ||
          t("Tab {number}", { number: tab?.number ?? shortId(pane.tab_id) })}
      </span>
      {chevron}
      {pane.agent ? <AgentIcon agent={pane.agent} compact /> : null}
      <strong>
        {paneDisplayName(pane, {
          tabLabel: tab?.label,
          tabPaneCount: tab?.pane_count,
        })}
      </strong>
      <Token code>{shortId(pane.pane_id)}</Token>
    </div>,
  );
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => root?.render(null), VISIBLE_MS);
}
