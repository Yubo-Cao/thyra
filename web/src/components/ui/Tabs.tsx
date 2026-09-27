import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../utils";
import { nextTabIndex, type TabsOrientation } from "./tabsKeyboard";
import "./tabs.css";

export type TabItem<T extends string> = {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** Accessible name when the label is an icon or abbreviation. */
  ariaLabel?: string;
};

export type TabsProps<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  items: readonly TabItem<T>[];
  "aria-label": string;
  orientation?: TabsOrientation;
  /** Panel for the selected tab; omit it to render panels yourself. */
  children?: ReactNode;
  className?: string;
  /** Class for the tabpanel wrapper. */
  panelClassName?: string;
};

/**
 * Tab list with an accent underline (HeroUI secondary tabs). Arrow keys,
 * Home, and End move and select (automatic activation); only the selected
 * tab is in the Tab order. Native buttons, no React Aria runtime.
 */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  "aria-label": ariaLabel,
  orientation = "horizontal",
  children,
  className,
  panelClassName,
}: TabsProps<T>) {
  const prefix = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const selectedIndex = items.findIndex((item) => item.id === value);
  const tabId = (id: string) => `${prefix}-tab-${id}`;
  const panelId = `${prefix}-panel`;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = items.findIndex(
      (item) => tabId(item.id) === (event.target as HTMLElement).id,
    );
    if (current < 0) return;
    const next = nextTabIndex(
      event.key,
      current,
      items.map((item) => !!item.disabled),
      orientation,
    );
    if (next === null) return;
    event.preventDefault();
    listRef.current
      ?.querySelector<HTMLButtonElement>(
        `#${CSS.escape(tabId(items[next].id))}`,
      )
      ?.focus();
    onChange(items[next].id);
  };

  return (
    <div
      data-slot="tabs"
      data-orientation={orientation}
      className={cn("tabs tabs--secondary ui-tabs", className)}
    >
      <div className="tabs__list-container" data-slot="tabs-list-container">
        <div
          ref={listRef}
          role="tablist"
          aria-label={ariaLabel}
          aria-orientation={orientation}
          data-orientation={orientation}
          data-slot="tabs-list"
          className="tabs__list"
          onKeyDown={onKeyDown}
        >
          {items.map((item, index) => {
            const selected = item.id === value;
            const focusable =
              selected || (selectedIndex < 0 && index === 0 && !item.disabled);
            return (
              <button
                key={item.id}
                id={tabId(item.id)}
                type="button"
                role="tab"
                data-slot="tabs-tab"
                className="tabs__tab"
                aria-selected={selected}
                aria-controls={
                  selected && children !== undefined ? panelId : undefined
                }
                aria-label={item.ariaLabel}
                data-selected={selected || undefined}
                disabled={item.disabled}
                tabIndex={focusable ? 0 : -1}
                onClick={() => onChange(item.id)}
              >
                {item.icon}
                {item.label}
                {selected ? (
                  <span
                    className="tabs__indicator"
                    data-slot="tabs-indicator"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      {children !== undefined ? (
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={selectedIndex >= 0 ? tabId(value) : undefined}
          data-orientation={orientation}
          data-slot="tabs-panel"
          className={cn("tabs__panel ui-tabs-panel", panelClassName)}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
