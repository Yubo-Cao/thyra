import { X } from "lucide-react";
import { forwardRef } from "react";
import { t } from "../../i18n";
import { IconButton, type IconButtonProps } from "./IconButton";

export type CloseButtonProps = Omit<IconButtonProps, "icon" | "label"> & {
  /** Accessible name; defaults to t("Close"). */
  label?: string;
};

/** The X button for dialogs, panels, and toasts. */
export const CloseButton = forwardRef<HTMLButtonElement, CloseButtonProps>(
  ({ label, tooltip = false, ...props }, ref) => (
    <IconButton
      ref={ref}
      label={label ?? t("Close")}
      icon={<X size={15} strokeWidth={2.2} aria-hidden="true" />}
      tooltip={tooltip}
      {...props}
    />
  ),
);
CloseButton.displayName = "CloseButton";
