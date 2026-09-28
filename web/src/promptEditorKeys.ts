import {
  matchesShortcut,
  type ShortcutBindings,
  type ShortcutEvent,
} from "./shortcutBindings";

export type PromptEditorKeyEvent = ShortcutEvent &
  Pick<KeyboardEvent, "isComposing" | "keyCode">;

export type PromptEditorKeyAction =
  /** Send the draft and press Enter. */
  | { type: "send" }
  /** Insert a line break into the draft. */
  | { type: "newline" }
  /** Pass the key to the agent: the draft is empty, so it is not text. */
  | { type: "forward"; data: string }
  /** Page through the agent's view, like the terminal's own paging keys. */
  | { type: "page"; direction: "up" | "down" };

function plain(event: PromptEditorKeyEvent) {
  return !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
}

function ctrlOnly(event: PromptEditorKeyEvent, key: string) {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (event.key.toLowerCase() === key ||
      event.code === `Key${key.toUpperCase()}`)
  );
}

/**
 * What a key press in the prompt editor does, or null to leave it to the
 * editor. The composer send shortcut (Ctrl+Enter, Cmd+Enter on macOS) sends;
 * Enter, Shift+Enter and Alt+Enter break the line. With an empty draft
 * the keys an agent reads outside its text (interrupt, history, mode toggle,
 * menus) go straight to the terminal, so they keep working with the editor
 * on top. IME composition always belongs to the editor.
 */
export function promptEditorKeyAction(
  event: PromptEditorKeyEvent,
  {
    empty,
    applicationCursor,
    bindings,
  }: {
    empty: boolean;
    applicationCursor: boolean;
    bindings: ShortcutBindings;
  },
): PromptEditorKeyAction | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if (matchesShortcut(event, "composer.send", bindings))
    return empty ? null : { type: "send" };
  if (event.key === "Enter") {
    // A plain Enter in a draft is the editor's own line break.
    if (plain(event)) return empty ? { type: "forward", data: "\r" } : null;
    if (!event.ctrlKey && !event.metaKey) return { type: "newline" };
  }
  if (!empty) return null;
  if (matchesShortcut(event, "terminal.pageUp", bindings))
    return { type: "page", direction: "up" };
  if (matchesShortcut(event, "terminal.pageDown", bindings))
    return { type: "page", direction: "down" };
  const arrow = (final: string) =>
    applicationCursor ? `\x1bO${final}` : `\x1b[${final}`;
  if (plain(event)) {
    if (event.key === "Escape") return { type: "forward", data: "\x1b" };
    if (event.key === "ArrowUp") return { type: "forward", data: arrow("A") };
    if (event.key === "ArrowDown") return { type: "forward", data: arrow("B") };
    if (event.key === "Tab") return { type: "forward", data: "\t" };
  }
  if (
    event.key === "Tab" &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  )
    return { type: "forward", data: "\x1b[Z" };
  if (ctrlOnly(event, "c")) return { type: "forward", data: "\x03" };
  if (ctrlOnly(event, "r")) return { type: "forward", data: "\x12" };
  if (ctrlOnly(event, "l")) return { type: "forward", data: "\x0c" };
  return null;
}
