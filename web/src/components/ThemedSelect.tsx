import type { ReactNode } from "react";
import { Select } from "./ui/Select";

export type ThemedSelectOption = {
  value: string;
  label: string;
};

export type ThemedSelectProps = {
  value: string;
  options: ThemedSelectOption[];
  onChange: (value: string) => void;
  icon?: ReactNode;
  /** Styles the select wrapper (ui/Select). */
  className?: string;
  align?: "start" | "center" | "end";
  "aria-label"?: string;
  title?: string;
  /** Open on mount: LazyThemedSelect mounts this on the first open request. */
  defaultOpen?: boolean;
};

/**
 * Older name for ui/Select, kept for existing callers: the trigger is eager
 * and the listbox loads with the overlay chunk on first open. Icon-only
 * selects use the ghost toolbar look.
 */
export function ThemedSelect(props: ThemedSelectProps) {
  return <Select {...props} variant={props.icon ? "ghost" : "field"} />;
}
