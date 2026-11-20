import { useEffect, useRef, useState } from "react";
import { PASSWORD_MANAGER_IGNORE } from "../../passwordManagerIgnore";
import { cn } from "../../utils";
import "./inlineTextInput.css";

/**
 * A label edited in place: it opens focused with the text selected, Enter or
 * leaving the field commits, Escape cancels. Clicks and keys stay inside it,
 * so the tab or pane header around it does not also react.
 */
export function InlineTextInput({
  initialValue,
  placeholder,
  ariaLabel,
  className,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  const settle = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className={cn("ui-inline-text-input", className)}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      size={Math.max(4, (value || placeholder || "").length + 1)}
      spellCheck={false}
      autoComplete="off"
      {...PASSWORD_MANAGER_IGNORE}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => settle(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          settle(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          settle(false);
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    />
  );
}
