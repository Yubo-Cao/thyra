import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "../../utils";
import "./RadixPopover.css";

// Legacy Radix popover kept for its cmdk-based users (CommandCombobox,
// ThemedSelect, settings pickers). New code uses ui/Popover (React Aria,
// lazily loaded); migrate these callers and then delete this file.

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 8, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <div className="popover-portal">
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn("popover-content", className)}
        {...props}
      />
    </div>
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverContent, PopoverTrigger };
