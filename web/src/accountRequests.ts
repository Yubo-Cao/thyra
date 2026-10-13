import { t } from "./i18n";
import { formatUiRelativeTime } from "./uiLocale";

// Account and admin pages: JSON requests to the bridge and shared labels.

/** GET `path`, or POST `body` to it; rejects with the bridge's `error`. */
export async function request<T>(
  path: string,
  body?: Record<string, unknown> | Blob,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body
      ? {
          method: "POST",
          headers: {
            "content-type":
              body instanceof Blob ? body.type : "application/json",
          },
          body: body instanceof Blob ? body : JSON.stringify(body),
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

/** How long ago (or until) `timestamp`, such as "5 minutes ago". */
export function since(timestamp: number): string {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) return formatUiRelativeTime(seconds, "second");
  if (absolute < 3600)
    return formatUiRelativeTime(Math.round(seconds / 60), "minute");
  if (absolute < 86400)
    return formatUiRelativeTime(Math.round(seconds / 3600), "hour");
  return formatUiRelativeTime(Math.round(seconds / 86400), "day");
}

export const PROVIDER_NAMES: Record<string, string> = {
  github: "GitHub",
  google: "Google",
  microsoft: "Microsoft",
  oidc: "SSO",
  tailscale: "Tailscale",
};
