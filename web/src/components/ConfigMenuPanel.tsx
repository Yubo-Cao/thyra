import { Suspense, useEffect, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Focus,
  LogOut,
  Palette,
  Plug,
  RefreshCw,
  SlidersHorizontal,
  Server,
  Settings,
  UserRound,
  Wifi,
} from "lucide-react";
import packageJson from "../../package.json";
import { type ConnectionClient, logoutBrowserSession } from "../api";
import { connectionHttpPath } from "../connectionHttp";
import { msg, t } from "../i18n";
import { useLayoutPreferences } from "../layoutPreferences";
import { useGuest, useInstanceAdmin } from "../principal";
import { lazyWithReload } from "../lazyWithReload";
import { shortcutLabel, useShortcutPreferences } from "../shortcutPreferences";
import { store, useStoreSelector } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import { cn } from "../utils";
import { Button } from "./ui/Button";
import { Switch } from "./ui/Switch";
import { CONFIG_MENU_ID, reloadApplicationPage } from "./ConfigMenu";
import type {
  ConfigurationProps,
  ConfigurationTab,
} from "./ConfigurationDialog";
import { ConfigurationLoadingDialog } from "./ConfigurationLoadingDialog";
import { browserCountLabel } from "./browserTransport";
import { HerdrSetupCard } from "./HerdrSetupCard";
import { MobileSheetHandle } from "./MobileSheetHandle";
import "./ConfigMenu.css";
import { useShallow } from "zustand/react/shallow";

// The application menu's content, loaded on its first open. ConfigMenu keeps
// the trigger, the open state, and everything that must survive a close.

const ConfigurationDialog = lazyWithReload("configuration", () =>
  import("./ConfigurationDialog").then((module) => ({
    default: module.ConfigurationDialog,
  })),
);
const APP_VERSION = packageJson.version;
const RELEASES_URL = "https://github.com/Yubo-Cao/thyra/releases";
const CONNECTION_STATUS_LABELS: Record<string, string> = {
  connecting: msg("connecting"),
  connected: msg("connected"),
  disconnected: msg("disconnected"),
};

type Toggle = (update: boolean | ((value: boolean) => boolean)) => void;

export type ConfigMenuDropdownProps = {
  zenMode: boolean;
  onZenModeChange: (zenMode: boolean) => void;
  expanded: boolean;
  setExpanded: Toggle;
  setOpen: (open: boolean) => void;
  closeMenu: () => void;
  setConfigurationTab: (tab: ConfigurationTab) => void;
  connectionDetailsOpen: boolean;
  setConnectionDetailsOpen: Toggle;
  loggingOut: boolean;
  setLoggingOut: (loggingOut: boolean) => void;
  logoutError: string;
  setLogoutError: (error: string) => void;
};

export function ConfigMenuDropdown({
  zenMode,
  onZenModeChange,
  expanded,
  setExpanded,
  setOpen,
  closeMenu,
  setConfigurationTab,
  connectionDetailsOpen,
  setConnectionDetailsOpen,
  loggingOut,
  setLoggingOut,
  logoutError,
  setLogoutError,
}: ConfigMenuDropdownProps) {
  const s = useStoreSelector(
    useShallow((state) => ({
      bridgeStatus: state.bridgeStatus,
      activeConnectionId: state.activeConnectionId,
      defaultConnectionId: state.defaultConnectionId,
      connectionPaused: state.connectionPaused,
      status: state.status,
      updateInfo: state.updateInfo,
      updateInstalling: state.updateInstalling,
    })),
  );
  const connectionClient = useConnectionClient();
  const { health, herdrInfo, herdrUnavailable } =
    useMenuServerInfo(connectionClient);
  const layout = useLayoutPreferences();
  const admin = useInstanceAdmin();
  const guest = useGuest();
  useShortcutPreferences();
  const updateAvailable = !!s.updateInfo?.update_available;
  const canInstallUpdate = updateAvailable && s.updateInfo?.can_auto_update;
  const updateVersion = s.updateInfo?.latest_version;
  const clientCount =
    !s.connectionPaused && s.status === "connected"
      ? s.bridgeStatus?.clients
      : null;
  return (
    <div
      id={CONFIG_MENU_ID}
      className={`config-dropdown mobile-sheet${expanded ? " is-expanded" : ""}`}
      role="dialog"
      aria-label={t("Application menu")}
    >
      <MobileSheetHandle
        label={
          expanded ? t("Show fewer menu options") : t("Show more menu options")
        }
        expanded={expanded}
        onExpand={() => setExpanded(true)}
        onCollapse={() => setExpanded(false)}
        onClose={closeMenu}
        onClick={() => setExpanded((value) => !value)}
      />
      <div className="config-dropdown-content">
        <div className="config-summary">
          <div>
            <strong>Thyra</strong>
            <span>{t("Version {version}", { version: APP_VERSION })}</span>
          </div>
          <span
            className={`config-connection-summary status-${s.connectionPaused ? "paused" : s.status}`}
          >
            <span className="status-dot" />
            {s.connectionPaused
              ? t("Paused")
              : t(CONNECTION_STATUS_LABELS[s.status] ?? s.status)}
            {typeof clientCount === "number"
              ? ` · ${browserCountLabel(clientCount, s.bridgeStatus?.devices)}`
              : ""}
          </span>
        </div>
        <div className="config-section">
          <ConfigMenuItem
            icon={<Settings size={15} />}
            label={t("Configuration")}
            description={t(
              "Appearance, behavior, connections, and agent integrations",
            )}
            className="config-menu-item-row"
            onClick={() => {
              setOpen(false);
              setConfigurationTab("Appearance");
            }}
          />
          {layout.mobile ? null : (
            <div className="config-preference-row">
              <span className="config-item-icon">
                <Focus size={15} />
              </span>
              <div className="config-item-copy">
                <strong>{t("Zen mode")}</strong>
                <span>
                  {zenMode ? t("Enabled") : t("Disabled")} ·{" "}
                  {shortcutLabel("zen.toggle")}
                </span>
              </div>
              <Switch
                aria-label={t("Zen mode")}
                checked={zenMode}
                onChange={(checked) => {
                  onZenModeChange(checked);
                  setOpen(false);
                }}
              />
            </div>
          )}
        </div>
        <div
          className={cn(
            "config-section",
            admin ? "config-section-tiles-3" : "config-section-tiles-2",
          )}
        >
          <div className="config-title">{t("Help & updates")}</div>
          <ConfigMenuItem
            icon={<ExternalLink size={15} />}
            label={t("Changelog")}
            description={t("Recent changes on GitHub")}
            onClick={() => {
              setOpen(false);
              window.open(RELEASES_URL, "_blank", "noopener,noreferrer");
            }}
          />
          <ConfigMenuItem
            icon={<RefreshCw size={15} />}
            label={t("Reload page")}
            description={t("Refresh the application")}
            onClick={() => {
              setOpen(false);
              reloadApplicationPage();
            }}
          />
          {admin ? (
            <ConfigMenuItem
              icon={<Download size={15} />}
              label={
                canInstallUpdate
                  ? s.updateInstalling
                    ? t("Updating...")
                    : t("Update to {version}", {
                        version: updateVersion ?? "",
                      })
                  : updateAvailable
                    ? t("Version {version} available", {
                        version: updateVersion ?? "",
                      })
                    : t("Check for updates")
              }
              description={
                canInstallUpdate
                  ? t("Install and restart")
                  : updateAvailable
                    ? t("Automatic install unavailable")
                    : t("Check the release server")
              }
              primary={canInstallUpdate}
              disabled={s.updateInstalling}
              onClick={() => {
                setOpen(false);
                void store.updateOrCheck();
              }}
            />
          ) : null}
        </div>
        <div className="config-section">
          <div className="config-title">{t("Runtime")}</div>
          <div className="config-runtime-row">
            <span className="config-item-icon">
              <Server size={15} />
            </span>
            <div className="config-item-copy">
              <strong>{t("Herdr server")}</strong>
              <span>
                {herdrInfo?.version
                  ? t("Version {version}", { version: herdrInfo.version })
                  : herdrUnavailable
                    ? t("Unavailable")
                    : t("Loading server information")}
              </span>
            </div>
            <code>
              {typeof herdrInfo?.protocol === "number"
                ? t("Protocol {version}", { version: herdrInfo.protocol })
                : "-"}
            </code>
          </div>
          {herdrUnavailable ? (
            <HerdrSetupCard
              key={connectionClient.connectionId}
              enabled={
                !s.connectionPaused &&
                s.activeConnectionId === s.defaultConnectionId
              }
              compact
            />
          ) : null}
          <Button
            className="config-details-toggle"
            fullWidth
            aria-expanded={connectionDetailsOpen}
            onClick={() => setConnectionDetailsOpen((value) => !value)}
          >
            <span className="config-item-icon">
              <Wifi size={15} />
            </span>
            <span>{t("Connection details")}</span>
            {connectionDetailsOpen ? (
              <ChevronDown size={15} />
            ) : (
              <ChevronRight size={15} />
            )}
          </Button>
          {connectionDetailsOpen ? (
            <div className="config-details">
              <ConfigRow label="URL" value={location.origin} />
              <ConfigRow label={t("Socket")} value={health?.socket ?? "-"} />
            </div>
          ) : null}
        </div>
        {health?.auth_required ? (
          <div className="config-section">
            <ConfigMenuItem
              icon={<LogOut size={15} />}
              label={loggingOut ? t("Logging out...") : t("Log out")}
              description={t("End this browser session only")}
              className="config-menu-item-row"
              disabled={loggingOut}
              onClick={async () => {
                setLoggingOut(true);
                setLogoutError("");
                try {
                  await logoutBrowserSession();
                } catch {
                  setLogoutError(
                    t(
                      "Could not log out. Check your connection and try again.",
                    ),
                  );
                  setLoggingOut(false);
                }
              }}
            />
            {logoutError ? (
              <p className="config-logout-error" role="alert">
                {logoutError}
              </p>
            ) : null}
          </div>
        ) : null}
        {layout.mobile ? (
          <div className="mobile-sheet-more" aria-hidden={!expanded}>
            <div className="mobile-sheet-more-content">
              <div className="config-section">
                <div className="config-title">{t("Quick settings")}</div>
                {(
                  [
                    ["Appearance", msg("Appearance"), Palette],
                    ["Behavior", msg("Behavior"), SlidersHorizontal],
                    ...(admin
                      ? ([
                          ["Connection", msg("Connection"), Server],
                          ["Integrations", msg("Integrations"), Plug],
                        ] as const)
                      : []),
                    // Share-link guests have no account.
                    ...(guest
                      ? []
                      : ([["Account", msg("Account"), UserRound]] as const)),
                  ] as const
                ).map(([name, label, Icon]) => (
                  <ConfigMenuItem
                    key={name}
                    icon={<Icon size={15} />}
                    label={t(label)}
                    onClick={() => {
                      setOpen(false);
                      setConfigurationTab(name);
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Bridge health and Herdr server details, fetched each time the menu opens. */
function useMenuServerInfo(connectionClient: ConnectionClient) {
  const [health, setHealth] = useState<{
    socket?: string;
    auth_required?: boolean;
  } | null>(null);
  const [herdrInfo, setHerdrInfo] = useState<{
    version: string;
    protocol: number;
  } | null>(null);
  const [herdrUnavailable, setHerdrUnavailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setHealth(null);
    setHerdrInfo(null);
    setHerdrUnavailable(false);
    fetch("/api/health", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((info) => {
        if (!cancelled) setHealth(info);
      });
    if (connectionClient.isCurrent()) {
      const url = new URL(
        connectionHttpPath(
          connectionClient.connectionId,
          "/herdr-info",
          connectionClient.serverRuntimeGeneration,
        ),
        window.location.origin,
      );
      if (url.origin === window.location.origin)
        fetch(url, { credentials: "same-origin", cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
          .then((info) => {
            if (cancelled || !connectionClient.isCurrent()) return;
            if (info) setHerdrInfo(info);
            else setHerdrUnavailable(true);
          });
    }
    return () => {
      cancelled = true;
    };
  }, [connectionClient]);
  return { health, herdrInfo, herdrUnavailable };
}

export function ConfigurationHost({
  configurationTab,
  onClose,
  ...configuration
}: ConfigurationProps & {
  configurationTab: ConfigurationTab;
  onClose: () => void;
}) {
  return (
    <Suspense fallback={<ConfigurationLoadingDialog onClose={onClose} />}>
      <ConfigurationDialog
        {...configuration}
        initialTab={configurationTab}
        onClose={onClose}
      />
    </Suspense>
  );
}

function ConfigMenuItem({
  icon,
  label,
  description,
  onClick,
  disabled = false,
  primary = false,
  className,
}: {
  icon: ReactNode;
  label: string;
  description?: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  className?: string;
}) {
  return (
    <Button
      className={cn("config-menu-item", primary && "is-primary", className)}
      fullWidth
      onClick={onClick}
      disabled={disabled}
    >
      <span className="config-item-icon">{icon}</span>
      <span className="config-item-copy">
        <strong>{label}</strong>
        {description ? <span>{description}</span> : null}
      </span>
      <ChevronRight size={15} />
    </Button>
  );
}
function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="config-row">
      <span>{label}</span>
      <code title={value}>{value}</code>
    </div>
  );
}
