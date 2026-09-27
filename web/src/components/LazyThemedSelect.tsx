import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { lazyPanel } from "../lazyWithReload";
import { cn } from "../utils";
import { LazyBoundary } from "./LazyBoundary";
import type { ThemedSelectProps } from "./ThemedSelect";
import { Button } from "./ui/Button";

// For selects on the first screen: ui/Select and its HeroUI select styles
// load on the first open (or idle prefetch). Until then a ghost Button with
// the same geometry stands in; selects inside lazily loaded dialogs use
// ThemedSelect or ui/Select directly.
export const themedSelectPanel = lazyPanel("themed-select", () =>
  import("./ThemedSelect").then((module) => module.ThemedSelect),
);

export function LazyThemedSelect(
  props: Omit<ThemedSelectProps, "defaultOpen">,
) {
  const Select = themedSelectPanel.Component;
  const [openOnMount, setOpenOnMount] = useState(false);
  const current = props.options.find((option) => option.value === props.value);
  const trigger = (
    <span className={cn("lazy-select", props.className)}>
      <Button
        icon={!!props.icon}
        aria-label={props["aria-label"]}
        data-tooltip={props.title}
        aria-haspopup="listbox"
        aria-expanded={false}
        aria-busy={openOnMount || undefined}
        onPointerEnter={() => void themedSelectPanel.preload()}
        onFocus={() => void themedSelectPanel.preload()}
        onClick={() => setOpenOnMount(true)}
      >
        {props.icon ?? (
          <>
            <span>{current?.label ?? props.value}</span>
            <ChevronDown size={13} aria-hidden="true" />
          </>
        )}
      </Button>
    </span>
  );
  if (!openOnMount && !themedSelectPanel.isLoaded()) return trigger;
  return (
    <LazyBoundary fallback={trigger}>
      <Select {...props} defaultOpen={openOnMount} />
    </LazyBoundary>
  );
}
