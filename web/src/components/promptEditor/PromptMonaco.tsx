import { useEffect, useLayoutEffect, useRef } from "react";
import { applyMonacoTheme, monaco } from "../../monacoBase";
import type { PromptEditorSurface, PromptEditorSurfaceProps } from "./surface";

const FIND_WIDGET_HEIGHT = 36;

/**
 * The prompt editor's rich surface: Monaco with multi-cursor (Ctrl/Cmd+D,
 * Alt+click, Ctrl+Shift+L), find and Markdown highlighting. It takes over
 * from the plain textarea once loaded, keeping the text and selection.
 */
export function PromptMonaco({
  surfaceRef,
  initialText,
  initialSelection,
  focus,
  placeholder,
  label,
  font,
  theme,
  onChange,
  onKey,
  onPasteFiles,
  onContentHeight,
  onCompositionChange,
}: PromptEditorSurfaceProps & { theme: "dark" | "light" }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef({
    onChange,
    onKey,
    onPasteFiles,
    onContentHeight,
    onCompositionChange,
  });
  latest.current = {
    onChange,
    onKey,
    onPasteFiles,
    onContentHeight,
    onCompositionChange,
  };

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    applyMonacoTheme(theme);
    const model = monaco.editor.createModel(initialText, "markdown");
    const editor = monaco.editor.create(container, {
      model,
      automaticLayout: true,
      // A textarea, not EditContext: the terminal and the app shortcuts
      // recognise it as an editor that owns its keys and focus.
      editContext: false,
      fontFamily: font.family,
      fontSize: font.size,
      lineHeight: font.lineHeight,
      wordWrap: "on",
      wrappingIndent: "none",
      minimap: { enabled: false },
      lineNumbers: "off",
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 0,
      lineNumbersMinChars: 0,
      renderLineHighlight: "none",
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollBeyondLastLine: false,
      scrollbar: {
        vertical: "auto",
        horizontal: "hidden",
        verticalScrollbarSize: 6,
        alwaysConsumeMouseWheel: false,
      },
      padding: { top: 0, bottom: 0 },
      quickSuggestions: false,
      wordBasedSuggestions: "off",
      suggestOnTriggerCharacters: false,
      occurrencesHighlight: "off",
      guides: { indentation: false },
      bracketPairColorization: { enabled: false },
      matchBrackets: "never",
      // The find widget floats over the text instead of pushing it down,
      // which would shift the lines off the terminal rows.
      find: { addExtraSpaceOnTop: false },
      fixedOverflowWidgets: true,
      placeholder,
      ariaLabel: label,
      tabSize: 2,
      insertSpaces: true,
      unicodeHighlight: {
        ambiguousCharacters: false,
        invisibleCharacters: false,
      },
    });
    editorRef.current = editor;
    const offset = (position: monaco.IPosition) => model.getOffsetAt(position);
    const select = (start: number, end: number) => {
      const from = model.getPositionAt(start);
      const to = model.getPositionAt(end);
      editor.setSelection(
        new monaco.Selection(
          from.lineNumber,
          from.column,
          to.lineNumber,
          to.column,
        ),
      );
    };
    if (initialSelection) select(initialSelection.start, initialSelection.end);
    else select(initialText.length, initialText.length);
    // The find widget needs about two rows; the editor grows while it shows
    // rather than clipping it.
    const findState = editor
      .getContribution<
        monaco.editor.IEditorContribution & {
          getState(): {
            isRevealed: boolean;
            onFindReplaceStateChange: monaco.IEvent<unknown>;
          };
        }
      >("editor.contrib.findController")
      ?.getState();
    const reportHeight = () =>
      latest.current.onContentHeight(
        Math.max(
          editor.getContentHeight(),
          findState?.isRevealed ? FIND_WIDGET_HEIGHT : 0,
        ),
      );
    const report = () => {
      const selection = editor.getSelection();
      latest.current.onChange(
        model.getValue(),
        selection ? offset(selection.getStartPosition()) : 0,
        selection ? offset(selection.getEndPosition()) : 0,
      );
    };
    const disposables = [
      model.onDidChangeContent(report),
      editor.onDidChangeCursorSelection(report),
      editor.onDidContentSizeChange(reportHeight),
      editor.onKeyDown((event) => {
        if (
          latest.current.onKey(event.browserEvent, model.getValueLength() === 0)
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }),
    ];
    const textarea = container.querySelector("textarea");
    const composition = (composing: boolean) => () =>
      latest.current.onCompositionChange(composing);
    const onCompositionStart = composition(true);
    const onCompositionEnd = composition(false);
    textarea?.addEventListener("compositionstart", onCompositionStart);
    textarea?.addEventListener("compositionend", onCompositionEnd);
    // Images on the clipboard upload instead of pasting; text pastes go on.
    const onPaste = (event: ClipboardEvent) => {
      if (!latest.current.onPasteFiles(event.clipboardData)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    container.addEventListener("paste", onPaste, true);
    const surface: PromptEditorSurface = {
      focus: () => editor.focus(),
      hasFocus: () => editor.hasTextFocus(),
      selection: () => {
        const selection = editor.getSelection();
        return selection
          ? {
              start: offset(selection.getStartPosition()),
              end: offset(selection.getEndPosition()),
            }
          : null;
      },
      setText: (text, caret) => {
        if (model.getValue() === text) return;
        // One undoable edit, so Ctrl+Z brings back a sent or restored draft.
        editor.executeEdits("prompt-editor", [
          { range: model.getFullModelRange(), text },
        ]);
        const at = caret ?? text.length;
        select(at, at);
        editor.revealPosition(model.getPositionAt(at));
      },
      insertText: (text) => editor.trigger("keyboard", "type", { text }),
    };
    surfaceRef.current = surface;
    const findSubscription = findState?.onFindReplaceStateChange(reportHeight);
    reportHeight();
    if (focus) editor.focus();
    return () => {
      if (surfaceRef.current === surface) surfaceRef.current = null;
      container.removeEventListener("paste", onPaste, true);
      textarea?.removeEventListener("compositionstart", onCompositionStart);
      textarea?.removeEventListener("compositionend", onCompositionEnd);
      findSubscription?.dispose();
      for (const disposable of disposables) disposable.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
    // Created once; font and theme updates apply below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    applyMonacoTheme(theme);
  }, [theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontFamily: font.family,
      fontSize: font.size,
      lineHeight: font.lineHeight,
    });
  }, [font.family, font.size, font.lineHeight]);

  return <div ref={containerRef} className="prompt-editor-monaco" />;
}
