import { useId, type ReactNode } from "react";
import { cn } from "../../utils";
import "./fields.css";

/** Label, description, and error props shared by TextField, TextArea, and SearchField. */
export type FieldTextProps = {
  /** Visible label above the control; without it pass aria-label. */
  label?: ReactNode;
  /** Help text below the control; hidden while an error shows. */
  description?: ReactNode;
  /** Error message; `true` marks the field invalid without a message. */
  error?: ReactNode | boolean;
  /** Stretch the field and its control to the container width. */
  fullWidth?: boolean;
};

export type FieldIds = {
  inputId: string;
  descriptionId: string;
  errorId: string;
};

export function useFieldIds(id?: string): FieldIds {
  const generated = useId();
  const inputId = id ?? generated;
  return {
    inputId,
    descriptionId: `${inputId}-description`,
    errorId: `${inputId}-error`,
  };
}

/** aria-describedby for the control: caller ids plus description or error. */
export function fieldDescribedBy(
  ids: FieldIds,
  { description, error }: FieldTextProps,
  own?: string,
): string | undefined {
  const message = error && error !== true;
  return (
    cn(
      own,
      message ? ids.errorId : undefined,
      description && !message ? ids.descriptionId : undefined,
    ) || undefined
  );
}

export function FieldFrame({
  kind,
  ids,
  label,
  description,
  error,
  fullWidth,
  disabled,
  className,
  children,
}: FieldTextProps & {
  kind: "textfield" | "search-field";
  ids: FieldIds;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const message = error && error !== true ? error : null;
  return (
    <div
      data-slot={kind}
      data-invalid={error ? true : undefined}
      data-disabled={disabled || undefined}
      className={cn(
        kind,
        fullWidth && `${kind}--full-width`,
        "ui-field",
        className,
      )}
    >
      {label ? (
        <label className="label" data-slot="label" htmlFor={ids.inputId}>
          {label}
        </label>
      ) : null}
      {children}
      {description && !message ? (
        <span
          id={ids.descriptionId}
          className="description"
          data-slot="description"
        >
          {description}
        </span>
      ) : null}
      {message ? (
        <span
          id={ids.errorId}
          className="field-error"
          data-slot="field-error"
          data-visible="true"
        >
          {message}
        </span>
      ) : null}
    </div>
  );
}
