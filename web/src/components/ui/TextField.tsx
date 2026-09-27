import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../utils";
import {
  FieldFrame,
  fieldDescribedBy,
  useFieldIds,
  type FieldTextProps,
} from "./fieldParts";

export type TextFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size"
> &
  FieldTextProps & {
    /** Convenience: receives the new value on every change. */
    onValueChange?: (value: string) => void;
    /** Class for the <input>; `className` styles the field wrapper. */
    inputClassName?: string;
  };

/**
 * Single-line text input with optional label, description, and error. The
 * ref and every input attribute (value, onChange, onKeyDown, autoFocus...)
 * go to the native <input>.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  (
    {
      label,
      description,
      error,
      fullWidth,
      className,
      inputClassName,
      id,
      onChange,
      onValueChange,
      "aria-describedby": ariaDescribedBy,
      ...props
    },
    ref,
  ) => {
    const ids = useFieldIds(id);
    return (
      <FieldFrame
        kind="textfield"
        ids={ids}
        label={label}
        description={description}
        error={error}
        fullWidth={fullWidth}
        disabled={props.disabled}
        className={className}
      >
        <input
          ref={ref}
          id={ids.inputId}
          data-slot="input"
          data-invalid={error ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={fieldDescribedBy(
            ids,
            { description, error },
            ariaDescribedBy,
          )}
          className={cn(
            "input",
            fullWidth && "input--full-width",
            inputClassName,
          )}
          onChange={(event) => {
            onChange?.(event);
            onValueChange?.(event.currentTarget.value);
          }}
          {...props}
        />
      </FieldFrame>
    );
  },
);
TextField.displayName = "TextField";
