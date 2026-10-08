import { describe, expect, test } from "bun:test";
import { parseTerminalColor, resttyTheme } from "./terminalEngine";
import {
  TERMINAL_THEME_PRESETS,
  defaultTerminalThemeId,
  isTerminalThemeBackground,
  normalizeTerminalThemeSelection,
  parseTerminalThemeSelection,
  resolveTerminalTheme,
  resolveTerminalThemeDefinition,
  serializeTerminalThemeSelection,
  terminalThemeFor,
  terminalHostThemeReport,
} from "./terminalThemes";

describe("terminal themes", () => {
  test("converts to the engine's palette with xterm's default ANSI colors", () => {
    for (const mode of ["light", "dark"] as const) {
      const theme = terminalThemeFor(mode);
      const converted = resttyTheme(theme);
      expect(converted.colors.background).toEqual(
        parseTerminalColor(theme.background),
      );
      expect(converted.colors.palette).toHaveLength(256);
      expect(converted.colors.palette[0]).toBeDefined();
      expect(converted.colors.palette[16]).toBeUndefined();
    }
    expect(resttyTheme({}).colors.palette[1]).toEqual({ r: 204, g: 0, b: 0 });
    expect(parseTerminalColor("rgba(110,160,255,0.3)")).toEqual({
      r: 110,
      g: 160,
      b: 255,
      a: 77,
    });
  });
});

describe("terminal theme presets", () => {
  test("have unique ids and valid colors", () => {
    const ids = new Set<string>();
    for (const preset of TERMINAL_THEME_PRESETS) {
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.theme.background).toMatch(/^#/);
      expect(preset.theme.foreground).toMatch(/^#/);
    }
  });

  test("keep Herdr Dark and Herdr Light as the per-mode defaults", () => {
    for (const mode of ["dark", "light"] as const) {
      expect(defaultTerminalThemeId(mode)).toBe(`herdr-${mode}`);
      const preset = TERMINAL_THEME_PRESETS.find(
        (preset) => preset.id === defaultTerminalThemeId(mode),
      );
      expect(preset?.theme).toEqual(terminalThemeFor(mode));
    }
    expect(terminalThemeFor("dark").background).toBe("#0e1014");
    expect(terminalThemeFor("dark").red).toBeUndefined();
    expect(terminalThemeFor("light").background).toBe("#ffffff");
    expect(terminalThemeFor("light").red).toBe("#cf222e");
  });

  test("include both dark and light variants beyond the defaults", () => {
    const dark = TERMINAL_THEME_PRESETS.filter(
      (preset) => preset.variant === "dark",
    );
    const light = TERMINAL_THEME_PRESETS.filter(
      (preset) => preset.variant === "light",
    );
    expect(dark.length).toBeGreaterThan(1);
    expect(light.length).toBeGreaterThan(1);
  });
});

describe("terminal theme selection", () => {
  test("falls back to per-mode defaults for missing or invalid values", () => {
    expect(parseTerminalThemeSelection(null)).toEqual({
      dark: "herdr-dark",
      light: "herdr-light",
    });
    expect(parseTerminalThemeSelection("{oops")).toEqual({
      dark: "herdr-dark",
      light: "herdr-light",
    });
    expect(
      normalizeTerminalThemeSelection({ dark: 42, light: "github-light" }),
    ).toEqual({
      dark: "herdr-dark",
      light: "github-light",
    });
  });

  test("round-trips through serialize and parse", () => {
    const selection = { dark: "nord", light: "solarized-light" };
    expect(
      parseTerminalThemeSelection(serializeTerminalThemeSelection(selection)),
    ).toEqual(selection);
  });

  test("resets custom, unknown, and wrong-mode ids to the mode default", () => {
    expect(
      parseTerminalThemeSelection(
        JSON.stringify({ dark: "custom-1", light: "dracula" }),
      ),
    ).toEqual({ dark: "herdr-dark", light: "herdr-light" });
    expect(
      resolveTerminalTheme("dark", { dark: "dracula", light: "github-light" })
        .background,
    ).toBe("#282a36");
    expect(
      resolveTerminalThemeDefinition("light", { dark: "nord", light: "gone" })
        .id,
    ).toBe("herdr-light");
  });
});

test("host theme reports follow the terminal background, not the page", () => {
  expect(
    terminalHostThemeReport({ background: "#FFF", foreground: "#1f2328" }),
  ).toMatchObject({
    appearance: "light",
    background: "#ffffff",
    foreground: "#1f2328",
  });
  expect(
    terminalHostThemeReport({ background: "#0e1014", foreground: "#e6e6e6" })
      ?.appearance,
  ).toBe("dark");
  expect(
    terminalHostThemeReport({
      background: "rgba(0,0,0,0.5)",
      foreground: "#fff",
    }),
  ).toBeNull();
});

test("Thyra's own theme backgrounds are recognized in Herdr's appearance", () => {
  expect(isTerminalThemeBackground("#FFFFFF")).toBe(true);
  expect(isTerminalThemeBackground("#002b36")).toBe(true);
  expect(isTerminalThemeBackground("#123456")).toBe(false);
  expect(isTerminalThemeBackground("unknown")).toBe(false);
  expect(isTerminalThemeBackground(null)).toBe(false);
});
