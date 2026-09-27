import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ITheme } from "@xterm/xterm";
import { Check, Copy, Moon, Pencil, Plus, Sun, Trash2, X } from "lucide-react";
import type { ResolvedTheme } from "../appearance";
import { msg, t } from "../i18n";
import {
  type CustomTerminalTheme,
  customTerminalThemeToITheme,
  defaultTerminalThemeId,
  MAX_CUSTOM_TERMINAL_THEMES,
  MAX_TERMINAL_THEME_NAME_LENGTH,
  resolveTerminalThemeDefinition,
  TERMINAL_ANSI_COLOR_KEYS,
  TERMINAL_BASE_COLOR_KEYS,
  type TerminalThemeColorKey,
  type TerminalThemeDefinition,
  TERMINAL_THEME_PRESETS,
  type TerminalThemeSelection,
  terminalColorToHex,
} from "../terminalThemes";
import { cn } from "../utils";
import { Button } from "./ui/Button";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Dialog } from "./ui/Dialog";
import { IconButton } from "./ui/IconButton";
import { SegmentedControl } from "./ui/SegmentedControl";
import { TextField } from "./ui/TextField";
import { Token } from "./ui/Token";
import "./TerminalThemeDialog.css";

// Editor fallback palette for colors a source theme leaves unset (xterm
// defaults, e.g. Herdr Dark's ANSI colors).
const EDITOR_FALLBACK_COLORS: Record<TerminalThemeColorKey, string> = {
  background: "#0b0d12",
  foreground: "#c9cdd6",
  cursor: "#c9cdd6",
  cursorAccent: "#0b0d12",
  selectionBackground: "#6ea8ff",
  black: "#2e3436",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf",
  brightBlack: "#555753",
  brightRed: "#ef2929",
  brightGreen: "#8ae234",
  brightYellow: "#fce94f",
  brightBlue: "#729fcf",
  brightMagenta: "#ad7fa8",
  brightCyan: "#34e2e2",
  brightWhite: "#eeeeec",
};

const COLOR_KEY_LABELS: Record<TerminalThemeColorKey, string> = {
  background: msg("Background"),
  foreground: msg("Foreground"),
  cursor: msg("Cursor"),
  cursorAccent: msg("Cursor text"),
  selectionBackground: msg("Selection"),
  black: msg("Black"),
  red: msg("Red"),
  green: msg("Green"),
  yellow: msg("Yellow"),
  blue: msg("Blue"),
  magenta: msg("Magenta"),
  cyan: msg("Cyan"),
  white: msg("White"),
  brightBlack: msg("Bright black"),
  brightRed: msg("Bright red"),
  brightGreen: msg("Bright green"),
  brightYellow: msg("Bright yellow"),
  brightBlue: msg("Bright blue"),
  brightMagenta: msg("Bright magenta"),
  brightCyan: msg("Bright cyan"),
  brightWhite: msg("Bright white"),
};

const ALL_COLOR_KEYS: readonly TerminalThemeColorKey[] = [
  ...TERMINAL_BASE_COLOR_KEYS,
  ...TERMINAL_ANSI_COLOR_KEYS,
];

const THEME_VARIANTS: readonly {
  value: ResolvedTheme;
  label: string;
  usedWhen: string;
  create: string;
  group: string;
}[] = [
  {
    value: "dark",
    label: msg("Dark mode"),
    usedWhen: msg("Used when the app is in dark mode"),
    create: msg("Create a custom theme for dark mode"),
    group: msg("Dark mode terminal theme"),
  },
  {
    value: "light",
    label: msg("Light mode"),
    usedWhen: msg("Used when the app is in light mode"),
    create: msg("Create a custom theme for light mode"),
    group: msg("Light mode terminal theme"),
  },
];

let nextCustomThemeId = 1;

function newCustomThemeId(): string {
  return `custom-${Date.now()}-${nextCustomThemeId++}`;
}

type TerminalThemeDraft = {
  id: string | null;
  name: string;
  variant: ResolvedTheme;
  colors: Record<TerminalThemeColorKey, string>;
};

function draftColorsFromITheme(
  theme: ITheme,
): Record<TerminalThemeColorKey, string> {
  const colors = {} as Record<TerminalThemeColorKey, string>;
  for (const key of ALL_COLOR_KEYS) {
    colors[key] = terminalColorToHex(theme[key]) || EDITOR_FALLBACK_COLORS[key];
  }
  return colors;
}

function draftFromDefinition(
  definition: TerminalThemeDefinition,
  name: string,
): TerminalThemeDraft {
  return {
    id: null,
    name,
    variant: definition.variant,
    colors: draftColorsFromITheme(definition.theme),
  };
}

function draftFromCustom(custom: CustomTerminalTheme): TerminalThemeDraft {
  const colors = {} as Record<TerminalThemeColorKey, string>;
  for (const key of ALL_COLOR_KEYS) {
    colors[key] = custom.colors[key]
      ? terminalColorToHex(custom.colors[key])
      : EDITOR_FALLBACK_COLORS[key];
  }
  return { id: custom.id, name: custom.name, variant: custom.variant, colors };
}

function TerminalThemePreview({
  colors,
}: {
  colors: Record<TerminalThemeColorKey, string>;
}) {
  return (
    <div
      className="terminal-theme-preview"
      style={{ background: colors.background }}
      aria-hidden="true"
    >
      <div className="terminal-theme-preview-lines">
        <span style={{ color: colors.foreground }}>$ herdr test</span>
        <span>
          <i style={{ color: colors.green }}>pass</i>
          <i style={{ color: colors.red }}>fail</i>
          <i style={{ color: colors.blue }}>src/main.ts</i>
        </span>
      </div>
      <div className="terminal-theme-dots">
        {TERMINAL_ANSI_COLOR_KEYS.map((key) => (
          <span
            key={key}
            className="terminal-theme-dot"
            style={{ background: colors[key] }}
          />
        ))}
      </div>
    </div>
  );
}

type ThemeCardData = {
  definition: TerminalThemeDefinition;
  custom: CustomTerminalTheme | null;
};

export function TerminalThemeDialog({
  open,
  selection,
  customThemes,
  onSelectionChange,
  onCustomThemesChange,
  onClose,
}: {
  open: boolean;
  selection: TerminalThemeSelection;
  customThemes: CustomTerminalTheme[];
  onSelectionChange: (selection: TerminalThemeSelection) => void;
  onCustomThemesChange: (themes: CustomTerminalTheme[]) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<TerminalThemeDraft | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<CustomTerminalTheme | null>(null);

  const editing = draft !== null;
  const canCreate = customThemes.length < MAX_CUSTOM_TERMINAL_THEMES;
  const missingDraft =
    draft?.id != null && !customThemes.some((theme) => theme.id === draft.id);

  // Leaving the editor removes the focused control; park focus in the list.
  useEffect(() => {
    if (!editing) listRef.current?.focus({ preventScroll: true });
  }, [editing]);

  useEffect(() => {
    if (!open) {
      setDraft(null);
      setPendingDelete(null);
    }
  }, [open]);

  if (!open) return null;

  const cardsFor = (variant: ResolvedTheme): ThemeCardData[] => [
    ...TERMINAL_THEME_PRESETS.filter(
      (preset) => preset.variant === variant,
    ).map((definition) => ({ definition, custom: null })),
    ...customThemes
      .filter((theme) => theme.variant === variant)
      .map((custom) => ({
        custom,
        definition: {
          id: custom.id,
          name: custom.name,
          variant: custom.variant,
          builtin: false,
          theme: customTerminalThemeToITheme(custom),
        },
      })),
  ];

  const selectTheme = (variant: ResolvedTheme, id: string) => {
    onSelectionChange({ ...selection, [variant]: id });
  };

  const startNewTheme = (variant: ResolvedTheme) => {
    const current = resolveTerminalThemeDefinition(
      variant,
      selection,
      customThemes,
    );
    setDraft(draftFromDefinition(current, t("Custom theme")));
  };

  const duplicateTheme = (card: ThemeCardData) => {
    setDraft(
      draftFromDefinition(
        card.definition,
        t("{name} copy", { name: card.definition.name }),
      ),
    );
  };

  const saveDraft = () => {
    if (!draft || missingDraft || (!draft.id && !canCreate)) return;
    const theme: CustomTerminalTheme = {
      id: draft.id ?? newCustomThemeId(),
      name: draft.name.trim() || t("Custom theme"),
      variant: draft.variant,
      colors: { ...draft.colors },
    };
    onCustomThemesChange(
      draft.id
        ? customThemes.map((custom) =>
            custom.id === draft.id ? theme : custom,
          )
        : [...customThemes, theme],
    );
    onSelectionChange({ ...selection, [theme.variant]: theme.id });
    setDraft(null);
  };

  const deleteCustomTheme = (theme: CustomTerminalTheme) => {
    onCustomThemesChange(
      customThemes.filter((custom) => custom.id !== theme.id),
    );
    if (selection.dark === theme.id || selection.light === theme.id) {
      onSelectionChange({
        dark:
          selection.dark === theme.id
            ? defaultTerminalThemeId("dark")
            : selection.dark,
        light:
          selection.light === theme.id
            ? defaultTerminalThemeId("light")
            : selection.light,
      });
    }
  };

  const onCardKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    cards: ThemeCardData[],
    index: number,
    variant: ResolvedTheme,
  ) => {
    const direction =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (direction === 0) return;
    event.preventDefault();
    const nextIndex = (index + direction + cards.length) % cards.length;
    selectTheme(variant, cards[nextIndex].definition.id);
    const buttons = event.currentTarget
      .closest('[role="radiogroup"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[nextIndex]?.focus();
  };

  const limitReached = t("Custom theme limit reached ({limit})", {
    limit: MAX_CUSTOM_TERMINAL_THEMES,
  });

  const renderSection = (section: (typeof THEME_VARIANTS)[number]) => {
    const variant = section.value;
    const cards = cardsFor(variant);
    // A stale selection id (e.g. edited storage) marks no card active; keep
    // the first card tabbable so the group stays keyboard-reachable.
    const hasActive = cards.some(
      (card) => selection[variant] === card.definition.id,
    );
    return (
      <section className="terminal-theme-section" key={variant}>
        <div className="terminal-theme-section-head">
          <div>
            <strong>
              {variant === "dark" ? (
                <Moon size={14} aria-hidden="true" />
              ) : (
                <Sun size={14} aria-hidden="true" />
              )}
              {t(section.label)}
            </strong>
            <span>{t(section.usedWhen)}</span>
          </div>
          <Button
            variant="secondary"
            disabled={!canCreate}
            title={canCreate ? t(section.create) : limitReached}
            onClick={() => startNewTheme(variant)}
          >
            <Plus size={14} aria-hidden="true" />
            {t("New theme")}
          </Button>
        </div>
        <div
          className="terminal-theme-grid"
          role="radiogroup"
          aria-label={t(section.group)}
        >
          {cards.map((card, index) => {
            const active = selection[variant] === card.definition.id;
            const custom = card.custom;
            return (
              <div
                key={card.definition.id}
                className={cn("terminal-theme-card", active && "is-active")}
              >
                <Button
                  role="radio"
                  aria-checked={active}
                  tabIndex={active || (!hasActive && index === 0) ? 0 : -1}
                  className="terminal-theme-card-select"
                  onClick={() => selectTheme(variant, card.definition.id)}
                  onKeyDown={(event) =>
                    onCardKeyDown(event, cards, index, variant)
                  }
                >
                  <TerminalThemePreview
                    colors={draftColorsFromITheme(card.definition.theme)}
                  />
                  <span className="terminal-theme-card-name">
                    {active ? <Check size={13} aria-hidden="true" /> : null}
                    {card.definition.name}
                    {custom ? <Token>{t("Custom")}</Token> : null}
                  </span>
                </Button>
                <span className="terminal-theme-card-actions">
                  <IconButton
                    label={t("Duplicate {name}", {
                      name: card.definition.name,
                    })}
                    tooltip={
                      canCreate ? t("Duplicate as custom theme") : limitReached
                    }
                    icon={<Copy size={13} aria-hidden="true" />}
                    disabled={!canCreate}
                    onClick={() => duplicateTheme(card)}
                  />
                  {custom ? (
                    <>
                      <IconButton
                        label={t("Edit {name}", {
                          name: card.definition.name,
                        })}
                        tooltip={t("Edit theme")}
                        icon={<Pencil size={13} aria-hidden="true" />}
                        onClick={() => setDraft(draftFromCustom(custom))}
                      />
                      <IconButton
                        tone="danger"
                        label={t("Delete {name}", {
                          name: card.definition.name,
                        })}
                        tooltip={t("Delete theme")}
                        icon={<Trash2 size={13} aria-hidden="true" />}
                        onClick={() => setPendingDelete(custom)}
                      />
                    </>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  const renderEditor = (current: TerminalThemeDraft) => {
    const setColor = (key: TerminalThemeColorKey, value: string) => {
      setDraft({ ...current, colors: { ...current.colors, [key]: value } });
    };
    const colorField = (key: TerminalThemeColorKey) => (
      <label className="terminal-theme-color-field" key={key}>
        <input
          type="color"
          value={current.colors[key]}
          onChange={(event) => setColor(key, event.target.value)}
        />
        <span>{t(COLOR_KEY_LABELS[key])}</span>
        <code>{current.colors[key]}</code>
      </label>
    );
    return (
      <div className="terminal-theme-editor">
        <div className="terminal-theme-editor-top">
          <TextField
            className="terminal-theme-name-field"
            label={t("Theme name")}
            autoFocus
            fullWidth
            value={current.name}
            maxLength={MAX_TERMINAL_THEME_NAME_LENGTH}
            onValueChange={(name) => setDraft({ ...current, name })}
          />
          <div className="terminal-theme-variant-field">
            <span>{t("Suggested for")}</span>
            <SegmentedControl
              aria-label={t("Suggested appearance")}
              value={current.variant}
              onChange={(variant) => setDraft({ ...current, variant })}
              options={THEME_VARIANTS.map((variant) => ({
                value: variant.value,
                ariaLabel: t(variant.label),
                label:
                  variant.value === "dark" ? (
                    <Moon size={14} />
                  ) : (
                    <Sun size={14} />
                  ),
              }))}
            />
          </div>
        </div>

        <TerminalThemePreview colors={current.colors} />

        <div className="terminal-theme-color-group">
          <strong>{t("Base colors")}</strong>
          <div className="terminal-theme-color-grid">
            {TERMINAL_BASE_COLOR_KEYS.map(colorField)}
          </div>
        </div>
        <div className="terminal-theme-color-group">
          <strong>{t("ANSI colors")}</strong>
          <div className="terminal-theme-color-grid">
            {TERMINAL_ANSI_COLOR_KEYS.map(colorField)}
          </div>
        </div>

        {missingDraft ? (
          <p className="terminal-theme-alert" role="alert">
            {t(
              "This theme no longer exists. Your unsaved edits are kept here until you close the editor.",
            )}
          </p>
        ) : null}
        {!current.id && !canCreate ? (
          <p className="terminal-theme-alert" role="alert">
            {t(
              "Custom theme limit reached ({limit}). Delete a theme before creating another.",
              { limit: MAX_CUSTOM_TERMINAL_THEMES },
            )}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <Dialog
      open
      // Escape and the backdrop leave the editor first, then close.
      onOpenChange={(next) => {
        if (next) return;
        if (draft) setDraft(null);
        else onClose();
      }}
      size="lg"
      className="terminal-themes-dialog"
      title={
        draft
          ? draft.id
            ? t("Edit theme")
            : t("New theme")
          : t("Terminal Themes")
      }
      description={
        draft
          ? t("Pick colors; the preview updates as you go.")
          : t(
              "Choose a theme per appearance mode, or create your own from any preset.",
            )
      }
      closeButton={!draft}
      headerActions={
        draft ? (
          <IconButton
            label={t("Close")}
            icon={<X size={15} strokeWidth={2.2} aria-hidden="true" />}
            tooltip={false}
            onClick={onClose}
          />
        ) : null
      }
      footer={
        draft ? (
          <>
            <Button size="md" onClick={() => setDraft(null)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={
                !draft.name.trim() || missingDraft || (!draft.id && !canCreate)
              }
              onClick={saveDraft}
            >
              {draft.id ? t("Save theme") : t("Create theme")}
            </Button>
          </>
        ) : null
      }
    >
      {draft ? (
        renderEditor(draft)
      ) : (
        <div ref={listRef} className="terminal-theme-sections" tabIndex={-1}>
          {THEME_VARIANTS.map((variant) => renderSection(variant))}
        </div>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title={t("Delete theme")}
        message={t("Delete {name}? This cannot be undone.", {
          name: `"${pendingDelete?.name ?? ""}"`,
        })}
        confirmLabel={t("Delete")}
        tone="danger"
        onConfirm={() => {
          if (!pendingDelete) return;
          deleteCustomTheme(pendingDelete);
          // The deleted card took the focus-return target with it.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (!document.activeElement?.closest("[role=dialog]"))
                listRef.current?.focus({ preventScroll: true });
            }),
          );
        }}
      />
    </Dialog>
  );
}
