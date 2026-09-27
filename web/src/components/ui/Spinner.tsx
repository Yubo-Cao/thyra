import { LoaderCircle } from "lucide-react";
import { cn } from "../../utils";
import "./misc.css";

const PIXELS = { sm: 12, md: 16, lg: 24 } as const;

/** Indeterminate progress glyph; pass `label` when nothing else announces the wait. */
export function Spinner({
  size = "md",
  tone = "current",
  label,
  className,
}: {
  size?: keyof typeof PIXELS;
  tone?: "current" | "accent" | "danger";
  /** Accessible status text (translated); omit for decorative spinners. */
  label?: string;
  className?: string;
}) {
  return (
    <span
      data-slot="spinner"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("spinner ui-spinner", `spinner--${tone}`, className)}
      style={{ width: PIXELS[size], height: PIXELS[size] }}
    >
      <LoaderCircle size={PIXELS[size]} strokeWidth={2.2} />
    </span>
  );
}
