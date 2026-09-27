import { useId, type ReactNode } from "react";
import { cn } from "../../utils";
import "./fields.css";

export type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label; omit it and pass aria-label for a bare switch in a settings row. */
  children?: ReactNode;
  "aria-label"?: string;
  description?: ReactNode;
  disabled?: boolean;
  /** Put the label before the switch, spread across the row. */
  labelPosition?: "end" | "start";
  className?: string;
  id?: string;
};

/**
 * On/off setting that applies immediately. HeroUI Switch styling on a native
 * `<input type="checkbox" role="switch">`: Space toggles, label clicks work.
 */
export function Switch({
  checked,
  onChange,
  children,
  "aria-label": ariaLabel,
  description,
  disabled = false,
  labelPosition = "end",
  className,
  id,
}: SwitchProps) {
  const descriptionId = useId();
  return (
    <div
      data-slot="switch"
      data-selected={checked || undefined}
      data-disabled={disabled || undefined}
      data-label-position={labelPosition}
      className={cn("switch switch--sm ui-switch", className)}
    >
      <label className="switch__content" data-slot="switch-content">
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="ui-choice-input"
          checked={checked}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-describedby={description ? descriptionId : undefined}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span className="switch__control" data-slot="switch-control">
          <span className="switch__thumb" data-slot="switch-thumb" />
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
