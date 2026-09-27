import { t } from "../i18n";
import { MobileSheetHandle } from "./MobileSheetHandle";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import "./ConfigurationDialog.css";

export function ConfigurationLoadingDialog({
  onClose,
  buttonLabel = t("Cancel"),
}: {
  onClose: () => void;
  buttonLabel?: string;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("Loading Configuration")}
      size="sm"
      closeButton={false}
      className="mobile-sheet"
      headerStart={
        <MobileSheetHandle
          label={t("Dismiss loading configuration")}
          onClose={onClose}
        />
      }
      footer={
        <Button variant="secondary" size="md" autoFocus onClick={onClose}>
          {buttonLabel}
        </Button>
      }
    >
      <p className="configuration-loading" role="status">
        {t("Loading configuration...")}
      </p>
    </Dialog>
  );
}
