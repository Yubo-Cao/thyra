import { useState } from "react";
import { t } from "../i18n";
import { luckyWorkspaceName } from "../luckyName";
import { store, useEndpointCreationReason } from "../store";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { TextField } from "./ui/TextField";

/** Focus the name field with its suggestion selected when the dialog opens. */
function focusAndSelect(input: HTMLInputElement | null) {
  input?.focus();
  input?.select();
}

export function CreateWorkspaceDialog({
  open,
  initialName,
  initialCwd,
  onClose,
}: {
  open: boolean;
  initialName?: string;
  initialCwd?: string;
  onClose: () => void;
}) {
  const createReason = useEndpointCreationReason("workspace.create");
  const [label, setLabel] = useState("");
  const [cwd, setCwd] = useState("");
  // Reset the fields while rendering the open, so the name field mounts
  // with its suggestion already in place to be selected.
  const session = open ? `${initialName ?? ""}\n${initialCwd ?? ""}` : null;
  const [openedSession, setOpenedSession] = useState<string | null>(null);
  if (session !== openedSession) {
    setOpenedSession(session);
    if (open) {
      setLabel(initialName?.trim() || luckyWorkspaceName());
      setCwd(initialCwd?.trim() ?? "");
    }
  }

  const submit = () => {
    if (createReason) return;
    store.createWorkspace(label.trim() || undefined, cwd.trim() || undefined);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("Create Workspace")}
      size="sm"
      onSubmit={submit}
      bodyClassName="ui-dialog-stack"
      footer={
        <>
          <Button size="md" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            size="md"
            variant="primary"
            type="submit"
            disabled={!!createReason}
            title={createReason ?? undefined}
          >
            {t("Create")}
          </Button>
        </>
      }
    >
      <TextField
        ref={focusAndSelect}
        label={t("Name")}
        fullWidth
        value={label}
        onValueChange={setLabel}
        placeholder={t("Optional")}
      />
      <TextField
        label={t("Working directory")}
        fullWidth
        value={cwd}
        onValueChange={setCwd}
        placeholder={t("Optional path")}
      />
      {createReason ? <p role="status">{createReason}</p> : null}
    </Dialog>
  );
}
