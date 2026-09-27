import { isTailnetAddress } from "../identity/tailscale";
import type { RequestAccess } from "./request-access";

/**
 * Tailnet login: a request is authenticated as the owner when it came
 * through a trusted reverse proxy, its forwarded client address is a
 * tailnet address, and Tailscale `whois` names a user for it. The caller
 * then issues the normal session cookie, so later requests skip `whois`.
 *
 * This trusts every user of the tailnet with full access. It must stay off
 * for any listener or proxy reachable from outside the tailnet (such as a
 * public tunnel), where forwarded addresses are not tailnet peers.
 */

export type TailnetAuthMode = "admin" | "off";

/**
 * `THYRA_TAILNET_AUTH`: `admin` or `off`. Unset means `admin` when a
 * Tailscale `whois` backend is available. Unknown values disable it.
 */
export function parseTailnetAuthMode(
  value: string | undefined,
  whoisAvailable: boolean,
): { mode: TailnetAuthMode; warning?: string } {
  const text = value?.trim().toLowerCase();
  if (!text) return { mode: whoisAvailable ? "admin" : "off" };
  if (text === "off" || text === "0" || text === "false")
    return { mode: "off" };
  if (text === "admin") {
    return whoisAvailable
      ? { mode: "admin" }
      : {
          mode: "off",
          warning: "THYRA_TAILNET_AUTH=admin needs Tailscale whois; disabled",
        };
  }
  return {
    mode: "off",
    warning: `ignoring unknown THYRA_TAILNET_AUTH value ${JSON.stringify(value)}; tailnet login disabled`,
  };
}

/** The tailnet login that authenticates this request, or null. */
export async function tailnetLogin(args: {
  mode: TailnetAuthMode;
  access: RequestAccess;
  lookupUser: (address: string) => Promise<{ login: string } | null>;
}): Promise<string | null> {
  const address = args.access.clientAddress;
  if (
    args.mode !== "admin" ||
    !args.access.proxied ||
    !address ||
    !isTailnetAddress(address)
  ) {
    return null;
  }
  try {
    return (await args.lookupUser(address))?.login ?? null;
  } catch {
    return null;
  }
}
