import { ChevronDown, CircleAlert } from "lucide-react";
import { type ButtonHTMLAttributes, forwardRef, useState } from "react";
import type { ConnectionSummary } from "../api";
import {
  connectionLifecycleLabel,
  connectionTypeLabel,
} from "../connectionProfiles";
import { t } from "../i18n";
import { lazyPanel } from "../lazyWithReload";
import { useStoreSelector } from "../store";
import { LazyBoundary } from "./LazyBoundary";
import { Button } from "./ui/Button";
import "./ConnectionSwitcherTrigger.css";
import { useShallow } from "zustand/react/shallow";

// The connection menu and manager (Radix popover, profile forms) load on the
// first open; the trigger shows connection state from the first paint.
export const connectionSwitcherPanel = lazyPanel("connection-switcher", () =>
  import("./ConnectionSwitcher").then((module) => module.ConnectionSwitcher),
);

export function runtimeStateClass(
  connection: Pick<ConnectionSummary, "state">,
) {
  return `connection-runtime-${connection.state}`;
}

export type MenuFocus = "active" | "first" | "last";

export const ConnectionSwitcherTrigger = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }
>(function ConnectionSwitcherTrigger({ active: open, ...props }, ref) {
  const state = useStoreSelector(
    useShallow((snapshot) => ({
      activeConnectionId: snapshot.activeConnectionId,
      connectionPaused: snapshot.connectionPaused,
      connections: snapshot.connections,
      defaultConnectionId: snapshot.defaultConnectionId,
      status: snapshot.status,
    })),
  );
  const active =
    state.connections.find(
      (connection) => connection.id === state.activeConnectionId,
    ) ??
    ({
      id: state.activeConnectionId,
      label:
        state.activeConnectionId === "legacy-default"
          ? t("Default")
          : state.activeConnectionId,
      source: "legacy-config",
      is_default: state.defaultConnectionId === state.activeConnectionId,
      state: "disconnected",
      generation: 0,
    } satisfies ConnectionSummary);

  const browserWarning = state.connectionPaused
    ? t("Browser sync paused")
    : state.status === "disconnected"
      ? t("Browser disconnected from bridge")
      : null;
  return (
    <Button
      ref={ref}
      className={`connection-switcher-trigger ${open ? "is-active" : ""} ${browserWarning ? "has-browser-warning" : ""}`}
      aria-label={`${active.label}, ${connectionTypeLabel(active)}, ${connectionLifecycleLabel(active.state)}${browserWarning ? `, ${browserWarning}` : ""}`}
      data-tooltip={browserWarning ?? undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      {...props}
    >
      <span className={`connection-runtime-dot ${runtimeStateClass(active)}`} />
      <span className="connection-switcher-label">{active.label}</span>
      {browserWarning ? (
        <CircleAlert
          className="connection-switcher-warning"
          size={13}
          aria-hidden="true"
        />
      ) : null}
      <span className="connection-switcher-meta">
        {connectionTypeLabel(active)} / {connectionLifecycleLabel(active.state)}
      </span>
      <ChevronDown size={13} aria-hidden="true" />
    </Button>
  );
});

export function LazyConnectionSwitcher() {
  const Switcher = connectionSwitcherPanel.Component;
  const [initialFocus, setInitialFocus] = useState<MenuFocus | null>(null);
  if (!initialFocus) {
    return (
      <div className="connection-switcher">
        <ConnectionSwitcherTrigger
          active={false}
          onPointerEnter={() => void connectionSwitcherPanel.preload()}
          onFocus={() => void connectionSwitcherPanel.preload()}
          onClick={() => setInitialFocus("active")}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            setInitialFocus(event.key === "ArrowUp" ? "last" : "first");
          }}
        />
      </div>
    );
  }
  return (
    <LazyBoundary
      fallback={
        <div className="connection-switcher">
          <ConnectionSwitcherTrigger active aria-busy="true" />
        </div>
      }
    >
      <Switcher defaultOpen={initialFocus} />
    </LazyBoundary>
  );
}
