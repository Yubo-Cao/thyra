import { Check } from "lucide-react";
import { Fragment, useMemo, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Popover } from "react-aria-components/Popover";
import {
  Header,
  Keyboard,
  Menu,
  MenuItem as AriaMenuItem,
  MenuSection,
  Separator,
  Text,
} from "react-aria-components/Menu";
import type { MenuFocusTarget, MenuHeader, MenuPlacement } from "../Menu";
import {
  checkedMenuKeys,
  disabledMenuKeys,
  findMenuItem,
  menuHasChecks,
  normalizeMenu,
  type MenuEntry,
  type MenuItem,
} from "../menuModel";

export type MenuAnchor =
  | { triggerRef: RefObject<HTMLElement | null> }
  | { point: { x: number; y: number } };

export type MenuPopoverProps = {
  anchor: MenuAnchor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly MenuEntry[];
  "aria-label": string;
  header?: MenuHeader;
  placement: MenuPlacement;
  focusTarget: MenuFocusTarget;
  onAction?: (id: string) => void;
};

const noop = () => {};

// React Aria Menu in a Popover, with HeroUI Dropdown/Menu classes.
export function MenuPopover({
  anchor,
  open,
  onOpenChange,
  items,
  "aria-label": ariaLabel,
  header,
  placement,
  focusTarget,
  onAction,
}: MenuPopoverProps) {
  const pointRef = useRef<HTMLSpanElement>(null);
  const sections = useMemo(() => normalizeMenu(items), [items]);
  const checks = menuHasChecks(sections);
  const point = "point" in anchor ? anchor.point : null;
  const triggerRef = point
    ? pointRef
    : (anchor as { triggerRef: RefObject<HTMLElement | null> }).triggerRef;

  const renderItem = (item: MenuItem) => (
    <AriaMenuItem
      key={item.id}
      id={item.id}
      textValue={item.label}
      data-slot="menu-item"
      className={
        item.danger
          ? "menu-item menu-item--danger ui-menu-item"
          : "menu-item menu-item--default ui-menu-item"
      }
    >
      {checks ? (
        <span className="ui-menu-check" aria-hidden="true">
          {item.checked ? <Check size={13} strokeWidth={2.4} /> : null}
        </span>
      ) : null}
      {item.icon ? (
        <span className="ui-menu-icon" aria-hidden="true">
          {item.icon}
        </span>
      ) : null}
      <Text slot="label" className="ui-menu-label" data-slot="label">
        {item.label}
      </Text>
      {item.description ? (
        <Text
          slot="description"
          className="ui-menu-description"
          data-slot="description"
        >
          {item.description}
        </Text>
      ) : null}
      {item.shortcut ? (
        <Keyboard className="ui-menu-shortcut">{item.shortcut}</Keyboard>
      ) : null}
    </AriaMenuItem>
  );

  return (
    <>
      {point
        ? createPortal(
            <span
              ref={pointRef}
              aria-hidden="true"
              className="ui-menu-point"
              style={{ left: point.x, top: point.y }}
            />,
            document.body,
          )
        : null}
      <Popover
        triggerRef={triggerRef}
        isOpen={open}
        onOpenChange={onOpenChange}
        placement={placement}
        offset={point ? 2 : 4}
        trigger="MenuTrigger"
        data-slot="dropdown-popover"
        className="dropdown__popover ui-menu-popover"
      >
        {header ? (
          <div className="ui-menu-header">
            <strong title={header.title}>{header.title}</strong>
            {header.subtitle ? <small>{header.subtitle}</small> : null}
          </div>
        ) : null}
        <Menu
          aria-label={ariaLabel}
          autoFocus={focusTarget === "menu" ? true : focusTarget}
          disabledKeys={disabledMenuKeys(sections)}
          onClose={() => onOpenChange(false)}
          onAction={(key) => {
            const id = String(key);
            findMenuItem(sections, id)?.onAction?.();
            onAction?.(id);
          }}
          data-slot="dropdown-menu"
          className="menu dropdown__menu ui-menu"
        >
          {sections.map((section, index) => (
            <Fragment key={section.id}>
              {index > 0 ? (
                <Separator
                  className="ui-menu-separator"
                  data-slot="separator"
                />
              ) : null}
              {section.title || section.selectionMode ? (
                // A section with checked items owns a selection so React
                // Aria announces them as menuitemcheckbox/radio with
                // aria-checked; the caller's `checked` stays the source of
                // truth, and the menu still closes after the action.
                <MenuSection
                  id={section.id}
                  data-slot="menu-section"
                  className="menu-section ui-menu-section"
                  selectionMode={section.selectionMode}
                  selectedKeys={
                    section.selectionMode ? checkedMenuKeys(section) : undefined
                  }
                  onSelectionChange={section.selectionMode ? noop : undefined}
                  shouldCloseOnSelect={section.selectionMode ? true : undefined}
                >
                  {section.title ? (
                    <Header className="ui-menu-section-title">
                      {section.title}
                    </Header>
                  ) : null}
                  {section.items.map(renderItem)}
                </MenuSection>
              ) : (
                section.items.map(renderItem)
              )}
            </Fragment>
          ))}
        </Menu>
      </Popover>
    </>
  );
}
