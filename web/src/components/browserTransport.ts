import { t } from "../i18n";
import type { ConnectionStatus } from "../api";

export interface BrowserTransportPresentation {
  label: string;
  clientCount: number | null;
  /** "3 browsers on 2 devices": tabs and merged contexts share a device. */
  countLabel: string | null;
  pauseOthersLabel: string | null;
  needsResume: boolean;
  toggleLabel: string;
}

/** Browser sockets, grouped by the devices the bridge recognized. */
export function browserCountLabel(
  clients: number,
  devices: number | null | undefined,
): string {
  if (typeof devices === "number" && devices > 0 && devices < clients) {
    return devices === 1
      ? t("{count} browsers on 1 device", { count: clients })
      : t("{count} browsers on {devices} devices", {
          count: clients,
          devices,
        });
  }
  return clients === 1
    ? t("{count} browser", { count: clients })
    : t("{count} browsers", { count: clients });
}

export function browserTransportPresentation(
  connectionPaused: boolean,
  status: ConnectionStatus,
  reportedClientCount: number | null | undefined,
  reportedDeviceCount?: number | null,
): BrowserTransportPresentation {
  let label = t("Browser disconnected from bridge");
  if (connectionPaused) {
    label = t("Browser sync paused");
  } else if (status === "connected") {
    label = t("Browser connected to bridge");
  } else if (status === "connecting") {
    label = t("Browser connecting to bridge");
  }
  const clientCount =
    !connectionPaused && status === "connected"
      ? (reportedClientCount ?? null)
      : null;
  const otherClientCount =
    typeof clientCount === "number" ? Math.max(0, clientCount - 1) : 0;
  let pauseOthersLabel: string | null = null;
  if (otherClientCount === 1) {
    pauseOthersLabel = t("Pause other browser");
  } else if (otherClientCount > 1) {
    pauseOthersLabel = t("Pause other browsers ({count})", {
      count: otherClientCount,
    });
  }
  const needsResume = connectionPaused || status === "disconnected";
  let toggleLabel = t("Pause browser sync");
  if (connectionPaused) {
    toggleLabel = t("Resume browser sync");
  } else if (status === "disconnected") {
    toggleLabel = t("Reconnect browser");
  }

  return {
    label,
    clientCount,
    countLabel:
      typeof clientCount === "number"
        ? browserCountLabel(clientCount, reportedDeviceCount)
        : null,
    pauseOthersLabel,
    needsResume,
    toggleLabel,
  };
}
