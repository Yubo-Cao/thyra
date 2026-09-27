import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/Button";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Dialog } from "./ui/Dialog";
import { Kbd } from "./ui/Kbd";
import { SearchField } from "./ui/SearchField";
import { Select } from "./ui/Select";
import { TextField } from "./ui/TextField";
import { t } from "../i18n";
import { SHORTCUT_CATALOG, shortcutDescriptionLabel } from "../shortcutCatalog";
import {
  defaultShortcutBindings,
  formatShortcut,
  SHORTCUT_PLATFORMS,
  shortcutConflicts,
  shortcutFromEvent,
  shortcutWarning,
  validateShortcutKeys,
  type ShortcutId,
} from "../shortcutBindings";
import {
  deleteShortcutPreset,
  exportShortcutPreset,
  importShortcutPreset,
  saveShortcutPreset,
  selectShortcutPreset,
  updateShortcut,
  useShortcutPreferences,
} from "../shortcutPreferences";
import "./ShortcutLookupDialog.css";

export function ShortcutLookupDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { preferences, platform, preset, storageError } =
    useShortcutPreferences();
  const fileRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<ShortcutId | null>(null);
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const custom = preferences.presets.some((item) => item.id === preset.id);
  const format = (keys: string[]) =>
    keys.map((key) => formatShortcut(key, platform)).join(" / ") ||
    t("Unassigned");
  const clearEditor = () => {
    setEditing(null);
    setRecording(false);
    setError("");
    setDeleting(false);
  };
  const attempt = (action: () => void) => {
    try {
      action();
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Closing a binding editor removes the focused control: return focus to
  // the row's Edit button so Escape and Tab keep working in the dialog.
  const lastEditing = useRef<ShortcutId | null>(null);
  useEffect(() => {
    const previous = lastEditing.current;
    lastEditing.current = editing;
    if (editing || !previous) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      document
        .querySelector<HTMLButtonElement>(
          `[data-shortcut-id="${CSS.escape(previous)}"] .keybinding-edit`,
        )
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  // Recording takes every key, Escape included; otherwise Escape closes an
  // open binding editor before it reaches the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (recording) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === "Escape") {
          setRecording(false);
          return;
        }
        if (["Control", "Alt", "Meta", "Shift"].includes(event.key)) return;
        const binding = shortcutFromEvent(event);
        if (!binding) {
          setError(t("That key cannot be recorded. Try another combination."));
          return;
        }
        setDraft(binding);
        setRecording(false);
        setError("");
        saveRef.current?.focus();
      } else if (
        event.key === "Escape" &&
        editing &&
        !deleting &&
        !document.querySelector(".ui-select-popover")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setEditing(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, recording, editing, deleting]);

  const visible = SHORTCUT_CATALOG.filter((item) =>
    `${item.label} ${shortcutDescriptionLabel(item)} ${item.group} ${t(item.group)} ${format(preset.bindings[item.id])}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const groups = [...new Set(visible.map((item) => item.group))];
  const exportPreset = () => {
    const url = URL.createObjectURL(
      new Blob([exportShortcutPreset(preset)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${preset.name.replace(/[^a-z0-9-]/gi, "-")}-keybindings.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      className="shortcut-modal"
      bodyClassName="shortcut-body"
      title={t("Keyboard shortcuts")}
      description={t(
        "Choose a preset or customize shortcuts for this browser.",
      )}
      closeLabel={t("Close keyboard shortcuts")}
      footer={
        <>
          <span className="shortcut-footer-note">
            {t(
              "Presets are saved in this browser. Export to use them elsewhere.",
            )}
          </span>
          <Button variant="primary" size="md" onClick={onClose}>
            {t("Done")}
          </Button>
        </>
      }
    >
      <div className="keybinding-settings">
        <label className="keybinding-preset">
          <span>{t("Active preset")}</span>
          <Select
            aria-label={t("Active preset")}
            fullWidth
            value={preferences.active}
            options={[
              {
                value: "auto",
                label: t("Automatic ({platform})", {
                  platform: SHORTCUT_PLATFORMS[platform],
                }),
              },
              ...Object.entries(SHORTCUT_PLATFORMS).map(([id, label]) => ({
                value: id,
                label,
              })),
              ...preferences.presets.map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
            onChange={(preset) =>
              attempt(() => {
                selectShortcutPreset(preset);
                clearEditor();
              })
            }
          />
        </label>
        <div className="keybinding-preset-actions">
          <TextField
            className="keybinding-preset-name"
            aria-label={t("New preset name")}
            placeholder={t("New preset name")}
            value={name}
            maxLength={64}
            onValueChange={setName}
          />
          <Button
            variant="secondary"
            aria-disabled={!name.trim()}
            onClick={() =>
              name.trim() &&
              attempt(() => {
                saveShortcutPreset(name);
                setName("");
                clearEditor();
              })
            }
          >
            {t("Save as")}
          </Button>
          <Button onClick={exportPreset}>{t("Export")}</Button>
          <Button onClick={() => fileRef.current?.click()}>
            {t("Import")}
          </Button>
          {custom ? (
            <Button variant="danger-soft" onClick={() => setDeleting(true)}>
              {t("Delete")}
            </Button>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              try {
                if (file.size > 100_000)
                  throw new Error(
                    t("Preset files must be smaller than 100 KB."),
                  );
                const imported = importShortcutPreset(await file.text());
                saveShortcutPreset(imported.name, imported);
                clearEditor();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        </div>
        <p className="muted">
          {custom
            ? t("Detected {platform}. Edits save to this preset immediately.", {
                platform: SHORTCUT_PLATFORMS[platform],
              })
            : t(
                "Detected {platform}. Editing a built-in preset creates a custom copy.",
                { platform: SHORTCUT_PLATFORMS[platform] },
              )}
        </p>
        <SearchField
          ref={searchRef}
          fullWidth
          aria-label={t("Search shortcuts")}
          placeholder={t("Search shortcuts...")}
          value={search}
          onValueChange={setSearch}
        />
        {error || storageError ? (
          <p className="keybinding-error" role="alert">
            {error || storageError}
          </p>
        ) : null}
      </div>
      <div className="shortcut-list">
        {groups.map((group) => (
          <section className="shortcut-section" key={group}>
            <h3>{t(group)}</h3>
            <dl>
              {visible
                .filter((item) => item.group === group)
                .map((item) => (
                  <div
                    className="shortcut-row"
                    key={item.id}
                    data-shortcut-id={item.id}
                  >
                    <dt>{shortcutDescriptionLabel(item)}</dt>
                    <dd>
                      <Button
                        className="keybinding-edit"
                        fullWidth
                        aria-label={t("Edit {action}", {
                          action: shortcutDescriptionLabel(item),
                        })}
                        onClick={() => {
                          setEditing(item.id);
                          setDraft(preset.bindings[item.id].join("; "));
                          setRecording(false);
                          setError("");
                        }}
                      >
                        <Kbd>{format(preset.bindings[item.id])}</Kbd>
                        <span>{t("Edit")}</span>
                      </Button>
                    </dd>
                    {editing === item.id ? (
                      <div className="keybinding-editor">
                        <TextField
                          label={t("Key combinations")}
                          fullWidth
                          aria-label={t("Keys for {action}", {
                            action: shortcutDescriptionLabel(item),
                          })}
                          value={draft}
                          placeholder="Ctrl+Alt+K"
                          onValueChange={(value) => {
                            setDraft(value);
                            setError("");
                          }}
                        />
                        <div className="keybinding-editor-actions">
                          <Button
                            disabled={item.id === "terminal.link"}
                            aria-pressed={recording}
                            onClick={() => {
                              setRecording(!recording);
                              setError("");
                            }}
                          >
                            {recording
                              ? t("Press keys (Esc cancels)")
                              : t("Record")}
                          </Button>
                          <Button
                            ref={saveRef}
                            variant="secondary"
                            onClick={() =>
                              attempt(() => {
                                const keys = validateShortcutKeys(
                                  item.id,
                                  draft.trim() ? draft.split(";") : [],
                                );
                                const conflicts = shortcutConflicts(
                                  item.id,
                                  keys,
                                  preset.bindings,
                                );
                                if (conflicts.length)
                                  throw new Error(
                                    t(
                                      "Already used by: {actions}. Change that shortcut first.",
                                      {
                                        actions: conflicts
                                          .map((id) => {
                                            const entry = SHORTCUT_CATALOG.find(
                                              (entry) => entry.id === id,
                                            );
                                            return entry
                                              ? shortcutDescriptionLabel(entry)
                                              : id;
                                          })
                                          .join(t(", ")),
                                      },
                                    ),
                                  );
                                updateShortcut(item.id, keys);
                                clearEditor();
                              })
                            }
                          >
                            {t("Save binding")}
                          </Button>
                          <Button
                            onClick={() =>
                              attempt(() => {
                                updateShortcut(item.id, []);
                                clearEditor();
                              })
                            }
                          >
                            {t("Unassign")}
                          </Button>
                          <Button
                            onClick={() =>
                              setDraft(
                                defaultShortcutBindings(preset.base)[
                                  item.id
                                ].join("; "),
                              )
                            }
                          >
                            {t("Default")}
                          </Button>
                          <Button onClick={clearEditor}>{t("Cancel")}</Button>
                        </div>
                        <p className="muted">
                          {item.id === "terminal.link"
                            ? t(
                                "Separate alternatives with a semicolon. Letter and number shortcuts use physical keys. For links, enter a modifier plus Click.",
                              )
                            : t(
                                "Separate alternatives with a semicolon. Letter and number shortcuts use physical keys. Escape and ordinary dialog navigation stay available.",
                              )}
                        </p>
                        {shortcutWarning(draft.split(";")) ? (
                          <p className="muted">
                            {shortcutWarning(draft.split(";"))}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
            </dl>
          </section>
        ))}
        {visible.length === 0 ? (
          <p className="muted">{t("No matching shortcuts.")}</p>
        ) : null}
        {!search ? (
          <section className="shortcut-section keybinding-reference">
            <h3>{t("Navigation & native controls")}</h3>
            <p>
              {t(
                "Escape closes menus and dialogs or dismisses notifications. Tab moves focus; arrow keys and Enter navigate lists. In the recent pane switcher, use Up/Down and Enter, or release the modifier used to open it.",
              )}
            </p>
            <p>
              {t(
                "Terminal copy uses the selected text; Ctrl+C remains terminal input unless reassigned. Page Up/Down follows the application or shell, while half-page shortcuts scroll terminal history. Native text editing and editor search navigation follow those applications. Browser and operating system shortcuts may take precedence over configured bindings.",
              )}
            </p>
            <p>
              {t(
                "Touch controls have their own editor: Behavior & automation → Mobile terminal shortcuts configures the two shortcut rows and four side buttons.",
              )}
            </p>
          </section>
        ) : null}
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("Delete preset")}
        message={t("Delete “{name}”?", { name: preset.name })}
        confirmLabel={t("Delete preset")}
        tone="danger"
        onConfirm={() => {
          deleteShortcutPreset(preset.id);
          clearEditor();
          // The Delete button that opened the confirmation is gone now.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (!document.activeElement?.closest("[role=dialog]"))
                searchRef.current?.focus({ preventScroll: true });
            }),
          );
        }}
      />
    </Dialog>
  );
}
