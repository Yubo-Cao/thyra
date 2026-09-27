import type { ReactNode } from "react";

/** One actionable row in a Menu or ContextMenu. */
export type MenuItem = {
  /** Stable key, unique within the menu. */
  id: string;
  /** Visible text; also used for typeahead. Pass it through t(). */
  label: string;
  icon?: ReactNode;
  /** Display-only shortcut hint, e.g. "Ctrl+Shift+K". */
  shortcut?: string;
  /** Secondary text beside the label, e.g. a path or count. */
  description?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Show a checkmark slot; true renders the check. */
  checked?: boolean;
  onAction?: () => void;
};

/** A titled group of items; sections are separated by a divider. */
export type MenuSection = {
  id?: string;
  /** Group heading, shown above the items when present. */
  title?: string;
  /** Tint every item in the section as destructive. */
  danger?: boolean;
  /**
   * How `checked` items are announced: `multiple` (default) as
   * menuitemcheckbox, `single` as menuitemradio for mutually exclusive
   * choices.
   */
  selectionMode?: MenuSelectionMode;
  items: readonly MenuItem[];
};

export type MenuSelectionMode = "single" | "multiple";

export type MenuEntry = MenuItem | MenuSection;

export type NormalizedMenuSection = {
  id: string;
  title?: string;
  /** Set when an item has `checked`: its items get checkbox/radio roles. */
  selectionMode?: MenuSelectionMode;
  items: MenuItem[];
};

export function isMenuSection(entry: MenuEntry): entry is MenuSection {
  return "items" in entry;
}

/**
 * Group loose items into untitled sections, inherit section danger, drop
 * empty sections, and keep only the first item for a repeated id.
 */
export function normalizeMenu(
  entries: readonly MenuEntry[],
): NormalizedMenuSection[] {
  const sections: NormalizedMenuSection[] = [];
  const seen = new Set<string>();
  let loose: NormalizedMenuSection | null = null;
  const take = (item: MenuItem, danger: boolean) => {
    if (seen.has(item.id)) return null;
    seen.add(item.id);
    return danger && !item.danger ? { ...item, danger: true } : item;
  };
  for (const entry of entries) {
    if (isMenuSection(entry)) {
      loose = null;
      const items = entry.items.flatMap((item) => {
        const kept = take(item, !!entry.danger);
        return kept ? [kept] : [];
      });
      if (!items.length) continue;
      sections.push({
        id: entry.id ?? `section-${sections.length}`,
        title: entry.title,
        selectionMode: hasChecks(items)
          ? (entry.selectionMode ?? "multiple")
          : undefined,
        items,
      });
      continue;
    }
    const kept = take(entry, false);
    if (!kept) continue;
    if (!loose) {
      loose = { id: `section-${sections.length}`, items: [] };
      sections.push(loose);
    }
    loose.items.push(kept);
    if (kept.checked !== undefined) loose.selectionMode = "multiple";
  }
  return sections;
}

function hasChecks(items: readonly MenuItem[]) {
  return items.some((item) => item.checked !== undefined);
}

/** Ids of the checked items in a section, for aria-checked. */
export function checkedMenuKeys(section: NormalizedMenuSection): string[] {
  return section.items.filter((item) => item.checked).map((item) => item.id);
}

export function findMenuItem(
  sections: readonly NormalizedMenuSection[],
  id: string,
): MenuItem | undefined {
  for (const section of sections) {
    const item = section.items.find((candidate) => candidate.id === id);
    if (item) return item;
  }
  return undefined;
}

export function disabledMenuKeys(
  sections: readonly NormalizedMenuSection[],
): string[] {
  return sections.flatMap((section) =>
    section.items.filter((item) => item.disabled).map((item) => item.id),
  );
}

/** Whether any item reserves a checkmark column. */
export function menuHasChecks(
  sections: readonly NormalizedMenuSection[],
): boolean {
  return sections.some((section) => hasChecks(section.items));
}
