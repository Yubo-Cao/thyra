import { t } from "./i18n";
import { formatUiRelativeTime } from "./uiLocale";

// Anonymous read-only share links: the owner's API (list, create once,
// revoke) and how their expiry reads. The bridge stores only a digest of
// each link's secret, so a new link's URL is shown once.

export type ShareLinkState = "active" | "expired" | "revoked" | "used";

export type ShareLinkView = {
  id: string;
  pane_id: string | null;
  label: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  max_uses: number | null;
  uses: number;
  /** Guests watching through it now. */
  guests: number;
  state: ShareLinkState;
};

export const SHARE_EXPIRY_OPTIONS = ["1h", "24h", "7d"] as const;
export type ShareExpiry = (typeof SHARE_EXPIRY_OPTIONS)[number];

/** "in 23 hours" (localized), rounded up to minutes, hours or days. */
export function relativeExpiry(expiresAt: number, now = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((expiresAt - now) / 60_000));
  if (minutes < 90) return formatUiRelativeTime(minutes, "minute");
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return formatUiRelativeTime(hours, "hour");
  return formatUiRelativeTime(Math.ceil(hours / 24), "day");
}

async function shareRequest<T>(
  path: string,
  connectionId: string,
  workspaceId: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${path}?${new URLSearchParams({
    connection_id: connectionId,
    workspace_id: workspaceId,
  })}`;
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok)
    throw new Error(
      data.error || t("Request failed ({status})", { status: response.status }),
    );
  return data;
}

export async function listShareLinks(
  connectionId: string,
  workspaceId: string,
): Promise<ShareLinkView[]> {
  const data = await shareRequest<{ links?: ShareLinkView[] }>(
    "/api/share-links",
    connectionId,
    workspaceId,
  );
  return data.links ?? [];
}

/** Create a link; its `url` carries the secret and is never shown again. */
export function createShareLink(
  connectionId: string,
  workspaceId: string,
  options: {
    paneId: string | null;
    expires: ShareExpiry;
    label: string;
    maxUses: number | null;
  },
): Promise<{ link: ShareLinkView; url: string }> {
  return shareRequest("/api/share-links", connectionId, workspaceId, {
    ...(options.paneId ? { pane_id: options.paneId } : {}),
    expires: options.expires,
    ...(options.label.trim() ? { label: options.label.trim() } : {}),
    ...(options.maxUses ? { max_uses: options.maxUses } : {}),
  });
}

export async function revokeShareLink(
  connectionId: string,
  workspaceId: string,
  id: string,
): Promise<ShareLinkView[]> {
  const data = await shareRequest<{ links?: ShareLinkView[] }>(
    "/api/share-links/revoke",
    connectionId,
    workspaceId,
    { id },
  );
  return data.links ?? [];
}
