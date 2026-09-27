import { ChevronDown } from "lucide-react";
import {
  Suspense,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../../utils";
import {
  LazySelectPopover,
  preloadOverlays,
  useOpenedOnce,
} from "./lazyOverlays";
import "./select.css";

export type SelectOption<T extends string = string> = {
  value: T;
  /** Visible text, already translated; also used for typeahead. */
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
};

export type SelectProps<T extends string = string> = {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** Required unless a visible `label` names the control. */
  "aria-label"?: string;
  /** Visible label rendered before the trigger. */
  label?: ReactNode;
  /** Trigger text when `value` matches no option. */
  placeholder?: string;
  /** Replace the trigger content with an icon (compact toolbar selects). */
  icon?: ReactNode;
  /** Popover alignment against the trigger. */
  align?: "start" | "center" | "end";
  /** `field` (filled, default) or `ghost` (toolbar chrome). */
  variant?: "field" | "ghost";
  fullWidth?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
};

/**
 * Single choice from a short list (HeroUI Select styling). The trigger is a
 * native button; the listbox popover loads with the overlay chunk. A superset
 * of ThemedSelect's props, so migrating is a rename.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
  label,
  placeholder,
  icon,
  align = "start",
  variant = "field",
  fullWidth = false,
  disabled = false,
  title,
  className,
}: SelectProps<T>) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const mounted = useOpenedOnce(open);
  const current = options.find((option) => option.value === value);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div
      data-slot="select"
      className={cn(
        "select ui-select",
        `ui-select--${variant}`,
        fullWidth && "select--full-width",
        className,
      )}
      data-disabled={disabled || undefined}
    >
      {label ? (
        <span id={labelId} className="label" data-slot="label">
          {label}
        </span>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        data-slot="select-trigger"
        className={cn(
          "select__trigger",
          fullWidth && "select__trigger--full-width",
          icon ? "ui-select-trigger--icon" : undefined,
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-labelledby={
          label && !ariaLabel ? `${labelId} ${labelId}-value` : undefined
        }
        title={title}
        disabled={disabled}
        onPointerEnter={preloadOverlays}
        onFocus={preloadOverlays}
        onKeyDown={onKeyDown}
        onClick={() => setOpen(!open)}
      >
        {icon ?? (
          <>
            <span
              id={`${labelId}-value`}
              className="select__value"
              data-slot="select-value"
              data-placeholder={current ? undefined : true}
            >
              {current?.label ?? placeholder ?? value}
            </span>
            <ChevronDown
              size={13}
              className="select__indicator"
              data-slot="select-default-indicator"
              data-open={open || undefined}
              aria-hidden="true"
            />
          </>
        )}
      </button>
      {mounted ? (
        <Suspense fallback={null}>
          <LazySelectPopover
            triggerRef={triggerRef}
            open={open}
            onOpenChange={setOpen}
            options={options}
            value={value}
            onChange={(next) => onChange(next as T)}
            aria-label={ariaLabel}
            labelledBy={label ? labelId : undefined}
            align={align}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
