import { describe, expect, test } from "bun:test";
import {
  type PromptEditorKeyEvent,
  promptEditorKeyAction,
} from "./promptEditorKeys";
import { defaultShortcutBindings } from "./shortcutBindings";

const linux = defaultShortcutBindings("linux");
const mac = defaultShortcutBindings("mac");

function key(
  keyName: string,
  modifiers: Partial<PromptEditorKeyEvent> = {},
): PromptEditorKeyEvent {
  return {
    key: keyName,
    code: /^[a-z]$/i.test(keyName) ? `Key${keyName.toUpperCase()}` : keyName,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    ...modifiers,
  };
}

const draft = { empty: false, applicationCursor: false, bindings: linux };
const empty = { empty: true, applicationCursor: false, bindings: linux };

describe("prompt editor keys", () => {
  test("Enter, Shift+Enter and Alt+Enter break the line", () => {
    // The editor's own Enter inserts the break, keeping auto-indent, suggest
    // and undo intact.
    expect(promptEditorKeyAction(key("Enter"), draft)).toBeNull();
    expect(
      promptEditorKeyAction(key("Enter", { shiftKey: true }), draft),
    ).toEqual({ type: "newline" });
    expect(
      promptEditorKeyAction(key("Enter", { altKey: true }), draft),
    ).toEqual({ type: "newline" });
    expect(
      promptEditorKeyAction(key("Enter", { shiftKey: true }), empty),
    ).toEqual({ type: "newline" });
  });

  test("an empty draft sends nothing", () => {
    expect(
      promptEditorKeyAction(key("Enter", { ctrlKey: true }), empty),
    ).toBeNull();
  });

  test("Ctrl+Enter (Cmd+Enter on macOS) sends", () => {
    expect(
      promptEditorKeyAction(key("Enter", { ctrlKey: true }), draft),
    ).toEqual({ type: "send" });
    expect(
      promptEditorKeyAction(key("Enter", { metaKey: true }), {
        ...draft,
        bindings: mac,
      }),
    ).toEqual({ type: "send" });
  });

  test("IME composition keeps every key, Enter included", () => {
    expect(
      promptEditorKeyAction(
        key("Enter", { ctrlKey: true, isComposing: true }),
        draft,
      ),
    ).toBeNull();
    expect(
      promptEditorKeyAction(key("Enter", { keyCode: 229 }), empty),
    ).toBeNull();
    expect(
      promptEditorKeyAction(key("Escape", { isComposing: true }), empty),
    ).toBeNull();
  });

  test("an empty draft forwards agent control keys", () => {
    const cases: [PromptEditorKeyEvent, string][] = [
      [key("Enter"), "\r"],
      [key("Escape"), "\x1b"],
      [key("c", { ctrlKey: true }), "\x03"],
      [key("ArrowUp"), "\x1b[A"],
      [key("ArrowDown"), "\x1b[B"],
      [key("Tab"), "\t"],
      [key("Tab", { shiftKey: true }), "\x1b[Z"],
      [key("r", { ctrlKey: true }), "\x12"],
      [key("l", { ctrlKey: true }), "\x0c"],
    ];
    for (const [event, data] of cases)
      expect(promptEditorKeyAction(event, empty)).toEqual({
        type: "forward",
        data,
      });
  });

  test("arrows follow the terminal's cursor key mode", () => {
    expect(
      promptEditorKeyAction(key("ArrowUp"), {
        ...empty,
        applicationCursor: true,
      }),
    ).toEqual({ type: "forward", data: "\x1bOA" });
  });

  test("page keys page the agent through the terminal bindings", () => {
    expect(promptEditorKeyAction(key("PageUp"), empty)).toEqual({
      type: "page",
      direction: "up",
    });
    expect(promptEditorKeyAction(key("PageDown"), empty)).toEqual({
      type: "page",
      direction: "down",
    });
  });

  test("a draft keeps editing keys for the editor", () => {
    for (const event of [
      key("Escape"),
      key("c", { ctrlKey: true }),
      key("ArrowUp"),
      key("Tab"),
      key("PageUp"),
      key("d", { ctrlKey: true }),
      key("l", { ctrlKey: true, shiftKey: true }),
    ])
      expect(promptEditorKeyAction(event, draft)).toBeNull();
  });

  test("editor shortcuts are never forwarded, even when empty", () => {
    for (const event of [
      key("d", { ctrlKey: true }),
      key("f", { ctrlKey: true }),
      key("l", { ctrlKey: true, shiftKey: true }),
      key("c", { metaKey: true }),
    ])
      expect(promptEditorKeyAction(event, empty)).toBeNull();
  });
});
