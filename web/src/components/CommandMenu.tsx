import { ChevronsUpDown, Keyboard } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  forwardRef,
  useEffect,
  useState,
} from "react";
import { t } from "../i18n";
import { lazyPanel } from "../lazyWithReload";
import { shortcutMatches, shortcutTitle } from "../shortcutPreferences";
import type { CommandComboboxProps } from "./CommandCombobox";
import { LazyBoundary } from "./LazyBoundary";
// The trigger's styles (.command-trigger) live with the command primitives.
import "./ui/command.css";

// The command menu (cmdk, Radix popover, action dialogs) loads on the first
// open; this shell owns the trigger and the shortcut until then.
export const commandComboboxPanel = lazyPanel("command-menu", () =>
  import("./CommandCombobox").then((module) => module.CommandCombobox),
);

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function isCommandMenuShortcut(e: KeyboardEvent) {
  // The pane switcher owns K even when its held modifiers match this
  // shortcut. Both handlers run on window, so listener order cannot decide.
  if (
    e.defaultPrevented ||
    document.querySelector(".modal-backdrop, .pane-jump-backdrop")
  )
    return false;
  if (!shortcutMatches(e, "command.menu") || e.repeat) return false;
  return !(
    isTypingTarget(e.target) &&
    !(e.target as HTMLElement).closest(".command-popover, .xterm")
  );
}

export const CommandMenuTrigger = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }
>(function CommandMenuTrigger({ active, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`topbar-button command-trigger ${active ? "is-active" : ""}${className ? ` ${className}` : ""}`}
      aria-label={t("Open command menu")}
      title={shortcutTitle(t("Open command menu"), "command.menu")}
      {...props}
    >
      <Keyboard size={15} />
      <span>{t("Actions")}</span>
      <ChevronsUpDown size={14} />
    </button>
  );
});

export function CommandMenu(props: Omit<CommandComboboxProps, "defaultOpen">) {
  const Panel = commandComboboxPanel.Component;
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isCommandMenuShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setMounted(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mounted]);
  const pendingTrigger = <CommandMenuTrigger active aria-busy="true" />;
  if (!mounted) {
    return (
      <CommandMenuTrigger
        active={false}
        aria-haspopup="dialog"
        aria-expanded={false}
        onPointerEnter={() => void commandComboboxPanel.preload()}
        onFocus={() => void commandComboboxPanel.preload()}
        onClick={() => setMounted(true)}
      />
    );
  }
  return (
    <LazyBoundary fallback={pendingTrigger}>
      <Panel {...props} defaultOpen />
    </LazyBoundary>
  );
}
