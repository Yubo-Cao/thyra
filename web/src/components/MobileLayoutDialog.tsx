import { msg, t } from "../i18n";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Select } from "./ui/Select";
import { TextField } from "./ui/TextField";
import {
  type LayoutMode,
  MOBILE_BREAKPOINT_MAX,
  MOBILE_BREAKPOINT_MIN,
  type SidebarOrder,
  updateLayoutPreferences,
  useLayoutPreferences,
} from "../layoutPreferences";
import "./MobileLayoutDialog.css";

const DISPLAY_MODE_OPTIONS = [
  { value: "auto", label: msg("Automatic") },
  { value: "mobile", label: msg("Mobile") },
  { value: "desktop", label: msg("Desktop") },
];
const SIDEBAR_ORDER_OPTIONS = [
  { value: "agents-first", label: msg("Agents on top") },
  { value: "workspaces-first", label: msg("Workspaces on top") },
];
const translateOptions = (options: { value: string; label: string }[]) =>
  options.map((option) => ({ ...option, label: t(option.label) }));

export function MobileLayoutDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { preferences, mobile, urlOverride } = useLayoutPreferences();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("Layout Preferences")}
      description={t(
        "Choose display mode, mobile breakpoint, and sidebar order.",
      )}
      closeLabel={t("Close Layout Preferences")}
      className="mobile-layout-dialog"
      footer={
        <>
          <span className="mobile-layout-note">
            {t("Changes are saved in this browser.")}
          </span>
          <Button variant="primary" size="md" onClick={onClose}>
            {t("Done")}
          </Button>
        </>
      }
    >
      <div className="layout-preferences">
        <label className="layout-preference">
          <span>{t("Display mode")}</span>
          <Select
            aria-label={t("Display mode")}
            align="end"
            value={urlOverride ?? preferences.mode}
            options={translateOptions(DISPLAY_MODE_OPTIONS)}
            onChange={(mode) =>
              updateLayoutPreferences({ mode: mode as LayoutMode })
            }
          />
        </label>
        <p className="muted">
          {urlOverride
            ? mobile
              ? t("Using mobile layout (URL override).")
              : t("Using desktop layout (URL override).")
            : mobile
              ? t("Using mobile layout.")
              : t("Using desktop layout.")}{" "}
          {t(
            "Bookmark with ?layout=mobile or ?layout=desktop to force a layout.",
          )}
        </p>
        <label className="layout-preference">
          <span>{t("Mobile up to (px)")}</span>
          <TextField
            key={preferences.mobileBreakpoint}
            className="layout-breakpoint-field"
            type="number"
            min={MOBILE_BREAKPOINT_MIN}
            max={MOBILE_BREAKPOINT_MAX}
            step={1}
            defaultValue={preferences.mobileBreakpoint}
            onBlur={(event) => {
              if (
                event.currentTarget.value &&
                event.currentTarget.validity.valid
              ) {
                updateLayoutPreferences({
                  mobileBreakpoint: event.currentTarget.valueAsNumber,
                });
              } else {
                event.currentTarget.value = String(
                  preferences.mobileBreakpoint,
                );
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        {(["mobile", "desktop"] as const).map((view) => (
          <label className="layout-preference" key={view}>
            <span>
              {view === "mobile" ? t("Mobile sidebar") : t("Desktop sidebar")}
            </span>
            <Select
              aria-label={
                view === "mobile" ? t("Mobile sidebar") : t("Desktop sidebar")
              }
              align="end"
              value={preferences[`${view}SidebarOrder`]}
              options={translateOptions(SIDEBAR_ORDER_OPTIONS)}
              onChange={(order) =>
                updateLayoutPreferences({
                  [`${view}SidebarOrder`]: order as SidebarOrder,
                })
              }
            />
          </label>
        ))}
        <p className="muted">
          {t("Sidebar order applies when Agents is set to Separate.")}
        </p>
      </div>
    </Dialog>
  );
}
