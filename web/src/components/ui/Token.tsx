import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../utils";

export type TokenTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";

export type TokenProps = HTMLAttributes<HTMLElement> & {
  /** Soft tint; `info` is an alias of `accent`. */
  tone?: TokenTone;
  /** Render as monospaced identifier text, e.g. a pane ID or branch. */
  code?: boolean;
  icon?: ReactNode;
  /** `button` makes a pressable token (filters, location shortcuts). */
  as?: "span" | "button";
  /** Only for `as="button"`. */
  disabled?: boolean;
};

/**
 * The one chip used for identifiers, statuses, counts, and traits: HeroUI
 * Chip styling on a plain element (tone colors in styles/ui.css). Every token
 * shares `--ui-token-height`, so rows and bars align regardless of which
 * tokens they carry.
 */
export function Token({
  tone = "neutral",
  code = false,
  icon,
  as,
  className,
  children,
  ...props
}: TokenProps) {
  const Element = as === "button" ? "button" : code ? "code" : "span";
  return (
    <Element
      type={as === "button" ? "button" : undefined}
      data-slot="chip"
      data-tone={tone}
      className={cn("chip chip--sm ui-token", code && "is-code", className)}
      {...props}
    >
      {icon}
      {children}
    </Element>
  );
}
