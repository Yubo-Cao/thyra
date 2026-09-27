import { forwardRef, type ReactNode } from "react";
import { Button, type ButtonProps } from "./Button";

export type IconButtonProps = Omit<
  ButtonProps,
  "aria-label" | "children" | "icon"
> & {
  /** Required: the accessible name and the default tooltip text. */
  label: string;
  icon: ReactNode;
  /** `danger` tints the hover state of a ghost button. */
  tone?: "neutral" | "danger";
  /** Tooltip text (defaults to `title`, then `label`); `false` hides it. */
  tooltip?: string | false;
};

/**
 * Square icon-only Button with a required label. The label doubles as the
 * tooltip, shown by the app-wide delegated tooltip layer (GlobalTooltip reads
 * `data-tooltip`), so hundreds of icon buttons add no per-button listeners.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, icon, tone = "neutral", title, tooltip, ...props }, ref) => (
    <Button
      ref={ref}
      icon
      aria-label={label}
      data-tooltip={tooltip === false ? undefined : (tooltip ?? title ?? label)}
      data-tone={tone === "danger" ? "danger" : undefined}
      {...props}
    >
      {icon}
    </Button>
  ),
);
IconButton.displayName = "IconButton";
