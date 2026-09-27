import { useId, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Download,
  LoaderCircle,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { t } from "../i18n";
import type { SetupInfo } from "./HerdrSetupCard";
import "./HerdrSetupCard.css";
import "./HerdrSetupPanel.css";

export function HerdrSetupPanel({
  info,
  compact,
}: {
  info: SetupInfo;
  compact: boolean;
}) {
  const titleId = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestInProgress = useRef(false);
  const reviewButton = useRef<HTMLButtonElement>(null);

  function cancel() {
    setConfirming(false);
    requestAnimationFrame(() => reviewButton.current?.focus());
  }

  async function setup() {
    if (requestInProgress.current) return;
    requestInProgress.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/herdr/setup", {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-thyra-herdr-setup": "1" },
      });
      const result = await response.json();
      if (!response.ok || result?.ok !== true) {
        throw new Error(
          result?.error ??
            t("Herdr setup could not complete. Please try again."),
        );
      }
      window.location.reload();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("Herdr setup could not complete."),
      );
      setBusy(false);
      requestInProgress.current = false;
    }
  }

  const missing = info.state === "missing";
  const title = busy
    ? t("Setting up Herdr")
    : confirming
      ? missing
        ? t("Install Herdr {version}?", { version: info.verified_version })
        : t("Start Herdr as a service?")
      : missing
        ? t("Your workspace starts here")
        : t("Bring your workspace online");

  return (
    <section
      className={`herdr-setup-card${compact ? " herdr-setup-card-compact" : ""}`}
      aria-labelledby={titleId}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === "Escape" && confirming && !busy) {
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <div className="herdr-setup-heading">
        <span className="herdr-setup-mark" aria-hidden="true">
          <Terminal size={24} />
        </span>
        <span className="herdr-setup-eyebrow">
          {missing ? t("FIRST-TIME SETUP") : t("HERDR SERVER")}
        </span>
        <span className="herdr-setup-badge">
          {missing ? (
            <ShieldCheck size={13} aria-hidden="true" />
          ) : (
            <Server size={13} aria-hidden="true" />
          )}
          {missing
            ? t("Verified {version}", { version: info.verified_version })
            : t("Installed")}
        </span>
      </div>

      <div className="herdr-setup-intro" aria-live="polite">
        <h2 id={titleId}>{title}</h2>
        <p>
          {busy
            ? t(
                "Keep this page open. Thyra will reconnect when Herdr is ready.",
              )
            : confirming
              ? t(
                  "This changes the machine running Thyra, not your browser or a remote SSH host.",
                )
              : missing
                ? t(
                    "Herdr runs your terminals and agents. Set it up once, then manage your workspace from here.",
                  )
                : t(
                    "Herdr is installed but isn't running. Start it in the background to reconnect your terminals and agents.",
                  )}
        </p>
      </div>

      {busy ? (
        <div className="herdr-setup-progress" role="status">
          <LoaderCircle
            size={18}
            className="herdr-setup-spinner"
            aria-hidden="true"
          />
          <div>
            <strong>
              {missing
                ? t("Installing and starting the service")
                : t("Starting the service")}
            </strong>
            <span>{t("This may take a few minutes.")}</span>
          </div>
        </div>
      ) : (
        <ul className="herdr-setup-steps">
          <li>
            {missing ? (
              <Download size={18} aria-hidden="true" />
            ) : (
              <Check size={18} aria-hidden="true" />
            )}
            <div>
              <strong>
                {missing
                  ? `Herdr ${info.verified_version}`
                  : t("Use your existing installation")}
              </strong>
              <span>
                {missing
                  ? t("Verified release with SHA-256 checks")
                  : t("Your Herdr binary stays unchanged")}
              </span>
            </div>
          </li>
          <li>
            <Server size={18} aria-hidden="true" />
            <div>
              <strong>{t("Run as a background service")}</strong>
              <span>{t("Starts at login, independently of Thyra")}</span>
            </div>
          </li>
        </ul>
      )}

      {error ? (
        <div className="herdr-setup-error" role="alert">
          <strong>{t("Setup couldn't finish")}</strong>
          <span>{error}</span>
        </div>
      ) : null}

      <div className="herdr-setup-footer">
        {confirming ? (
          <div className="herdr-setup-actions">
            <button
              type="button"
              className="herdr-setup-primary"
              disabled={busy}
              onClick={() => void setup()}
            >
              {busy
                ? t("Setting up...")
                : error
                  ? t("Try again")
                  : missing
                    ? t("Install & start")
                    : t("Start service")}
              {!busy ? <ArrowRight size={16} aria-hidden="true" /> : null}
            </button>
            <button
              type="button"
              className="herdr-setup-cancel"
              disabled={busy}
              onClick={cancel}
            >
              {t("Cancel")}
            </button>
          </div>
        ) : (
          <button
            ref={reviewButton}
            type="button"
            className="herdr-setup-primary"
            onClick={() => setConfirming(true)}
          >
            {missing ? t("Set up Herdr") : t("Start Herdr")}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        )}
        <p className="herdr-setup-footnote">
          {confirming
            ? t("A user service will be registered on the Thyra host.")
            : t("Review the details before making any changes.")}
        </p>
      </div>
    </section>
  );
}
