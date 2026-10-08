import { Moon, Sun } from "lucide-react";
import { msg, t } from "../i18n";
import type { TerminalTheme } from "../terminalEngine";
import {
  resolveTerminalThemeDefinition,
  terminalThemeName,
  terminalThemesFor,
  type TerminalThemeSelection,
} from "../terminalThemes";
import { Dialog } from "./ui/Dialog";
import { Select } from "./ui/Select";
import "./TerminalThemeDialog.css";

const MODES = [
  { variant: "dark", label: msg("Dark mode"), Icon: Moon },
  { variant: "light", label: msg("Light mode"), Icon: Sun },
] as const;

const SAMPLE_COLORS = [
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
] as const;

function TerminalThemePreview({ theme }: { theme: TerminalTheme }) {
  return (
    <div
      className="terminal-theme-preview"
      style={{ background: theme.background, color: theme.foreground }}
      aria-hidden="true"
    >
      <span>$ herdr test src/main.ts</span>
      <span>
        {SAMPLE_COLORS.map((key) => (
          <i key={key} style={{ color: theme[key] }}>
            {key}
          </i>
        ))}
      </span>
    </div>
  );
}

/** Picks one built-in terminal theme per appearance mode; changes apply live. */
export function TerminalThemeDialog({
  open,
  selection,
  onSelectionChange,
  onClose,
}: {
  open: boolean;
  selection: TerminalThemeSelection;
  onSelectionChange: (selection: TerminalThemeSelection) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("Terminal Themes")}
      description={t("Choose a terminal theme for each appearance mode.")}
    >
      <div className="terminal-theme-modes">
        {MODES.map(({ variant, label, Icon }) => (
          <section className="terminal-theme-mode" key={variant}>
            <Select
              label={
                <span className="terminal-theme-mode-label">
                  <Icon size={14} aria-hidden="true" />
                  {t(label)}
                </span>
              }
              fullWidth
              value={selection[variant]}
              options={terminalThemesFor(variant).map((preset) => ({
                value: preset.id,
                label: terminalThemeName(preset),
              }))}
              onChange={(id) =>
                onSelectionChange({ ...selection, [variant]: id })
              }
            />
            <TerminalThemePreview
              theme={resolveTerminalThemeDefinition(variant, selection).theme}
            />
          </section>
        ))}
      </div>
    </Dialog>
  );
}
