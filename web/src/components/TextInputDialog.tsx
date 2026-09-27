import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { TextField } from "./ui/TextField";

export type TextInputDialogProps = {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
};

/**
 * One-field prompt (rename, new branch): the field starts with its text
 * selected, Enter submits, Escape and the backdrop cancel. Loaded on first
 * open through ModalDialogs so the field styles stay off the first screen.
 */
export function TextInputDialog({
  open,
  title,
  label,
  initialValue = "",
  placeholder,
  submitLabel = t("Save"),
  onSubmit,
  onClose,
}: TextInputDialogProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Each opening starts from the caller's value with the text selected.
  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    const frame = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [initialValue, open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      size="sm"
      onSubmit={() => onSubmit(value)}
      footer={
        <>
          <Button size="md" variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button size="md" variant="primary" type="submit">
            {submitLabel}
          </Button>
        </>
      }
    >
      <TextField
        ref={inputRef}
        label={label}
        value={value}
        placeholder={placeholder}
        autoFocus
        fullWidth
        onValueChange={setValue}
      />
    </Dialog>
  );
}
