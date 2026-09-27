import { useMemo, type ReactNode, type RefObject } from "react";
import {
  Tooltip,
  TooltipTriggerStateContext,
} from "react-aria-components/Tooltip";
import type { TooltipPlacement } from "../Tooltip";

export type TooltipPopupProps = {
  id: string;
  triggerRef: RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placement: TooltipPlacement;
  children: ReactNode;
};

export function TooltipPopup({
  id,
  triggerRef,
  open,
  onOpenChange,
  placement,
  children,
}: TooltipPopupProps) {
  // React Aria's Tooltip reads its state from TooltipTrigger's context even
  // when controlled; the trigger logic lives in ui/Tooltip, so provide it.
  const state = useMemo(
    () => ({
      isOpen: open,
      open: () => onOpenChange(true),
      close: () => onOpenChange(false),
      shouldSkipAnimation: false,
    }),
    [open, onOpenChange],
  );
  return (
    <TooltipTriggerStateContext value={state}>
      <Tooltip
        triggerRef={triggerRef}
        isOpen={open}
        onOpenChange={onOpenChange}
        placement={placement}
        offset={6}
        data-slot="tooltip"
        className="tooltip ui-tooltip"
      >
        <span id={id}>{children}</span>
      </Tooltip>
    </TooltipTriggerStateContext>
  );
}
