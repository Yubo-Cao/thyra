import { type ReactNode, Suspense } from "react";
import { LazyCommandList } from "./lazyOverlays";
import "./command.css";

export type CommandListItem = {
  id: string;
  /** Plain text of the option, for filtering and type-to-select. */
  textValue: string;
  children: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  /** The current choice (`data-current`); `focusCurrent` lists start on it. */
  current?: boolean;
  /** Shown by the global tooltip, e.g. why the option is disabled. */
  tooltip?: string;
  "aria-label"?: string;
  className?: string;
};

export type CommandListSection = { heading: string; items: CommandListItem[] };

export type CommandListProps = {
  sections: CommandListSection[];
  search: string;
  onSearchChange: (search: string) => void;
  onAction: (id: string) => void;
  placeholder: string;
  /** Accessible name of the input and list; defaults to `placeholder`. */
  inputLabel?: string;
  emptyText: string;
  /** Hides options whose `textValue` does not match; omit for pre-filtered sections. */
  filter?: (textValue: string, search: string) => boolean;
  /** Focus the current option instead of the input. */
  focusCurrent?: boolean;
  className?: string;
};

/** Case-insensitive match of the search's characters, in order. */
export function subsequenceFilter(textValue: string, search: string) {
  const text = textValue.toLowerCase();
  let index = 0;
  for (const char of search.trim().toLowerCase()) {
    index = text.indexOf(char, index) + 1;
    if (!index) return false;
  }
  return true;
}

/**
 * A search field over a sectioned option list with keyboard navigation
 * (arrows, Home/End, Enter). Renders nothing until the overlay chunk loads,
 * so use it inside overlays (Popover, Dialog), which load that chunk.
 */
export function CommandList(props: CommandListProps) {
  return (
    <Suspense fallback={null}>
      <LazyCommandList {...props} />
    </Suspense>
  );
}
