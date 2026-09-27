import { Check } from "lucide-react";
import type { RefObject } from "react";
import { ListBox, ListBoxItem, Text } from "react-aria-components/ListBox";
import { Popover } from "react-aria-components/Popover";
import type { SelectOption } from "../Select";

export type SelectPopoverProps = {
  triggerRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: readonly SelectOption[];
  value: string;
  onChange: (value: string) => void;
  "aria-label"?: string;
  /** Id of the visible label when there is no aria-label. */
  labelledBy?: string;
  align: "start" | "center" | "end";
};

const PLACEMENT = {
  start: "bottom start",
  center: "bottom",
  end: "bottom end",
} as const;

// React Aria ListBox in a Popover, with HeroUI Select/ListBox classes.
export function SelectPopover({
  triggerRef,
  open,
  onOpenChange,
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  labelledBy,
  align,
}: SelectPopoverProps) {
  return (
    <Popover
      triggerRef={triggerRef}
      isOpen={open}
      onOpenChange={onOpenChange}
      placement={PLACEMENT[align]}
      offset={4}
      trigger="Select"
      data-slot="select-popover"
      className="select__popover ui-select-popover"
    >
      <ListBox
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : labelledBy}
        selectionMode="single"
        selectedKeys={[value]}
        disabledKeys={options
          .filter((option) => option.disabled)
          .map((option) => option.value)}
        autoFocus
        shouldFocusWrap
        onSelectionChange={(keys) => {
          // Re-pressing the selected option deselects it (empty set): just close.
          const [key] = keys === "all" ? [] : [...keys];
          if (key !== undefined && String(key) !== value) onChange(String(key));
          onOpenChange(false);
        }}
        data-slot="list-box"
        className="list-box ui-select-list"
      >
        {options.map((option) => (
          <ListBoxItem
            key={option.value}
            id={option.value}
            textValue={option.label}
            data-slot="list-box-item"
            className="list-box-item list-box-item--default ui-select-item"
          >
            {({ isSelected }) => (
              <>
                {option.icon ? (
                  <span className="ui-menu-icon" aria-hidden="true">
                    {option.icon}
                  </span>
                ) : null}
                <Text slot="label" className="ui-menu-label" data-slot="label">
                  {option.label}
                </Text>
                {option.description ? (
                  <Text
                    slot="description"
                    className="ui-menu-description"
                    data-slot="description"
                  >
                    {option.description}
                  </Text>
                ) : null}
                <span className="ui-select-check" aria-hidden="true">
                  {isSelected ? <Check size={13} strokeWidth={2.4} /> : null}
                </span>
              </>
            )}
          </ListBoxItem>
        ))}
      </ListBox>
    </Popover>
  );
}
