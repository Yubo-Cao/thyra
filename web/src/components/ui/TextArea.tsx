import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../../utils";
import {
  FieldFrame,
  fieldDescribedBy,
  useFieldIds,
  type FieldTextProps,
} from "./fieldParts";

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> &
  FieldTextProps & {
    /** Convenience: receives the new value on every change. */
    onValueChange?: (value: string) => void;
    /** Class for the <textarea>; `className` styles the field wrapper. */
    textareaClassName?: string;
  };

/** Multi-line text input; same field anatomy and prop rules as TextField. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  (
    {
      label,
      description,
      error,
      fullWidth,
      className,
      textareaClassName,
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
        <textarea
          ref={ref}
          id={ids.inputId}
          data-slot="textarea"
          data-invalid={error ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={fieldDescribedBy(
            ids,
            { description, error },
            ariaDescribedBy,
          )}
          className={cn(
            "textarea",
            fullWidth && "textarea--full-width",
            textareaClassName,
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
TextArea.displayName = "TextArea";
