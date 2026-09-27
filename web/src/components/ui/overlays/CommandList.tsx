import { useEffect, useRef } from "react";
import { Autocomplete } from "react-aria-components/Autocomplete";
import {
  Header,
  ListBox,
  ListBoxItem,
  ListBoxSection,
} from "react-aria-components/ListBox";
import { Input, TextField } from "react-aria-components/TextField";
import { cn } from "../../../utils";
import type { CommandListProps } from "../command";

// A searchable command list (React Aria Autocomplete + ListBox). The input
// keeps focus and arrow keys move a virtual focus that starts on the first
// option; with `focusCurrent` the options take real focus instead, starting
// on the current one (no on-screen keyboard on phones).
export function CommandList({
  sections,
  search,
  onSearchChange,
  onAction,
  placeholder,
  inputLabel = placeholder,
  emptyText,
  filter,
  focusCurrent = false,
  className,
}: CommandListProps) {
  const currentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusCurrent) return;
    const focus = () => currentRef.current?.focus();
    focus();
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [focusCurrent]);
  return (
    <div className={cn("command", className)}>
      <Autocomplete
        inputValue={search}
        onInputChange={onSearchChange}
        filter={filter}
        disableVirtualFocus={focusCurrent}
      >
        <TextField aria-label={inputLabel} autoFocus={!focusCurrent}>
          <Input className="command-input" placeholder={placeholder} />
        </TextField>
        <ListBox
          // Each search starts over on its first match.
          key={focusCurrent ? undefined : search}
          aria-label={inputLabel}
          className="command-list"
          autoFocus={focusCurrent ? undefined : "first"}
          shouldFocusWrap
          shouldFocusOnHover
          onAction={(key) => onAction(String(key))}
          renderEmptyState={() => (
            <div className="command-empty">{emptyText}</div>
          )}
        >
          {sections.map((section) => (
            <ListBoxSection
              key={section.heading}
              id={section.heading}
              className="command-group"
            >
              <Header className="command-group-heading">
                {section.heading}
              </Header>
              {section.items.map((item) => (
                <ListBoxItem
                  key={item.id}
                  id={item.id}
                  ref={item.current ? currentRef : undefined}
                  textValue={item.textValue}
                  isDisabled={item.disabled}
                  aria-label={item["aria-label"]}
                  data-current={item.current ? "true" : undefined}
                  data-tooltip={item.tooltip}
                  className={cn(
                    "command-item",
                    item.danger && "is-danger",
                    item.className,
                  )}
                >
                  {item.children}
                </ListBoxItem>
              ))}
            </ListBoxSection>
          ))}
        </ListBox>
      </Autocomplete>
    </div>
  );
}
