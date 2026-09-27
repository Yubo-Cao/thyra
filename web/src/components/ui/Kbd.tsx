import type { HTMLAttributes } from "react";
import { cn } from "../../utils";
import "./misc.css";

/** A keyboard key or chord hint, e.g. <Kbd>Ctrl+K</Kbd>. */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <kbd data-slot="kbd" className={cn("kbd", className)} {...props} />;
}
