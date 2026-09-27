import { useRef } from "react";
import { t } from "../i18n";
import { lazyPanel } from "../lazyWithReload";
import { Latched } from "./LazyBoundary";
import type { TextInputDialogProps } from "./TextInputDialog";
import { Button } from "./ui/Button";
import { ConfirmDialog as UiConfirmDialog } from "./ui/ConfirmDialog";
import { Dialog } from "./ui/Dialog";

// Prompt, confirmation, and message dialogs with the callback API the app's
// menus and panels use, rendered by the shared ui/ Dialog.

/** The text prompt and its field styles load on first open. */
export const textInputDialogPanel = lazyPanel("text-input-dialog", () =>
  import("./TextInputDialog").then((module) => module.TextInputDialog),
);

export function TextInputDialog(props: TextInputDialogProps) {
  const Panel = textInputDialogPanel.Component;
  return (
    <Latched open={props.open} fallback={null}>
      <Panel {...props} />
    </Latched>
  );
}

/** Keep the last shown text while the dialog plays its exit animation. */
function useShownWhileOpen<T>(open: boolean, value: T): T {
  const shown = useRef(value);
  if (open) shown.current = value;
  return shown.current;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = t("Confirm"),
  danger = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const shown = useShownWhileOpen(open, { title, message, confirmLabel });
  return (
    <UiConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={shown.title}
      message={shown.message}
      confirmLabel={shown.confirmLabel}
      tone={danger ? "danger" : "default"}
      // Enter confirms at once, as these prompts always have.
      initialFocus="confirm"
      onConfirm={onConfirm}
    />
  );
}

export function MessageDialog({
  open,
  title,
  message,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
}) {
  const shown = useShownWhileOpen(open, { title, message });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={shown.title}
      size="sm"
      role="alertdialog"
      footer={
        <Button size="md" variant="primary" autoFocus onClick={onClose}>
          {t("OK")}
        </Button>
      }
    >
      {shown.message}
    </Dialog>
  );
}
