import { useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** The question or consequence, e.g. t('Remove worktree "{name}"?', ...). */
  message?: ReactNode;
  confirmLabel: string;
  /** Defaults to t("Cancel"). */
  cancelLabel?: string;
  /** `danger` for destructive actions. */
  tone?: "default" | "danger";
  /** Runs on confirm; the dialog closes when it returns (or its promise resolves). */
  onConfirm: () => void | Promise<unknown>;
  confirmDisabled?: boolean;
  /**
   * Initially focused action: `cancel` (default, safest) or `confirm`, so
   * Enter confirms right away as the app's older prompts did.
   */
  initialFocus?: "cancel" | "confirm";
};

/**
 * Confirmation with `alertdialog` semantics (what HeroUI AlertDialog is):
 * no backdrop dismissal, Escape and Cancel close, initial focus on Cancel
 * unless `initialFocus="confirm"`.
 * A rejected onConfirm promise keeps the dialog open.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone = "default",
  onConfirm,
  confirmDisabled = false,
  initialFocus = "cancel",
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const confirm = async () => {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // The caller reports the failure; keep the dialog for a retry.
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      role="alertdialog"
      dismissable={false}
      closeButton={false}
      footer={
        <>
          <Button
            size="md"
            variant="secondary"
            autoFocus={initialFocus === "cancel"}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel ?? t("Cancel")}
          </Button>
          <Button
            size="md"
            variant={tone === "danger" ? "danger" : "primary"}
            autoFocus={initialFocus === "confirm"}
            disabled={confirmDisabled || pending}
            aria-busy={pending || undefined}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message}
    </Dialog>
  );
}
