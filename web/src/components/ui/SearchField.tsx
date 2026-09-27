import { Search, X } from "lucide-react";
import { forwardRef, useRef, type InputHTMLAttributes } from "react";
import { t } from "../../i18n";
import { cn } from "../../utils";
import {
  FieldFrame,
  fieldDescribedBy,
  useFieldIds,
  type FieldTextProps,
} from "./fieldParts";
import { mergeRefs } from "./mergeRefs";

export type SearchFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size" | "value" | "onChange" | "type"
> &
  FieldTextProps & {
    value: string;
    onValueChange: (value: string) => void;
    /** Accessible name of the clear button; defaults to t("Clear search"). */
    clearLabel?: string;
  };

/**
 * Filter/search input with a leading icon and a clear button. Escape clears
 * a non-empty field and stops there; on an empty field it propagates (so a
 * surrounding dialog can close).
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  (
    {
      label,
      description,
      error,
      fullWidth,
      className,
      id,
      value,
      onValueChange,
      onKeyDown,
      clearLabel,
      "aria-describedby": ariaDescribedBy,
      ...props
    },
    ref,
  ) => {
    const ids = useFieldIds(id);
    const inputRef = useRef<HTMLInputElement>(null);
    const empty = value === "";
    return (
      <FieldFrame
        kind="search-field"
        ids={ids}
        label={label}
        description={description}
        error={error}
        fullWidth={fullWidth}
        disabled={props.disabled}
        className={className}
      >
        <div
          className={cn(
            "search-field__group",
            fullWidth && "search-field__group--full-width",
          )}
          data-slot="search-field-group"
          data-empty={empty || undefined}
        >
          <Search
            size={14}
            className="search-field__search-icon"
            data-slot="search-field-search-icon"
            aria-hidden="true"
          />
          <input
            ref={mergeRefs(inputRef, ref)}
            id={ids.inputId}
            type="search"
            data-slot="search-field-input"
            className="search-field__input"
            aria-invalid={error ? true : undefined}
            aria-describedby={fieldDescribedBy(
              ids,
              { description, error },
              ariaDescribedBy,
            )}
            value={value}
            onChange={(event) => onValueChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              onKeyDown?.(event);
              if (event.key === "Escape" && !empty && !event.defaultPrevented) {
                event.preventDefault();
                event.stopPropagation();
                onValueChange("");
              }
            }}
            {...props}
          />
          {empty ? null : (
            <button
              type="button"
              slot="clear"
              data-slot="search-field-clear-button"
              className="close-button search-field__clear-button"
              aria-label={clearLabel ?? t("Clear search")}
              tabIndex={-1}
              onClick={() => {
                onValueChange("");
                inputRef.current?.focus();
              }}
            >
              <X size={12} strokeWidth={2.4} aria-hidden="true" />
            </button>
          )}
        </div>
      </FieldFrame>
    );
  },
);
SearchField.displayName = "SearchField";
