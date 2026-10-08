import type { TerminalTheme } from "./terminalEngine";
import type { ResolvedTheme } from "./appearance";
import { msg, t } from "./i18n";

export const TERMINAL_THEME_SELECTION_STORAGE_KEY = "terminalThemeSelection.v1";

// Dark keeps the historical palette exactly: only background, foreground,
// cursor, and selection are overridden; ANSI colors stay at xterm's defaults
// (terminalEngine.ts).
const DARK_TERMINAL_THEME: TerminalTheme = {
  background: "#0e1014",
  foreground: "#d4d8df",
  cursor: "#6ea0ff",
  selectionBackground: "rgba(110,160,255,0.3)",
};

// Light mode needs the full 16-color ANSI palette: the dark-oriented default
// palette (bright blues, greens, yellows) is unreadable on a light background.
const LIGHT_TERMINAL_THEME: TerminalTheme = {
  background: "#ffffff",
  foreground: "#24292f",
  cursor: "#2f6fe0",
  selectionBackground: "rgba(47,111,224,0.2)",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#9a6700",
  brightBlue: "#0550ae",
  brightMagenta: "#6639ba",
  brightCyan: "#0a6b74",
  brightWhite: "#8c959f",
};

export type TerminalThemeDefinition = {
  id: string;
  name: string;
  variant: ResolvedTheme;
  theme: TerminalTheme;
};

export function terminalThemeName(theme: TerminalThemeDefinition): string {
  return t(theme.name);
}

export type TerminalThemeSelection = {
  dark: string;
  light: string;
};

export const TERMINAL_THEME_PRESETS: readonly TerminalThemeDefinition[] = [
  {
    // Persisted preset IDs stay stable for existing theme selections.
    id: "herdr-dark",
    name: msg("Thyra Dark"),
    variant: "dark",
    theme: DARK_TERMINAL_THEME,
  },
  {
    id: "herdr-light",
    name: msg("Thyra Light"),
    variant: "light",
    theme: LIGHT_TERMINAL_THEME,
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    variant: "dark",
    theme: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#839496",
      cursorAccent: "#002b36",
      selectionBackground: "rgba(88,110,117,0.35)",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    variant: "dark",
    theme: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "rgba(68,71,90,0.6)",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    variant: "dark",
    theme: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      cursorAccent: "#282c34",
      selectionBackground: "rgba(62,68,81,0.9)",
      black: "#3f4451",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#d19a66",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#d19a66",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "nord",
    name: "Nord",
    variant: "dark",
    theme: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "rgba(67,76,94,0.7)",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    variant: "dark",
    theme: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "rgba(51,70,124,0.6)",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    variant: "dark",
    theme: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      selectionBackground: "rgba(88,91,112,0.5)",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    variant: "dark",
    theme: {
      background: "#0d1117",
      foreground: "#e6edf3",
      cursor: "#e6edf3",
      cursorAccent: "#0d1117",
      selectionBackground: "rgba(56,139,253,0.4)",
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    variant: "light",
    theme: {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#657b83",
      cursorAccent: "#fdf6e3",
      selectionBackground: "rgba(238,232,213,0.9)",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#93a1a1",
      brightYellow: "#839496",
      brightBlue: "#657b83",
      brightMagenta: "#6c71c4",
      brightCyan: "#586e75",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    variant: "light",
    theme: {
      background: "#ffffff",
      foreground: "#1f2328",
      cursor: "#1f2328",
      cursorAccent: "#ffffff",
      selectionBackground: "rgba(9,105,218,0.2)",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#4d2d00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#9a6700",
      brightBlue: "#218bff",
      brightMagenta: "#a475f9",
      brightCyan: "#3192aa",
      brightWhite: "#8c959f",
    },
  },
  {
    id: "one-light",
    name: "One Light",
    variant: "light",
    theme: {
      background: "#fafafa",
      foreground: "#383a42",
      cursor: "#526eff",
      cursorAccent: "#fafafa",
      selectionBackground: "rgba(56,58,66,0.12)",
      black: "#383a42",
      red: "#e45649",
      green: "#50a14f",
      yellow: "#c18401",
      blue: "#0184bc",
      magenta: "#a626a4",
      cyan: "#0997b3",
      white: "#a0a1a7",
      brightBlack: "#696c77",
      brightRed: "#e45649",
      brightGreen: "#50a14f",
      brightYellow: "#c18401",
      brightBlue: "#0184bc",
      brightMagenta: "#a626a4",
      brightCyan: "#0997b3",
      brightWhite: "#d3d3d3",
    },
  },
];

export const TERMINAL_ANSI_COLOR_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const presetById = new Map(
  TERMINAL_THEME_PRESETS.map((preset) => [preset.id, preset]),
);

export function defaultTerminalThemeId(variant: ResolvedTheme): string {
  return variant === "light" ? "herdr-light" : "herdr-dark";
}

export function terminalThemeFor(resolvedTheme: ResolvedTheme): TerminalTheme {
  return resolvedTheme === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
}

/** Built-in themes for one appearance mode. */
export function terminalThemesFor(
  variant: ResolvedTheme,
): TerminalThemeDefinition[] {
  return TERMINAL_THEME_PRESETS.filter((preset) => preset.variant === variant);
}

// Anything but a built-in theme of the matching mode (e.g. a removed custom
// theme) falls back to that mode's default.
function selectedThemeId(value: unknown, variant: ResolvedTheme): string {
  return typeof value === "string" && presetById.get(value)?.variant === variant
    ? value
    : defaultTerminalThemeId(variant);
}

export function normalizeTerminalThemeSelection(
  value: unknown,
): TerminalThemeSelection {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    dark: selectedThemeId(raw.dark, "dark"),
    light: selectedThemeId(raw.light, "light"),
  };
}

export function parseTerminalThemeSelection(
  raw: string | null,
): TerminalThemeSelection {
  if (!raw) return normalizeTerminalThemeSelection(null);
  try {
    return normalizeTerminalThemeSelection(JSON.parse(raw));
  } catch {
    return normalizeTerminalThemeSelection(null);
  }
}

export function serializeTerminalThemeSelection(
  selection: TerminalThemeSelection,
): string {
  return JSON.stringify(normalizeTerminalThemeSelection(selection));
}

export function resolveTerminalThemeDefinition(
  resolvedTheme: ResolvedTheme,
  selection: TerminalThemeSelection,
): TerminalThemeDefinition {
  const id = selectedThemeId(selection[resolvedTheme], resolvedTheme);
  return (
    presetById.get(id) ?? {
      id,
      name: resolvedTheme === "light" ? msg("Thyra Light") : msg("Thyra Dark"),
      variant: resolvedTheme,
      theme: terminalThemeFor(resolvedTheme),
    }
  );
}

export function resolveTerminalTheme(
  resolvedTheme: ResolvedTheme,
  selection: TerminalThemeSelection,
): TerminalTheme {
  return resolveTerminalThemeDefinition(resolvedTheme, selection).theme;
}

function normalizedHex(value: string | undefined): string | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value?.trim() ?? "");
  if (!match) return null;
  const hex =
    match[1].length === 3
      ? [...match[1]].map((digit) => digit + digit).join("")
      : match[1];
  return `#${hex.toLowerCase()}`;
}

const presetBackgrounds = new Set(
  TERMINAL_THEME_PRESETS.map((preset) =>
    normalizedHex(preset.theme.background),
  ),
);

/** Whether a color is a built-in theme's background, as Thyra reports them. */
export function isTerminalThemeBackground(value: unknown): boolean {
  const hex = typeof value === "string" ? normalizedHex(value) : null;
  return hex !== null && presetBackgrounds.has(hex);
}

/**
 * The `terminal.host_theme` payload for a terminal theme: default colors, the
 * 16 ANSI colors, and whether the background reads as light or dark.
 */
export function terminalHostThemeReport(theme: TerminalTheme) {
  const background = normalizedHex(theme.background);
  const foreground = normalizedHex(theme.foreground);
  if (!background || !foreground) return null;
  const channel = (offset: number) =>
    Number.parseInt(background.slice(offset, offset + 2), 16);
  // Same luminance split Herdr uses to infer an appearance from OSC 11.
  const luminance = channel(1) * 299 + channel(3) * 587 + channel(5) * 114;
  return {
    appearance: luminance >= 128_000 ? "light" : "dark",
    background,
    foreground,
    palette: TERMINAL_ANSI_COLOR_KEYS.map((key) => normalizedHex(theme[key])),
  };
}
