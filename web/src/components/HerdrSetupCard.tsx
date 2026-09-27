import { useEffect, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { t } from "../i18n";
import { lazyPanel } from "../lazyWithReload";
import { LazyBoundary } from "./LazyBoundary";
import "./HerdrSetupCard.css";

export type SetupInfo = {
  state: "missing" | "installed";
  verified_version: string;
};

// The setup walkthrough only appears when Herdr is missing or stopped, so it
// loads after the status check asks for it.
const herdrSetupPanel = lazyPanel("herdr-setup", () =>
  import("./HerdrSetupPanel").then((module) => module.HerdrSetupPanel),
);
const HerdrSetupPanel = herdrSetupPanel.Component;

export function HerdrSetupCard({
  compact = false,
  enabled = true,
  children = null,
}: {
  compact?: boolean;
  enabled?: boolean;
  children?: ReactNode;
}) {
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch("/api/herdr/status", {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((status) => {
        if (controller.signal.aborted) return;
        if (
          status?.can_setup === true &&
          (status.state === "missing" || status.state === "installed") &&
          typeof status.verified_version === "string"
        ) {
          setInfo(status);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [enabled]);

  if (!enabled) return children;
  const checkingStatus = compact ? null : (
    <div className="herdr-setup-checking" role="status">
      <LoaderCircle
        size={16}
        className="herdr-setup-spinner"
        aria-hidden="true"
      />
      {t("Checking Herdr connection")}
    </div>
  );
  if (checking) return checkingStatus;
  if (!info) return children;

  return (
    <LazyBoundary fallback={checkingStatus}>
      <HerdrSetupPanel info={info} compact={compact} />
    </LazyBoundary>
  );
}
