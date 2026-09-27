import type { ReactNode, RefObject } from "react";
import { Dialog, Popover } from "react-aria-components/Popover";
import { cn } from "../../../utils";
import type { PopoverPlacement } from "../Popover";

export type PopoverImplProps = {
  triggerRef: RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  "aria-label": string;
  placement: PopoverPlacement;
  className?: string;
  children: ReactNode;
};

export function PopoverImpl({
  triggerRef,
  open,
  onOpenChange,
  "aria-label": ariaLabel,
  placement,
  className,
  children,
}: PopoverImplProps) {
  return (
    <Popover
      triggerRef={triggerRef}
      isOpen={open}
      onOpenChange={onOpenChange}
      placement={placement}
      offset={4}
      isNonModal
      data-slot="popover"
      className={cn("popover ui-popover", className)}
    >
      <Dialog
        aria-label={ariaLabel}
        data-slot="popover-dialog"
        className="popover__dialog ui-popover-dialog"
      >
        {children}
      </Dialog>
    </Popover>
  );
}
