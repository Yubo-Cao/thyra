import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Plus, RotateCcw, Trash2 } from "lucide-react";
import { msg, t } from "../i18n";
import {
  MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW,
  MAX_MOBILE_TERMINAL_SIDE_SHORTCUTS,
  MOBILE_TERMINAL_SHORTCUT_OPTIONS,
  defaultMobileTerminalShortcutRows,
  defaultMobileTerminalSideShortcuts,
  mobileTerminalShortcutOption,
  normalizeMobileTerminalShortcutRows,
  normalizeMobileTerminalSideShortcuts,
  type MobileTerminalShortcut,
  type MobileTerminalShortcutAction,
  type MobileTerminalShortcutRows,
  type MobileTerminalSideShortcuts,
} from "../mobileTerminalShortcuts";
import { cn } from "../utils";
import { Button } from "./ui/Button";
import { CommandList, subsequenceFilter } from "./ui/command";
import { Dialog } from "./ui/Dialog";
import { Kbd } from "./ui/Kbd";
import { Popover } from "./ui/Popover";
import { TextField } from "./ui/TextField";
import "./MobileTerminalShortcutsDialog.css";

const OPTION_GROUPS = [
  "Modifier",
  "Control",
  "Basic",
  "Navigation",
  "Modified",
] as const;
const OPTION_GROUP_LABELS: Record<(typeof OPTION_GROUPS)[number], string> = {
  Modifier: msg("Modifier"),
  Control: msg("Control"),
  Basic: msg("Basic"),
  Navigation: msg("Navigation"),
  Modified: msg("Modified keys"),
};
let nextShortcutId = 1;

type SelectedSlot =
  | {
      area: "panel";
      rowIndex: number;
      slotIndex: number;
    }
  | {
      area: "side";
      slotIndex: number;
    };

function cloneRows(
  rows: MobileTerminalShortcutRows,
): MobileTerminalShortcutRows {
  return rows.map((row) =>
    Array.from(
      { length: MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW },
      (_, slotIndex) => {
        const shortcut = row[slotIndex];
        return shortcut ? { ...shortcut } : null;
      },
    ),
  ) as MobileTerminalShortcutRows;
}

function cloneSideShortcuts(
  shortcuts: MobileTerminalSideShortcuts,
): MobileTerminalSideShortcuts {
  return Array.from(
    { length: MAX_MOBILE_TERMINAL_SIDE_SHORTCUTS },
    (_, slotIndex) => {
      const shortcut = shortcuts[slotIndex];
      return shortcut ? { ...shortcut } : null;
    },
  );
}

function newShortcut(): MobileTerminalShortcut {
  return {
    id: `custom-${Date.now()}-${nextShortcutId++}`,
    label: "Esc",
    action: "escape",
  };
}

function ShortcutKeySelect({
  value,
  ariaLabel,
  openRequest,
  onChange,
}: {
  value: MobileTerminalShortcutAction;
  ariaLabel: string;
  openRequest: number;
  onChange: (action: MobileTerminalShortcutAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const currentOption = mobileTerminalShortcutOption(value);

  const setSelectorOpen = (next: boolean) => {
    setOpen(next);
    setSearch("");
  };

  useEffect(() => {
    if (openRequest === 0) return;
    setOpen(true);
    setSearch("");
  }, [openRequest]);

  return (
    <Popover
      open={open}
      onOpenChange={setSelectorOpen}
      aria-label={ariaLabel}
      className="mobile-shortcut-key-popover"
      trigger={
        <Button
          variant="secondary"
          className="mobile-shortcut-key-trigger"
          aria-label={ariaLabel}
        >
          <span>{currentOption ? t(currentOption.label) : value}</span>
          <ChevronsUpDown size={13} aria-hidden="true" />
        </Button>
      }
    >
      <ShortcutKeyList
        value={value}
        search={search}
        onSearchChange={setSearch}
        onSelect={(action) => {
          onChange(action);
          setSelectorOpen(false);
        }}
      />
    </Popover>
  );
}

/** The searchable key list; focuses the current key when it opens. */
function ShortcutKeyList({
  value,
  search,
  onSearchChange,
  onSelect,
}: {
  value: MobileTerminalShortcutAction;
  search: string;
  onSearchChange: (search: string) => void;
  onSelect: (action: MobileTerminalShortcutAction) => void;
}) {
  return (
    <CommandList
      className="mobile-shortcut-key-command"
      search={search}
      onSearchChange={onSearchChange}
      placeholder={t("Search keys...")}
      inputLabel={t("Search terminal keys")}
      emptyText={t("No matching keys.")}
      filter={subsequenceFilter}
      focusCurrent
      onAction={(id) => onSelect(id as MobileTerminalShortcutAction)}
      sections={OPTION_GROUPS.map((group) => ({
        heading: t(OPTION_GROUP_LABELS[group]),
        items: MOBILE_TERMINAL_SHORTCUT_OPTIONS.filter(
          (option) => option.group === group,
        ).map((option) => ({
          id: option.id,
          textValue: [
            option.id,
            option.label,
            t(option.label),
            option.defaultButtonLabel,
            group,
            t(OPTION_GROUP_LABELS[group]),
          ].join(" "),
          current: option.id === value,
          className: "mobile-shortcut-key-option",
          "aria-label":
            option.id === value
              ? t("{key}, selected", { key: t(option.label) })
              : t(option.label),
          children: (
            <>
              <span>{t(option.label)}</span>
              <Kbd>{option.defaultButtonLabel}</Kbd>
              <Check size={13} aria-hidden="true" />
            </>
          ),
        })),
      }))}
    />
  );
}

function ShortcutSlot({
  shortcut,
  selected,
  side = false,
  label,
  title,
  emptyNumber,
  onClick,
}: {
  shortcut: MobileTerminalShortcut | null;
  selected: boolean;
  side?: boolean;
  label: string;
  title: string;
  emptyNumber: number;
  onClick: () => void;
}) {
  const option = shortcut
    ? mobileTerminalShortcutOption(shortcut.action)
    : null;
  return (
    <Button
      className={cn(
        "mobile-shortcut-slot",
        side && "mobile-shortcut-side-slot",
        shortcut ? "is-filled" : "is-empty",
      )}
      aria-label={label}
      aria-pressed={selected}
      title={title}
      onClick={onClick}
    >
      {shortcut ? (
        <>
          <strong>{shortcut.label}</strong>
          <span>{option ? t(option.label) : shortcut.action}</span>
        </>
      ) : (
        <>
          <Plus size={15} aria-hidden="true" />
          <span>{emptyNumber}</span>
        </>
      )}
    </Button>
  );
}

export function MobileTerminalShortcutsDialog({
  open,
  rows,
  sideShortcuts,
  onChange,
  onSideChange,
  onClose,
}: {
  open: boolean;
  rows: MobileTerminalShortcutRows;
  sideShortcuts: MobileTerminalSideShortcuts;
  onChange: (rows: MobileTerminalShortcutRows) => void;
  onSideChange: (shortcuts: MobileTerminalSideShortcuts) => void;
  onClose: () => void;
}) {
  const rowsRef = useRef(rows);
  const sideShortcutsRef = useRef(sideShortcuts);
  rowsRef.current = rows;
  sideShortcutsRef.current = sideShortcuts;
  const [draft, setDraft] = useState<MobileTerminalShortcutRows>(() =>
    cloneRows(rows),
  );
  const [sideDraft, setSideDraft] = useState<MobileTerminalSideShortcuts>(() =>
    cloneSideShortcuts(sideShortcuts),
  );
  const [selectedSlot, setSelectedSlot] = useState<SelectedSlot | null>(null);
  const [keySelectorOpenRequest, setKeySelectorOpenRequest] = useState(0);

  useEffect(() => {
    if (!open) return;
    setDraft(cloneRows(rowsRef.current));
    setSideDraft(cloneSideShortcuts(sideShortcutsRef.current));
    setSelectedSlot(null);
    setKeySelectorOpenRequest(0);
  }, [open]);

  if (!open) return null;

  const selectPanelSlot = (rowIndex: number, slotIndex: number) => {
    setDraft((current) => {
      if (current[rowIndex][slotIndex]) return current;
      const next = cloneRows(current);
      next[rowIndex][slotIndex] = newShortcut();
      return next;
    });
    setSelectedSlot({ area: "panel", rowIndex, slotIndex });
    setKeySelectorOpenRequest((request) => request + 1);
  };

  const selectSideSlot = (slotIndex: number) => {
    setSideDraft((current) => {
      if (current[slotIndex]) return current;
      const next = cloneSideShortcuts(current);
      next[slotIndex] = newShortcut();
      return next;
    });
    setSelectedSlot({ area: "side", slotIndex });
    setKeySelectorOpenRequest((request) => request + 1);
  };

  const updateSelectedShortcut = (
    update: (shortcut: MobileTerminalShortcut) => MobileTerminalShortcut,
  ) => {
    if (!selectedSlot) return;
    if (selectedSlot.area === "side") {
      setSideDraft((current) => {
        const shortcut = current[selectedSlot.slotIndex];
        if (!shortcut) return current;
        const next = cloneSideShortcuts(current);
        next[selectedSlot.slotIndex] = update(shortcut);
        return next;
      });
      return;
    }
    setDraft((current) => {
      const shortcut = current[selectedSlot.rowIndex][selectedSlot.slotIndex];
      if (!shortcut) return current;
      const next = cloneRows(current);
      next[selectedSlot.rowIndex][selectedSlot.slotIndex] = update(shortcut);
      return next;
    });
  };

  const clearSelectedSlot = () => {
    if (!selectedSlot) return;
    // The editor (and this button) unmounts; keep focus on the cleared slot.
    const slot = document.querySelector<HTMLButtonElement>(
      ".mobile-shortcut-slot[aria-pressed='true']",
    );
    requestAnimationFrame(() => slot?.focus({ preventScroll: true }));
    if (selectedSlot.area === "side") {
      setSideDraft((current) => {
        const next = cloneSideShortcuts(current);
        next[selectedSlot.slotIndex] = null;
        return next;
      });
    } else {
      setDraft((current) => {
        const next = cloneRows(current);
        next[selectedSlot.rowIndex][selectedSlot.slotIndex] = null;
        return next;
      });
    }
    setSelectedSlot(null);
  };

  const selectedShortcut = selectedSlot
    ? selectedSlot.area === "side"
      ? sideDraft[selectedSlot.slotIndex]
      : draft[selectedSlot.rowIndex][selectedSlot.slotIndex]
    : null;
  const selectedOption = selectedShortcut
    ? mobileTerminalShortcutOption(selectedShortcut.action)
    : null;
  const describe = (shortcut: MobileTerminalShortcut) => {
    const option = mobileTerminalShortcutOption(shortcut.action);
    return option ? t(option.label) : shortcut.action;
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      className="mobile-shortcuts-dialog"
      title={t("Mobile Terminal Shortcuts")}
      description={t(
        "Select any slot to add or edit a button. Configure the 2-by-8 panel and up to four right-side buttons.",
      )}
      footer={
        <>
          <Button
            className="mobile-shortcuts-restore"
            size="md"
            onClick={() => {
              setDraft(defaultMobileTerminalShortcutRows());
              setSideDraft(defaultMobileTerminalSideShortcuts());
              setSelectedSlot(null);
            }}
          >
            <RotateCcw size={14} />
            {t("Restore defaults")}
          </Button>
          <Button size="md" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              onChange(normalizeMobileTerminalShortcutRows(draft));
              onSideChange(normalizeMobileTerminalSideShortcuts(sideDraft));
              onClose();
            }}
          >
            {t("Save shortcuts")}
          </Button>
        </>
      }
    >
      <div className="mobile-shortcuts-body">
        <div
          className="mobile-shortcut-slot-board"
          aria-label={t("Shortcut slots")}
        >
          {draft.map((row, rowIndex) => (
            <section
              className="mobile-shortcut-slot-row"
              key={`row-${rowIndex}`}
            >
              <div className="mobile-shortcut-slot-row-label">
                <strong>{t("Row {row}", { row: rowIndex + 1 })}</strong>
                <span>
                  {row.filter(Boolean).length} /{" "}
                  {MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW}
                </span>
              </div>
              <div className="mobile-shortcut-slot-grid">
                {row.map((shortcut, slotIndex) => (
                  <ShortcutSlot
                    key={`slot-${rowIndex}-${slotIndex}`}
                    shortcut={shortcut}
                    selected={
                      selectedSlot?.area === "panel" &&
                      selectedSlot.rowIndex === rowIndex &&
                      selectedSlot.slotIndex === slotIndex
                    }
                    emptyNumber={slotIndex + 1}
                    label={
                      shortcut
                        ? t("Edit row {row} slot {slot}, {label}, {key}", {
                            row: rowIndex + 1,
                            slot: slotIndex + 1,
                            label: shortcut.label,
                            key: describe(shortcut),
                          })
                        : t("Add button to row {row} slot {slot}", {
                            row: rowIndex + 1,
                            slot: slotIndex + 1,
                          })
                    }
                    title={
                      shortcut
                        ? `${shortcut.label} · ${describe(shortcut)}`
                        : t("Add button to slot {slot}", {
                            slot: slotIndex + 1,
                          })
                    }
                    onClick={() => selectPanelSlot(rowIndex, slotIndex)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>

        <section
          className="mobile-shortcut-side-board"
          aria-label={t("Right-side shortcut slots")}
        >
          <div className="mobile-shortcut-side-head">
            <div>
              <strong>{t("Right-side buttons")}</strong>
              <span>{t("Original Up / Dn position, top to bottom")}</span>
            </div>
            <span>{sideDraft.filter(Boolean).length} / 4</span>
          </div>
          <div className="mobile-shortcut-side-grid">
            {sideDraft.map((shortcut, slotIndex) => (
              <ShortcutSlot
                key={`side-slot-${slotIndex}`}
                side
                shortcut={shortcut}
                selected={
                  selectedSlot?.area === "side" &&
                  selectedSlot.slotIndex === slotIndex
                }
                emptyNumber={slotIndex + 1}
                label={
                  shortcut
                    ? t("Edit side slot {slot}, {label}, {key}", {
                        slot: slotIndex + 1,
                        label: shortcut.label,
                        key: describe(shortcut),
                      })
                    : t("Add button to side slot {slot}", {
                        slot: slotIndex + 1,
                      })
                }
                title={
                  shortcut
                    ? `${shortcut.label} · ${describe(shortcut)}`
                    : t("Add side button {slot}", { slot: slotIndex + 1 })
                }
                onClick={() => selectSideSlot(slotIndex)}
              />
            ))}
          </div>
        </section>

        <section
          className={cn(
            "mobile-shortcut-slot-editor",
            selectedShortcut && "is-active",
          )}
          aria-live="polite"
        >
          {selectedShortcut && selectedSlot ? (
            <>
              <div className="mobile-shortcut-slot-editor-head">
                <div>
                  <strong>
                    {selectedSlot.area === "side"
                      ? t("Right-side slot {slot}", {
                          slot: selectedSlot.slotIndex + 1,
                        })
                      : t("Row {row}, slot {slot}", {
                          row: selectedSlot.rowIndex + 1,
                          slot: selectedSlot.slotIndex + 1,
                        })}
                  </strong>
                  <span>{t("Edit this button in place")}</span>
                </div>
                <Button variant="danger-soft" onClick={clearSelectedSlot}>
                  <Trash2 size={14} />
                  {t("Clear slot")}
                </Button>
              </div>
              <div className="mobile-shortcut-slot-editor-fields">
                <TextField
                  label={t("Label")}
                  fullWidth
                  value={selectedShortcut.label}
                  maxLength={10}
                  aria-label={
                    selectedSlot.area === "side"
                      ? t("Side slot {slot} label", {
                          slot: selectedSlot.slotIndex + 1,
                        })
                      : t("Row {row} slot {slot} label", {
                          row: selectedSlot.rowIndex + 1,
                          slot: selectedSlot.slotIndex + 1,
                        })
                  }
                  onValueChange={(label) =>
                    updateSelectedShortcut((current) => ({ ...current, label }))
                  }
                />
                <div className="mobile-shortcut-field">
                  <span>{t("Key")}</span>
                  <ShortcutKeySelect
                    value={selectedShortcut.action}
                    openRequest={keySelectorOpenRequest}
                    ariaLabel={
                      selectedSlot.area === "side"
                        ? t("Side slot {slot} key", {
                            slot: selectedSlot.slotIndex + 1,
                          })
                        : t("Row {row} slot {slot} key", {
                            row: selectedSlot.rowIndex + 1,
                            slot: selectedSlot.slotIndex + 1,
                          })
                    }
                    onChange={(action) => {
                      const nextOption = mobileTerminalShortcutOption(action);
                      updateSelectedShortcut((current) => ({
                        ...current,
                        action,
                        label:
                          !current.label.trim() ||
                          current.label === selectedOption?.defaultButtonLabel
                            ? (nextOption?.defaultButtonLabel ?? current.label)
                            : current.label,
                      }));
                    }}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="mobile-shortcut-slot-editor-empty">
              {t(
                "Select a filled button to edit it, or select an empty + slot to add one.",
              )}
            </div>
          )}
        </section>
      </div>
    </Dialog>
  );
}
