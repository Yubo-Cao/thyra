import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { ConnectionClient } from "../api";
import {
  type AccentColor,
  normalizeAccentColor,
  normalizeThemePreference,
  normalizeUiScale,
  type ResolvedTheme,
  resolveSystemTheme,
  SYSTEM_THEME_QUERY,
  TERMINAL_FONT_STORAGE_KEY,
  type ThemePreference,
  UI_SCALE_DEFAULT,
} from "../appearance";
import { thyraLocalStorage, thyraStorageEventKey } from "../browserStorage";
import type { ConfigurationProps } from "../components/ConfigurationDialog";
import {
  LEGACY_MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
  MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
  MOBILE_TERMINAL_SIDE_SHORTCUTS_STORAGE_KEY,
  parseMobileTerminalShortcutRows,
  parseMobileTerminalSideShortcuts,
  serializeMobileTerminalShortcutRows,
  serializeMobileTerminalSideShortcuts,
} from "../mobileTerminalShortcuts";
import {
  isTerminalThemeBackground,
  parseTerminalThemeSelection,
  resolveTerminalTheme,
  serializeTerminalThemeSelection,
  TERMINAL_THEME_SELECTION_STORAGE_KEY,
  terminalHostThemeReport,
} from "../terminalThemes";

const THEME_KEY = "theme";
const ACCENT_COLOR_KEY = "accentColor";
const UI_SCALE_KEY = "uiScale";

function loadSystemTheme(): ResolvedTheme {
  return resolveSystemTheme(window.matchMedia(SYSTEM_THEME_QUERY));
}

function loadMobileTerminalShortcuts() {
  const current = thyraLocalStorage.getItem(
    MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
  );
  if (current !== null) return parseMobileTerminalShortcutRows(current);
  const legacy = thyraLocalStorage.getItem(
    LEGACY_MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
  );
  const migrated = parseMobileTerminalShortcutRows(legacy);
  if (legacy !== null) {
    thyraLocalStorage.setItem(
      MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
      serializeMobileTerminalShortcutRows(migrated),
    );
  }
  return migrated;
}

const parseFontFamily = (value: string | null) => value ?? "";
const serializeFontFamily = (value: string) => value;

/** State saved under `key` and kept in sync with other tabs. */
function useStoredState<T>(
  key: string,
  parse: (value: string | null) => T,
  serialize: (value: T) => string,
  load = () => parse(thyraLocalStorage.getItem(key)),
) {
  const [value, setValue] = useState<T>(load);
  useEffect(() => {
    thyraLocalStorage.setItem(key, serialize(value));
  }, [key, serialize, value]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (thyraStorageEventKey(event) === key) setValue(parse(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, parse]);
  return [value, setValue] as const;
}

/**
 * Theme, accent, scale, and terminal preferences: applied to the document,
 * saved, and reported to Herdr as the terminal host theme.
 */
export function useAppearance(
  connectionClient: ConnectionClient,
  connected: boolean,
) {
  const [theme, setTheme] = useState<ThemePreference>(() =>
    normalizeThemePreference(thyraLocalStorage.getItem(THEME_KEY)),
  );
  const [systemTheme, setSystemTheme] = useState(loadSystemTheme);
  const [sessionTheme, setSessionTheme] = useState(loadSystemTheme);
  const resolvedTheme: ResolvedTheme =
    theme === "session"
      ? sessionTheme
      : theme === "system"
        ? systemTheme
        : theme;
  const [accentColor, setAccentColor] = useState<AccentColor>(() =>
    normalizeAccentColor(thyraLocalStorage.getItem(ACCENT_COLOR_KEY)),
  );
  const [uiScale, setUiScale] = useState<number>(() =>
    normalizeUiScale(thyraLocalStorage.getItem(UI_SCALE_KEY)),
  );
  const [terminalFontFamily, setTerminalFontFamily] = useStoredState(
    TERMINAL_FONT_STORAGE_KEY,
    parseFontFamily,
    serializeFontFamily,
  );
  const [mobileTerminalShortcuts, setMobileTerminalShortcuts] = useStoredState(
    MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
    parseMobileTerminalShortcutRows,
    serializeMobileTerminalShortcutRows,
    loadMobileTerminalShortcuts,
  );
  const [mobileTerminalSideShortcuts, setMobileTerminalSideShortcuts] =
    useStoredState(
      MOBILE_TERMINAL_SIDE_SHORTCUTS_STORAGE_KEY,
      parseMobileTerminalSideShortcuts,
      serializeMobileTerminalSideShortcuts,
    );
  const [terminalThemeSelection, setTerminalThemeSelection] = useStoredState(
    TERMINAL_THEME_SELECTION_STORAGE_KEY,
    parseTerminalThemeSelection,
    serializeTerminalThemeSelection,
  );
  const terminalTheme = useMemo(
    () => resolveTerminalTheme(resolvedTheme, terminalThemeSelection),
    [resolvedTheme, terminalThemeSelection],
  );

  useEffect(() => {
    const media = window.matchMedia(SYSTEM_THEME_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setSystemTheme(resolveSystemTheme(event));
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    if (theme !== "session" || !connected) return;
    let cancelled = false;
    let supported = true;
    const refresh = () => {
      if (!supported || document.visibilityState === "hidden") return;
      void connectionClient
        .call("session.appearance")
        .then((result) => {
          if (cancelled) return;
          const appearance = result?.appearance;
          // Herdr reports its foreground client's colors. When those are a
          // Thyra theme, they are this page's own report or another
          // device's, not the session's terminal: follow the system then.
          if (isTerminalThemeBackground(result?.background))
            setSessionTheme(systemTheme);
          else if (appearance === "light" || appearance === "dark")
            setSessionTheme(appearance);
        })
        .catch(() => {
          supported = false;
          if (!cancelled) setSessionTheme(systemTheme);
        });
    };
    refresh();
    // The session appearance changes rarely; poll it slowly and catch up as
    // soon as the page returns to the foreground.
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [connected, connectionClient, systemTheme, theme]);
  // Report the terminal colors panes are drawn with as Herdr's host theme, so
  // apps that ask the terminal (Codex, Claude Code's auto theme) match the
  // page instead of assuming a dark terminal.
  useEffect(() => {
    if (!connected) return;
    const report = terminalHostThemeReport(terminalTheme);
    if (!report) return;
    void connectionClient.call("terminal.host_theme", report).catch(() => {});
  }, [connected, connectionClient, terminalTheme]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
    thyraLocalStorage.setItem(THEME_KEY, theme);
    root.dataset.accent = accentColor;
    thyraLocalStorage.setItem(ACCENT_COLOR_KEY, accentColor);
    root.style.zoom = uiScale === UI_SCALE_DEFAULT ? "" : String(uiScale / 100);
    if (uiScale === UI_SCALE_DEFAULT) {
      root.style.removeProperty("--ui-scale");
    } else {
      root.style.setProperty("--ui-scale", String(uiScale / 100));
    }
    // React Aria positions popovers using getBoundingClientRect. Some engines
    // return pre-zoom layout px instead of visual viewport px under CSS
    // zoom, which breaks the static 1/zoom portal compensation. Measure the
    // actual ratio and compensate with it so anchoring works either way.
    const zoomProbe = document.createElement("div");
    zoomProbe.style.cssText =
      "position:fixed;top:100px;left:0;width:1px;height:1px;pointer-events:none;visibility:hidden";
    document.body.append(zoomProbe);
    const zoomRectRatio = zoomProbe.getBoundingClientRect().top / 100;
    zoomProbe.remove();
    if (zoomRectRatio > 0) {
      root.style.setProperty(
        "--popover-portal-zoom",
        String(1 / zoomRectRatio),
      );
      root.style.setProperty("--popover-content-zoom", String(zoomRectRatio));
    } else {
      root.style.removeProperty("--popover-portal-zoom");
      root.style.removeProperty("--popover-content-zoom");
    }
    thyraLocalStorage.setItem(UI_SCALE_KEY, String(uiScale));
  }, [accentColor, resolvedTheme, theme, uiScale]);

  const configuration: ConfigurationProps = {
    theme,
    accentColor,
    uiScale,
    terminalFontFamily,
    mobileTerminalShortcuts,
    mobileTerminalSideShortcuts,
    terminalThemeSelection,
    onThemeChange: setTheme,
    onAccentColorChange: setAccentColor,
    onUiScaleChange: setUiScale,
    onTerminalFontFamilyChange: setTerminalFontFamily,
    onMobileTerminalShortcutsChange: setMobileTerminalShortcuts,
    onMobileTerminalSideShortcutsChange: setMobileTerminalSideShortcuts,
    onTerminalThemeSelectionChange: setTerminalThemeSelection,
  };
  return { configuration, terminalTheme };
}
