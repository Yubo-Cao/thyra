import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  ALargeSmall,
  Bell,
  ChevronRight,
  Download,
  GitBranch,
  Keyboard,
  Languages,
  LayoutDashboard,
  Mic,
  Minus,
  Moon,
  Palette,
  Plus,
  SquareTerminal,
  Sun,
  SunMoon,
  Type as TypeIcon,
} from "lucide-react";
import {
  ACCENT_OPTIONS,
  type AccentColor,
  clampUiScale,
  normalizeTerminalFontFamily,
  TERMINAL_FONT_OPTIONS,
  type ThemePreference as Theme,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
} from "../appearance";
import {
  LOCALE_OPTIONS,
  loadLocalePreference,
  type LocalePreference,
  msg,
  saveLocalePreference,
  t,
} from "../i18n";
import { lazyWithReload } from "../lazyWithReload";
import {
  mobileTerminalShortcutCount,
  type MobileTerminalShortcutRows,
  type MobileTerminalSideShortcuts,
} from "../mobileTerminalShortcuts";
import { store, useStoreSelector } from "../store";
import {
  type CustomTerminalTheme,
  resolveTerminalThemeDefinition,
  terminalThemeName,
  type TerminalThemeSelection,
} from "../terminalThemes";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "../useConnectionClient";
import { cn } from "../utils";
import { AccountSettings } from "./AccountSettings";
import { AgentIntegrationsSettings } from "./AgentIntegrationsSettings";
import { useInstanceAdmin } from "../principal";
import { AutoSyncRepositoriesDialog } from "./AutoSyncRepositoriesDialog";
import { MobileTerminalShortcutsDialog } from "./MobileTerminalShortcutsDialog";
import { TerminalTransportSettings } from "./TerminalTransportSettings";
import { ProjectLauncherSettings } from "./ProjectLauncherSettings";
import { ConfigurationLoadingDialog } from "./ConfigurationLoadingDialog";
import { MobileSheetHandle } from "./MobileSheetHandle";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { IconButton } from "./ui/IconButton";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";
import { Tabs } from "./ui/Tabs";
import "./ConfigMenu.css";
import "./ConfigurationDialog.css";
import {
  setVoiceCleanupMode,
  useVoiceCleanupMode,
  VOICE_CLEANUP_OPTIONS,
  type VoiceCleanupMode,
} from "../voice/voicePreferences";
import { useShallow } from "zustand/react/shallow";

const ShortcutLookupDialog = lazyWithReload("keyboard-shortcuts", () =>
  import("./ShortcutLookupDialog").then((module) => ({
    default: module.ShortcutLookupDialog,
  })),
);
const TerminalThemeDialog = lazyWithReload("terminal-theme", () =>
  import("./TerminalThemeDialog").then((module) => ({
    default: module.TerminalThemeDialog,
  })),
);
const MobileLayoutDialog = lazyWithReload("mobile-layout", () =>
  import("./MobileLayoutDialog").then((module) => ({
    default: module.MobileLayoutDialog,
  })),
);

export type ConfigurationProps = {
  theme: Theme;
  accentColor: AccentColor;
  uiScale: number;
  terminalFontFamily: string;
  mobileTerminalShortcuts: MobileTerminalShortcutRows;
  mobileTerminalSideShortcuts: MobileTerminalSideShortcuts;
  terminalThemeSelection: TerminalThemeSelection;
  customTerminalThemes: CustomTerminalTheme[];
  onThemeChange: (theme: Theme) => void;
  onAccentColorChange: (accentColor: AccentColor) => void;
  onUiScaleChange: (scale: number) => void;
  onTerminalFontFamilyChange: (fontFamily: string) => void;
  onMobileTerminalShortcutsChange: (rows: MobileTerminalShortcutRows) => void;
  onMobileTerminalSideShortcutsChange: (
    shortcuts: MobileTerminalSideShortcuts,
  ) => void;
  onTerminalThemeSelectionChange: (selection: TerminalThemeSelection) => void;
  onCustomTerminalThemesChange: (themes: CustomTerminalTheme[]) => void;
};
const tabs = [
  "Appearance",
  "Behavior",
  "Connection",
  "Integrations",
  "Account",
] as const;
export type ConfigurationTab = (typeof tabs)[number];
/** Host settings: instance admins only. */
const ADMIN_TABS: ReadonlySet<ConfigurationTab> = new Set([
  "Connection",
  "Integrations",
]);
const TAB_LABELS: Record<ConfigurationTab, string> = {
  Appearance: msg("Appearance"),
  Behavior: msg("Behavior"),
  Connection: msg("Connection"),
  Integrations: msg("Integrations"),
  Account: msg("Account"),
};
type Detail = "terminal" | "layout" | "keyboard" | "mobile" | "sync";

export function ConfigurationDialog({
  onClose,
  initialTab = "Appearance",
  ...props
}: ConfigurationProps & {
  onClose: () => void;
  initialTab?: ConfigurationTab;
}) {
  const { theme, accentColor, uiScale } = props;
  const s = useStoreSelector(
    useShallow((state) => ({
      taskNotificationPermission: state.taskNotificationPermission,
      taskNotificationsEnabled: state.taskNotificationsEnabled,
      taskNotificationPreferences: state.taskNotificationPreferences,
      taskNotificationTransport: state.taskNotificationTransport,
      taskNotificationBusy: state.taskNotificationBusy,
      automaticUpdateChecksEnabled: state.automaticUpdateChecksEnabled,
      connectionLabel:
        state.connections.find((c) => c.id === state.activeConnectionId)
          ?.label ?? t("Current connection"),
      sshDestination: state.connections.find(
        (c) => c.id === state.activeConnectionId,
      )?.ssh_destination,
    })),
  );
  const connectionClient = useConnectionClient();
  const admin = useInstanceAdmin();
  const visibleTabs = tabs.filter((name) => admin || !ADMIN_TABS.has(name));
  const [tab, setTab] = useState<ConfigurationTab>(
    visibleTabs.includes(initialTab) ? initialTab : "Appearance",
  );
  const voiceCleanup = useVoiceCleanupMode();
  // A detail dialog opens on top of this one, which hides until it closes;
  // focus then returns to the row that opened it (WebKit does not focus a
  // clicked button, so the row is remembered explicitly).
  const [detail, setDetail] = useState<Detail | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const openDetail = (event: MouseEvent<HTMLElement>, next: Detail) => {
    detailTrigger.current = event.currentTarget;
    setDetail(next);
  };
  const closeDetail = () => setDetail(null);
  useEffect(() => {
    if (detail) return;
    const frame = requestAnimationFrame(() => {
      if (detailTrigger.current?.isConnected)
        detailTrigger.current.focus({ preventScroll: true });
      detailTrigger.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [detail]);
  const notificationStatus = s.taskNotificationBusy
    ? t("Saving...")
    : s.taskNotificationPermission === "unsupported"
      ? t("Unsupported")
      : s.taskNotificationPermission === "denied"
        ? t("Blocked by browser permissions")
        : s.taskNotificationsEnabled
          ? s.taskNotificationTransport === "push"
            ? t("On · Background push")
            : t("On · Active page only")
          : t("Off");
  const localePreference = loadLocalePreference();
  const scopeKey = connectionClientScopeKey(
    connectionClient,
    connectionClient.serverRuntimeGeneration,
  );

  const appearance = (
    <>
      <p className="configuration-scope">{t("Saved in this browser.")}</p>
      <PreferenceRow
        icon={<SunMoon size={15} />}
        title={t("Theme")}
        description={t("Application appearance")}
      >
        <SegmentedControl
          aria-label={t("Theme")}
          value={theme}
          onChange={props.onThemeChange}
          options={[
            {
              value: "light",
              label: <Sun size={14} />,
              ariaLabel: t("Use light theme"),
            },
            {
              value: "dark",
              label: <Moon size={14} />,
              ariaLabel: t("Use dark theme"),
            },
            {
              value: "system",
              label: <SunMoon size={14} />,
              ariaLabel: t("Use system theme"),
            },
          ]}
        />
      </PreferenceRow>
      <PreferenceRow
        icon={<Palette size={15} />}
        title={t("Accent color")}
        description={t(
          ACCENT_OPTIONS.find((option) => option.value === accentColor)
            ?.label ?? "",
        )}
      >
        <SegmentedControl
          aria-label={t("Accent color")}
          className="config-accent-control"
          value={accentColor}
          onChange={props.onAccentColorChange}
          options={ACCENT_OPTIONS.map((option) => ({
            value: option.value,
            label: (
              <span
                className="config-accent-swatch"
                data-accent={option.value}
                aria-hidden="true"
              />
            ),
            ariaLabel: t(option.label),
            title: t(option.label),
          }))}
        />
      </PreferenceRow>
      <PreferenceRow
        icon={<ALargeSmall size={15} />}
        title={t("Text size")}
        description={t("Scale the interface")}
      >
        <div
          className="config-scale-control"
          role="group"
          aria-label={t("Text size")}
        >
          <IconButton
            label={t("Decrease text size")}
            icon={<Minus size={14} />}
            aria-disabled={uiScale <= UI_SCALE_MIN}
            onClick={() =>
              props.onUiScaleChange(clampUiScale(uiScale - UI_SCALE_STEP))
            }
          />
          <Button
            className="config-scale-value"
            aria-label={t("Reset text size, currently {scale}%", {
              scale: uiScale,
            })}
            aria-disabled={uiScale === UI_SCALE_DEFAULT}
            onClick={() => props.onUiScaleChange(UI_SCALE_DEFAULT)}
          >
            {uiScale}%
          </Button>
          <IconButton
            label={t("Increase text size")}
            icon={<Plus size={14} />}
            aria-disabled={uiScale >= UI_SCALE_MAX}
            onClick={() =>
              props.onUiScaleChange(clampUiScale(uiScale + UI_SCALE_STEP))
            }
          />
        </div>
      </PreferenceRow>
      <PreferenceRow
        icon={<TypeIcon size={15} />}
        title={t("Terminal font")}
        description={t("Uses locally installed fonts")}
      >
        <Select
          aria-label={t("Terminal font")}
          align="end"
          value={normalizeTerminalFontFamily(props.terminalFontFamily)}
          options={TERMINAL_FONT_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          onChange={props.onTerminalFontFamilyChange}
        />
      </PreferenceRow>
      <PreferenceRow
        icon={<Languages size={15} />}
        title={t("Language")}
        description={t("Reloads the page to apply.")}
      >
        <Select
          aria-label={t("Language")}
          align="end"
          value={localePreference}
          options={LOCALE_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          onChange={(value) => {
            if (value !== localePreference)
              saveLocalePreference(value as LocalePreference);
          }}
        />
      </PreferenceRow>
      <DetailRow
        icon={<SquareTerminal size={15} />}
        title={t("Terminal theme")}
        description={t("Dark: {dark} · Light: {light}", {
          dark: terminalThemeName(
            resolveTerminalThemeDefinition(
              "dark",
              props.terminalThemeSelection,
              props.customTerminalThemes,
            ),
          ),
          light: terminalThemeName(
            resolveTerminalThemeDefinition(
              "light",
              props.terminalThemeSelection,
              props.customTerminalThemes,
            ),
          ),
        })}
        onClick={(event) => openDetail(event, "terminal")}
      />
      <DetailRow
        icon={<LayoutDashboard size={15} />}
        title={t("Layout")}
        description={t("Display mode, mobile breakpoint, and sidebar order")}
        onClick={(event) => openDetail(event, "layout")}
      />
    </>
  );

  const behavior = (
    <>
      <p className="configuration-scope">
        {t(
          "Preferences apply to this browser. Push delivery preferences apply to this device.",
        )}
      </p>
      <PreferenceRow
        icon={<Download size={15} />}
        title={t("Automatic update checks")}
        description={
          s.automaticUpdateChecksEnabled ? t("Enabled") : t("Disabled")
        }
      >
        <Switch
          aria-label={t("Automatic update checks")}
          checked={s.automaticUpdateChecksEnabled}
          onChange={(checked) => store.setAutomaticUpdateChecksEnabled(checked)}
        />
      </PreferenceRow>
      <PreferenceRow
        icon={<Mic size={15} />}
        title={t("Voice cleanup")}
        description={t("Rewrites a finished dictation with the server model")}
      >
        <Select
          aria-label={t("Voice cleanup")}
          align="end"
          value={voiceCleanup}
          options={VOICE_CLEANUP_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          onChange={(value) => setVoiceCleanupMode(value as VoiceCleanupMode)}
        />
      </PreferenceRow>
      <PreferenceRow
        icon={<Bell size={15} />}
        title={t("Task notifications")}
        description={notificationStatus}
      >
        <Switch
          aria-label={t("Task notifications")}
          checked={s.taskNotificationsEnabled}
          onChange={(checked) => {
            if (!s.taskNotificationBusy)
              void store.setTaskNotificationsEnabled(checked);
          }}
        />
      </PreferenceRow>
      {s.taskNotificationsEnabled &&
        (
          [
            ["blocked", t("Agent needs input")],
            ["completed", t("Task completed")],
          ] as const
        ).map(([kind, label]) => (
          <PreferenceRow key={kind} title={label}>
            <Switch
              aria-label={label}
              checked={s.taskNotificationPreferences[kind]}
              onChange={(checked) => {
                if (!s.taskNotificationBusy)
                  void store.setTaskNotificationPreference(kind, checked);
              }}
            />
          </PreferenceRow>
        ))}
      <DetailRow
        icon={<Keyboard size={15} />}
        title={t("Keyboard shortcuts")}
        description={t("Presets, bindings, and help")}
        onClick={(event) => openDetail(event, "keyboard")}
      />
      <DetailRow
        icon={<Keyboard size={15} />}
        title={t("Mobile terminal shortcuts")}
        description={t("{panel} panel · {side} side", {
          panel: mobileTerminalShortcutCount(props.mobileTerminalShortcuts),
          side: props.mobileTerminalSideShortcuts.filter(Boolean).length,
        })}
        onClick={(event) => openDetail(event, "mobile")}
      />
    </>
  );

  const connection = (
    <>
      <p className="configuration-scope">
        {t("Connection:")} <strong>{s.connectionLabel}</strong>
      </p>
      <TerminalTransportSettings key={scopeKey} />
      <div className="configuration-launcher-settings">
        <ProjectLauncherSettings heading key={scopeKey} />
      </div>
      <DetailRow
        icon={<GitBranch size={15} />}
        title={t("Automatic branch updates")}
        description={t(
          "Manage saved repository sync settings on this connection",
        )}
        onClick={(event) => openDetail(event, "sync")}
      />
    </>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("Configuration")}
      description={t(
        "Appearance, behavior, connections, and agent integrations",
      )}
      closeLabel={t("Close Configuration")}
      headerStart={
        <MobileSheetHandle
          label={t("Dismiss Configuration")}
          onClose={onClose}
        />
      }
      className={cn(
        "configuration-dialog mobile-sheet",
        detail !== null && "is-covered",
      )}
      bodyClassName="configuration-body"
      footer={
        <>
          <span className="configuration-footer-note">
            {tab === "Integrations"
              ? t("Changes require confirmation.")
              : t("Changes are saved automatically.")}
          </span>
          <Button variant="primary" size="md" onClick={onClose}>
            {t("Done")}
          </Button>
        </>
      }
    >
      <Tabs
        aria-label={t("Configuration categories")}
        className="configuration-tabs"
        panelClassName="configuration-content"
        value={tab}
        onChange={setTab}
        items={visibleTabs.map((name) => ({
          id: name,
          label: t(TAB_LABELS[name]),
        }))}
      >
        {tab === "Appearance" ? appearance : null}
        {tab === "Behavior" ? behavior : null}
        {tab === "Connection" && admin ? connection : null}
        {tab === "Account" ? <AccountSettings /> : null}
        {tab === "Integrations" && admin ? (
          <AgentIntegrationsSettings
            key={scopeKey}
            connectionLabel={s.connectionLabel}
            sshDestination={s.sshDestination}
          />
        ) : null}
      </Tabs>
      {/* Rendered inside this dialog so their focus scopes nest in it. */}
      <Suspense
        fallback={
          <ConfigurationLoadingDialog
            onClose={closeDetail}
            buttonLabel={t("Back to Configuration")}
          />
        }
      >
        {detail === "keyboard" ? (
          <ShortcutLookupDialog open onClose={closeDetail} />
        ) : null}
        {detail === "terminal" ? (
          <TerminalThemeDialog
            open
            selection={props.terminalThemeSelection}
            customThemes={props.customTerminalThemes}
            onSelectionChange={props.onTerminalThemeSelectionChange}
            onCustomThemesChange={props.onCustomTerminalThemesChange}
            onClose={closeDetail}
          />
        ) : null}
        {detail === "layout" ? (
          <MobileLayoutDialog open onClose={closeDetail} />
        ) : null}
      </Suspense>
      <MobileTerminalShortcutsDialog
        open={detail === "mobile"}
        rows={props.mobileTerminalShortcuts}
        sideShortcuts={props.mobileTerminalSideShortcuts}
        onChange={props.onMobileTerminalShortcutsChange}
        onSideChange={props.onMobileTerminalSideShortcutsChange}
        onClose={closeDetail}
      />
      <AutoSyncRepositoriesDialog
        open={detail === "sync"}
        onClose={closeDetail}
      />
    </Dialog>
  );
}

/** A setting that applies in place: icon, title, status line, and control. */
function PreferenceRow({
  icon,
  title,
  description,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="config-preference-row">
      {icon ? <span className="config-item-icon">{icon}</span> : null}
      <div className="config-item-copy">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** A row that opens a detail dialog over the configuration. */
function DetailRow({
  icon,
  title,
  description,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Button className="config-menu-item" fullWidth onClick={onClick}>
      <span className="config-item-icon">{icon}</span>
      <span className="config-item-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
      <ChevronRight size={15} />
    </Button>
  );
}
