import { ChevronDown } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  forwardRef,
  type ReactNode,
  useState,
} from "react";
import { lazyPanel } from "../lazyWithReload";
import { cn } from "../utils";
import { LazyBoundary } from "./LazyBoundary";
import type { ThemedSelectOption, ThemedSelectProps } from "./ThemedSelect";
import "./ThemedSelect.css";

// For selects on the first screen: the dropdown (cmdk, Radix popover) loads on
// the first open. Selects inside lazily loaded dialogs use ThemedSelect.
export const themedSelectPanel = lazyPanel("themed-select", () =>
  import("./ThemedSelect").then((module) => module.ThemedSelect),
);

export const ThemedSelectTrigger = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> & {
    value: string;
    options: ThemedSelectOption[];
    icon?: ReactNode;
  }
>(function ThemedSelectTrigger(
  { value, options, icon, className, ...props },
  ref,
) {
  const current = options.find((option) => option.value === value);
  return (
    <button
      ref={ref}
      type="button"
      className={cn("themed-select-trigger", className)}
      {...props}
    >
      {icon ?? (
        <>
          <span className="themed-select-value">{current?.label ?? value}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </>
      )}
    </button>
  );
});

export function LazyThemedSelect(
  props: Omit<ThemedSelectProps, "defaultOpen">,
) {
  const Select = themedSelectPanel.Component;
  const [openOnMount, setOpenOnMount] = useState(false);
  const trigger = (
    <ThemedSelectTrigger
      value={props.value}
      options={props.options}
      icon={props.icon}
      className={props.className}
      aria-label={props["aria-label"]}
      title={props.title}
      aria-haspopup="dialog"
      aria-expanded={false}
      aria-busy={openOnMount || undefined}
      onPointerEnter={() => void themedSelectPanel.preload()}
      onClick={() => setOpenOnMount(true)}
    />
  );
  if (!openOnMount && !themedSelectPanel.isLoaded()) return trigger;
  return (
    <LazyBoundary fallback={trigger}>
      <Select {...props} defaultOpen={openOnMount} />
    </LazyBoundary>
  );
}
