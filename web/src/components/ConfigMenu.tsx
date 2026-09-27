import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { lazyPanel } from "../lazyWithReload";
import { useStoreSelector } from "../store";
import type {
  ConfigurationProps,
  ConfigurationTab,
} from "./ConfigurationDialog";
import { LazyBoundary, usePanelReady } from "./LazyBoundary";

export const CONFIG_MENU_ID = "thyra-config-menu";

// The menu content and the configuration dialog load on the first open; this
// shell keeps the trigger and the state that must survive closing the menu.
export const configMenuPanel = lazyPanel("config-menu", () =>
  import("./ConfigMenuPanel").then((module) => module.ConfigMenuDropdown),
);
const configurationHostPanel = lazyPanel("config-menu", () =>
  import("./ConfigMenuPanel").then((module) => module.ConfigurationHost),
);

export function reloadApplicationPage(
  target: Pick<Location, "reload"> = window.location,
) {
  target.reload();
}

type ConfigMenuProps = ConfigurationProps & {
  zenMode: boolean;
  onZenModeChange: (zenMode: boolean) => void;
};

export function ConfigMenu({
  zenMode,
  onZenModeChange,
  ...configuration
}: ConfigMenuProps) {
  const updateAvailable = useStoreSelector(
    (state) => !!state.updateInfo?.update_available,
  );
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [configurationTab, setConfigurationTab] =
    useState<ConfigurationTab | null>(null);
  const [connectionDetailsOpen, setConnectionDetailsOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const preloadMenu = () => {
    void configMenuPanel.preload();
    void configurationHostPanel.preload();
  };
  const closeMenu = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const closeConfiguration = useCallback(() => {
    setConfigurationTab(null);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node))
        setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open]);

  const dropdownLoaded = usePanelReady(configMenuPanel, open);
  const Dropdown = configMenuPanel.Component;
  const ConfigurationHost = configurationHostPanel.Component;
  const pending = open && !dropdownLoaded;
  return (
    <>
      <div className="config-menu" ref={ref}>
        <button
          ref={triggerRef}
          className={`topbar-button menu-button ${open ? "is-active" : ""}`}
          onPointerEnter={preloadMenu}
          onClick={() => {
            preloadMenu();
            setExpanded(false);
            setLogoutError("");
            setOpen((value) => !value);
          }}
          aria-label={updateAvailable ? t("Menu, update available") : t("Menu")}
          aria-controls={open && !pending ? CONFIG_MENU_ID : undefined}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-busy={pending || undefined}
        >
          {t("Menu")}
          {updateAvailable ? <span className="menu-update-dot" /> : null}
        </button>
        {open && dropdownLoaded ? (
          <LazyBoundary>
            <Dropdown
              zenMode={zenMode}
              onZenModeChange={onZenModeChange}
              expanded={expanded}
              setExpanded={setExpanded}
              setOpen={setOpen}
              closeMenu={closeMenu}
              setConfigurationTab={setConfigurationTab}
              connectionDetailsOpen={connectionDetailsOpen}
              setConnectionDetailsOpen={setConnectionDetailsOpen}
              loggingOut={loggingOut}
              setLoggingOut={setLoggingOut}
              logoutError={logoutError}
              setLogoutError={setLogoutError}
            />
          </LazyBoundary>
        ) : null}
      </div>
      {configurationTab ? (
        <LazyBoundary>
          <ConfigurationHost
            {...configuration}
            configurationTab={configurationTab}
            onClose={closeConfiguration}
          />
        </LazyBoundary>
      ) : null}
    </>
  );
}
