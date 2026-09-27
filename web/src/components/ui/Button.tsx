import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../utils";

export type ButtonVariant =
  | "ghost"
  | "secondary"
  | "primary"
  | "danger"
  | "danger-soft";

export type ButtonSize = "sm" | "md";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `ghost` (default, toolbar chrome), `secondary` (filled neutral), `primary`, `danger`, `danger-soft`. */
  variant?: ButtonVariant;
  /** `sm` uses --ui-control-height (default); `md` is the taller dialog-action size. */
  size?: ButtonSize;
  /** Square icon-only geometry; prefer IconButton, which also adds the label and tooltip. */
  icon?: boolean;
  /** Stretch to the container width. */
  fullWidth?: boolean;
};

/**
 * A native <button> carrying HeroUI's button classes: DOM events, no React
 * Aria runtime, so it is free to use in the always-loaded shell.
 * `aria-pressed` renders the toggled (accent) state.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "ghost",
      size = "sm",
      icon = false,
      fullWidth = false,
      className,
      type = "button",
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      data-slot="button"
      className={cn(
        "button",
        `button--${size}`,
        `button--${variant}`,
        icon && "button--icon-only",
        fullWidth && "button--full-width",
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
