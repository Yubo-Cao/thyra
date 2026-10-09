import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search";
import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
} from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  keymap,
  placeholder as placeholderText,
  rectangularSelection,
} from "@codemirror/view";
import { useLayoutEffect, useRef } from "react";
import { t } from "../../i18n";
import { livePreview, webImageUrl } from "./livePreview";
import type {
  PromptEditorFont,
  PromptEditorSurface,
  PromptEditorSurfaceProps,
} from "./surface";

function fontTheme(font: PromptEditorFont) {
  return EditorView.theme({
    "&": { fontSize: `${font.size}px` },
    ".cm-content, .cm-scroller": {
      fontFamily: font.family,
      lineHeight: `${font.lineHeight}px`,
    },
  });
}

// The editor sits on the terminal's tone and grid: no gutter, square, no
// outlines, the terminal's caret and selection colours.
const surfaceTheme = EditorView.theme({
  "&": { height: "100%", color: "inherit", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflowX: "hidden", scrollbarWidth: "thin" },
  ".cm-content": {
    padding: "0",
    caretColor: "var(--prompt-editor-caret)",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--prompt-editor-caret)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--prompt-editor-selection)" },
  ".cm-placeholder": { color: "var(--prompt-editor-dim)" },
  ".cm-selectionMatch": {
    backgroundColor:
      "color-mix(in srgb, var(--prompt-editor-selection) 50%, transparent)",
  },
  // Find and replace: a band of the editor's tone with filled fields.
  ".cm-panels": {
    backgroundColor: "var(--prompt-editor-panel)",
    color: "inherit",
    fontFamily: "var(--font-sans, inherit)",
  },
  ".cm-panels.cm-panels-top, .cm-panels.cm-panels-bottom": { border: "none" },
  ".cm-search": { fontSize: "12px" },
  ".cm-textfield, .cm-button": {
    border: "none",
    borderRadius: "0",
    backgroundImage: "none",
    backgroundColor:
      "color-mix(in srgb, var(--prompt-editor-fg) 10%, transparent)",
    color: "inherit",
  },
  ".cm-search label": { fontSize: "inherit" },
  ".cm-searchMatch": {
    backgroundColor:
      "color-mix(in srgb, var(--prompt-editor-yellow) 30%, transparent)",
  },
});

/**
 * The prompt editor's rich surface: CodeMirror with a Typora-style live
 * Markdown preview, multiple cursors (Ctrl/Cmd+D, Alt+click, Shift+Alt+drag,
 * Ctrl+Shift+L) and find. It takes over from the plain textarea once
 * loaded, keeping the text and selection. Its contenteditable handles IME
 * composition and on-screen keyboards natively.
 */
export function PromptCodeMirror({
  surfaceRef,
  initialText,
  initialSelection,
  focus,
  placeholder,
  label,
  font,
  onChange,
  onKey,
  onPasteFiles,
  onContentHeight,
  onCompositionChange,
  images,
}: PromptEditorSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fontCompartment = useRef(new Compartment());
  const latest = useRef({
    onChange,
    onKey,
    onPasteFiles,
    onContentHeight,
    onCompositionChange,
    images,
  });
  latest.current = {
    onChange,
    onKey,
    onPasteFiles,
    onContentHeight,
    onCompositionChange,
    images,
  };

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const length = initialText.length;
    const selection = initialSelection ?? { start: length, end: length };
    let reported = -1;
    const reportHeight = (view: EditorView) => {
      const panels = view.dom.querySelectorAll<HTMLElement>(".cm-panels");
      let height = view.contentHeight;
      for (const panel of panels) height += panel.offsetHeight;
      if (height === reported) return;
      reported = height;
      latest.current.onContentHeight(height);
    };
    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: initialText,
        selection: EditorSelection.single(
          Math.min(selection.end, length),
          Math.min(selection.start, length),
        ),
        extensions: [
          // The editor's own keys first: send, newline and pass-through.
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (event, view) => {
                if (!latest.current.onKey(event, view.state.doc.length === 0))
                  return false;
                event.preventDefault();
                return true;
              },
              paste: (event) => {
                if (!latest.current.onPasteFiles(event.clipboardData))
                  return false;
                event.preventDefault();
                return true;
              },
              compositionstart: () => {
                latest.current.onCompositionChange(true);
                return false;
              },
              compositionend: () => {
                latest.current.onCompositionChange(false);
                return false;
              },
            }),
          ),
          history(),
          drawSelection(),
          EditorState.allowMultipleSelections.of(true),
          // Monaco's gestures: Alt+click adds a cursor, Shift+Alt+drag
          // selects a column.
          EditorView.clickAddsSelectionRange.of((event) => event.altKey),
          rectangularSelection({
            eventFilter: (event) => event.altKey && event.shiftKey,
          }),
          search({ top: false }),
          highlightSelectionMatches(),
          keymap.of([
            ...searchKeymap,
            ...historyKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          EditorView.lineWrapping,
          EditorState.tabSize.of(2),
          EditorState.phrases.of({
            Find: t("Find"),
            Replace: t("Replace"),
            next: t("Next match"),
            previous: t("Previous match"),
            all: t("All matches"),
            "match case": t("Match case"),
            regexp: t("Regular expression"),
            "by word": t("Whole word"),
            replace: t("Replace match"),
            "replace all": t("Replace all"),
            close: t("Close"),
          }),
          placeholderText(placeholder),
          EditorView.contentAttributes.of({
            "aria-label": label,
            "aria-multiline": "true",
            autocapitalize: "off",
            autocorrect: "off",
            spellcheck: "false",
          }),
          livePreview({
            url: (source) =>
              latest.current.images?.url(source) ?? webImageUrl(source),
            pasted: (ref) => latest.current.images?.pasted(ref) ?? null,
          }),
          surfaceTheme,
          fontCompartment.current.of(fontTheme(font)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet) {
              const main = update.state.selection.main;
              latest.current.onChange(
                update.state.doc.toString(),
                main.from,
                main.to,
              );
            }
            if (update.geometryChanged || update.heightChanged)
              reportHeight(update.view);
          }),
        ],
      }),
    });
    viewRef.current = view;
    const surface: PromptEditorSurface = {
      focus: () => view.focus(),
      hasFocus: () => view.hasFocus,
      selection: () => {
        const main = view.state.selection.main;
        return { start: main.from, end: main.to };
      },
      setText: (text, caret) => {
        if (view.state.doc.toString() === text) return;
        // One undoable edit, so Ctrl+Z brings back a sent or restored draft.
        const at = Math.min(caret ?? text.length, text.length);
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: at },
          scrollIntoView: true,
        });
      },
      insertText: (text) => {
        view.dispatch(view.state.replaceSelection(text), {
          scrollIntoView: true,
          userEvent: "input",
        });
      },
    };
    surfaceRef.current = surface;
    reportHeight(view);
    // Line wrapping depends on glyph widths: re-measure once the terminal's
    // web font arrives.
    const remeasure = () => view.requestMeasure();
    document.fonts?.addEventListener("loadingdone", remeasure);
    if (focus) view.focus();
    return () => {
      document.fonts?.removeEventListener("loadingdone", remeasure);
      if (surfaceRef.current === surface) surfaceRef.current = null;
      view.destroy();
      viewRef.current = null;
    };
    // Created once; font updates apply below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { family, size, lineHeight } = font;
  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: fontCompartment.current.reconfigure(
        fontTheme({ family, size, lineHeight }),
      ),
    });
  }, [family, size, lineHeight]);

  return <div ref={containerRef} className="prompt-editor-rich" />;
}
