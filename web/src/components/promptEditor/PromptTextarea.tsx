import { useLayoutEffect, useRef } from "react";
import type { PromptEditorSurface, PromptEditorSurfaceProps } from "./surface";

/**
 * The prompt editor's instant surface: a plain textarea that is usable
 * before Monaco downloads, and instead of it on Data Saver or 2G links.
 */
export function PromptTextarea({
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
}: PromptEditorSurfaceProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const measure = () => {
    const textarea = ref.current;
    if (!textarea) return;
    // Collapse first so a shrinking draft reports its smaller height.
    textarea.style.height = "0px";
    const height = textarea.scrollHeight;
    textarea.style.height = "";
    onContentHeight(height);
  };
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.value = initialText;
    const selection = initialSelection ?? {
      start: initialText.length,
      end: initialText.length,
    };
    textarea.setSelectionRange(selection.start, selection.end);
    const surface: PromptEditorSurface = {
      focus: () => textarea.focus({ preventScroll: true }),
      hasFocus: () => document.activeElement === textarea,
      selection: () => ({
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      }),
      setText: (text, caret) => {
        if (textarea.value === text) return;
        textarea.value = text;
        const at = caret ?? text.length;
        textarea.setSelectionRange(at, at);
        measure();
      },
      insertText: (text) => {
        // execCommand keeps the edit on the textarea's undo stack.
        if (!document.execCommand("insertText", false, text))
          textarea.setRangeText(
            text,
            textarea.selectionStart,
            textarea.selectionEnd,
            "end",
          );
        report();
      },
    };
    surfaceRef.current = surface;
    measure();
    if (focus) surface.focus();
    return () => {
      if (surfaceRef.current === surface) surfaceRef.current = null;
    };
    // Mounted once per editor; later text arrives through the surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const report = () => {
    const textarea = ref.current;
    if (!textarea) return;
    onChange(textarea.value, textarea.selectionStart, textarea.selectionEnd);
  };
  // Re-measure when the font changes the wrapping.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(measure, [font.family, font.size, font.lineHeight]);
  return (
    <textarea
      ref={ref}
      className="prompt-editor-textarea"
      rows={1}
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="off"
      placeholder={placeholder}
      aria-label={label}
      onInput={() => {
        report();
        measure();
      }}
      onSelect={report}
      onKeyDown={(event) => {
        if (onKey(event.nativeEvent, event.currentTarget.value === ""))
          event.preventDefault();
      }}
      onCompositionStart={() => onCompositionChange(true)}
      onCompositionEnd={() => onCompositionChange(false)}
      onPaste={(event) => {
        if (onPasteFiles(event.clipboardData)) event.preventDefault();
      }}
    />
  );
}
