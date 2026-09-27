import { Check, Minus } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "../../utils";
import "./fields.css";

export type CheckboxProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label; omit it and pass aria-label for a bare checkbox (e.g. a table row). */
  children?: ReactNode;
  "aria-label"?: string;
  description?: ReactNode;
  /** Mixed state for "some selected"; clicking reports `true`. */
  indeterminate?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  id?: string;
};

/**
 * Choice that is part of a form or a selection. HeroUI Checkbox styling on a
 * native `<input type="checkbox">`.
 */
export function Checkbox({
  checked,
  onChange,
  children,
  "aria-label": ariaLabel,
  description,
  indeterminate = false,
  disabled = false,
  invalid = false,
  className,
  id,
}: CheckboxProps) {
  const descriptionId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);
  const selected = checked && !indeterminate;
  return (
    <div
      data-slot="checkbox"
      data-selected={selected || undefined}
      data-indeterminate={indeterminate || undefined}
      data-disabled={disabled || undefined}
      data-invalid={invalid || undefined}
      className={cn("checkbox ui-checkbox", className)}
    >
      <label className="checkbox__content" data-slot="checkbox-content">
        <input
          ref={inputRef}
          id={id}
          type="checkbox"
          className="ui-choice-input"
          checked={checked}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={description ? descriptionId : undefined}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span className="checkbox__control" data-slot="checkbox-control">
          <span className="checkbox__indicator" data-slot="checkbox-indicator">
            {indeterminate ? (
              <Minus size={10} strokeWidth={3} aria-hidden="true" />
            ) : selected ? (
              <Check size={10} strokeWidth={3.5} aria-hidden="true" />
            ) : null}
          </span>
        </span>
        {children != null ? (
          <span className="label" data-slot="label">
            {children}
          </span>
        ) : null}
      </label>
      {description ? (
        <span
          id={descriptionId}
          className="description"
          data-slot="description"
        >
          {description}
        </span>
      ) : null}
    </div>
  );
}
