import { Grid2X2 } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { t } from "../../i18n";
import { mobileTerminalShortcutExecution } from "../../mobileTerminalShortcutAction";
import {
  type MobileTerminalShortcut,
  type MobileTerminalShortcutRows,
  type MobileTerminalSideShortcuts,
  mobileTerminalShortcutOption,
} from "../../mobileTerminalShortcuts";
import { store } from "../../store";
import {
  consumeTerminalModifiers,
  NO_TERMINAL_MODIFIERS,
  type TerminalModifiedInput,
  type TerminalModifier,
  type TerminalModifierState,
  tapTerminalModifier,
  terminalKeyFromData,
  terminalModifierBits,
  terminalModifiersActive,
  withTerminalModifiers,
} from "../../terminalModifiers";
import type { TerminalKey } from "../../../../shared/terminalKey";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import {
  sendTerminalBytes,
  sendTerminalKeys,
  shouldAvoidVirtualKeyboard,
  type TerminalSessionBindings,
} from "./terminalSession";

/** Ctrl/Alt/Shift latch onto the next key (tap) or stay on (double tap). */
export function useTerminalModifiers() {
  const [modifiers, setModifiers] = useState(NO_TERMINAL_MODIFIERS);
  const modifiersRef = useRef(modifiers);
  const modifierTapAtRef = useRef<Partial<Record<TerminalModifier, number>>>(
    {},
  );
  const updateModifiers = useCallback((next: TerminalModifierState) => {
    modifiersRef.current = next;
    setModifiers(next);
  }, []);
  const latched = useCallback(() => {
    const state = modifiersRef.current;
    if (!terminalModifiersActive(state)) return 0;
    return terminalModifierBits({
      ctrl: state.ctrl !== "off",
      alt: state.alt !== "off",
      shift: state.shift !== "off",
    });
  }, []);
  const consume = useCallback(
    () => updateModifiers(consumeTerminalModifiers(modifiersRef.current)),
    [updateModifiers],
  );
  const applyModifiers = useCallback(
    (data: string): TerminalModifiedInput => {
      const mods = latched();
      const key = mods ? terminalKeyFromData(data) : null;
      if (!key) return { bytes: data };
      consume();
      return { key: withTerminalModifiers(key, mods) };
    },
    [consume, latched],
  );
  const applyKeyModifiers = useCallback(
    (key: TerminalKey): TerminalKey => {
      const mods = latched();
      if (!mods || key.kind === "release") return key;
      consume();
      return withTerminalModifiers(key, mods);
    },
    [consume, latched],
  );
  const tapModifier = (modifier: TerminalModifier) => {
    const now = performance.now();
    const since =
      now - (modifierTapAtRef.current[modifier] ?? Number.NEGATIVE_INFINITY);
    modifierTapAtRef.current[modifier] = now;
    updateModifiers(tapTerminalModifier(modifiersRef.current, modifier, since));
  };
  return { modifiers, applyModifiers, applyKeyModifiers, tapModifier };
}

/** Mobile shortcut keys: control sequences, page scrolls and modifiers. */
export function terminalShortcutActions(
  {
    client,
    refs,
    applyModifiers,
    applyKeyModifiers,
    scrollPage,
  }: TerminalSessionBindings,
  { modifiers, tapModifier }: ReturnType<typeof useTerminalModifiers>,
  terminalId: string | undefined,
  viewOnly: boolean,
) {
  const blurTerminalInput = () => {
    if (shouldAvoidVirtualKeyboard()) refs.term.current?.textarea.blur();
  };
  const run = (shortcut: MobileTerminalShortcut) => {
    const execution = mobileTerminalShortcutExecution(shortcut.action);
    if (!execution) return;
    if (execution.type === "scroll") {
      scrollPage(execution.direction, execution.amount);
    } else if (execution.type === "modifier") {
      tapModifier(execution.modifier);
    } else {
      blurTerminalInput();
      const target = refs.desiredTerminal.current ?? terminalId;
      if (!target) return;
      const data = String.fromCharCode(...execution.bytes);
      // Shortcut buttons are keys too: Herdr encodes them for the pane.
      const key = terminalKeyFromData(data);
      const input = key
        ? { key: applyKeyModifiers(key) }
        : applyModifiers(data);
      if ("key" in input) sendTerminalKeys(client, [input.key], target);
      else
        sendTerminalBytes(
          client,
          new TextEncoder().encode(input.bytes),
          target,
        );
    }
  };
  const disabledReason = (shortcut: MobileTerminalShortcut) =>
    viewOnly &&
    mobileTerminalShortcutExecution(shortcut.action)?.type !== "scroll"
      ? t("This pane is view only")
      : mobileTerminalShortcutExecution(shortcut.action)?.type === "scroll" &&
          terminalId
        ? store.terminalScrollReason(terminalId)
        : null;
  // Shortcut buttons never take focus, nor leave the device keyboard up.
  const preventFocus = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    blurTerminalInput();
    e.currentTarget.blur();
  };
  return { modifiers, run, disabledReason, preventFocus };
}

type TerminalShortcuts = ReturnType<typeof terminalShortcutActions>;

function ShortcutKey({
  shortcut,
  shortcuts: { modifiers, run, disabledReason, preventFocus },
  side,
}: {
  shortcut: MobileTerminalShortcut;
  shortcuts: TerminalShortcuts;
  side?: boolean;
}) {
  const option = mobileTerminalShortcutOption(shortcut.action);
  const key = option ? t(option.label) : shortcut.label;
  const reason = disabledReason(shortcut);
  // Latched modifier keys show whether they apply to the next key or stay on.
  const modifier = option && "modifier" in option ? option.modifier : null;
  return (
    <Button
      variant="secondary"
      className="terminal-mobile-key"
      disabled={!!reason}
      title={reason ?? key}
      aria-label={side ? t("Run {key}", { key }) : t("Send {key}", { key })}
      onPointerDown={preventFocus}
      onClick={() => run(shortcut)}
      {...(modifier
        ? {
            "aria-pressed": modifiers[modifier] !== "off",
            "data-latch": modifiers[modifier],
          }
        : {})}
    >
      {shortcut.label}
    </Button>
  );
}

export function TerminalSideShortcuts({
  slots,
  shortcuts,
}: {
  slots: MobileTerminalSideShortcuts;
  shortcuts: TerminalShortcuts;
}) {
  return (
    <div
      className="terminal-mobile-side-shortcuts"
      aria-label={t("Terminal side shortcuts")}
    >
      {slots.map((shortcut, slotIndex) =>
        shortcut ? (
          <ShortcutKey
            shortcut={shortcut}
            shortcuts={shortcuts}
            side
            key={shortcut.id}
          />
        ) : (
          <span
            className="terminal-mobile-side-shortcut-spacer"
            aria-hidden="true"
            key={`mobile-side-shortcut-${slotIndex}`}
          />
        ),
      )}
    </div>
  );
}

export function TerminalShortcutGrid({
  rows,
  open,
  onToggle,
  shortcuts,
}: {
  rows: MobileTerminalShortcutRows;
  open: boolean;
  onToggle: () => void;
  shortcuts: TerminalShortcuts;
}) {
  const columns = Math.max(1, ...rows.map((row) => row.length));
  return (
    <div
      className={`terminal-mobile-keys ${open ? "is-open" : ""}`}
      aria-label={t("Terminal shortcuts")}
    >
      <IconButton
        className="terminal-mobile-keys-toggle"
        label={
          open ? t("Hide terminal shortcuts") : t("Show terminal shortcuts")
        }
        icon={<Grid2X2 size={17} />}
        aria-expanded={open}
        onPointerDown={shortcuts.preventFocus}
        onClick={onToggle}
      />
      <div className="terminal-mobile-keys-panel">
        <div
          className="terminal-mobile-keys-grid"
          style={{ "--mobile-shortcut-columns": columns } as CSSProperties}
        >
          {rows.map((row, rowIndex) => (
            <div
              className="terminal-mobile-keys-row"
              key={`mobile-shortcut-row-${rowIndex}`}
            >
              {row.map((shortcut, slotIndex) =>
                shortcut ? (
                  <ShortcutKey
                    shortcut={shortcut}
                    shortcuts={shortcuts}
                    key={shortcut.id}
                  />
                ) : (
                  <span
                    className="terminal-mobile-key-spacer"
                    aria-hidden="true"
                    key={`mobile-shortcut-${rowIndex}-${slotIndex}`}
                  />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
