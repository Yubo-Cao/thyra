import { isTailnetAddress } from "../identity/tailscale";
import type { RequestAccess } from "./request-access";

/**
 * Tailnet login: a request is logged in to the account of a Tailscale user
 * when it came through a trusted reverse proxy, its forwarded client address
 * is a tailnet address, and Tailscale `whois` names a user for it. The
 * account is created on first sight with the mode's instance role; the caller
 * then issues a session cookie, so later requests skip `whois`.
 *
 * With `admin`, every user of the tailnet who reaches the proxy is an
 * instance admin. It is tied to the `tailnet` listener kind: the public
 * listener (Cloudflare Tunnel) never runs it, and a proxy reachable from
 * outside the tailnet must not forward to the primary listener while it is on.
 */

export type TailnetAuthMode = "admin" | "member" | "off";

/**
 * `THYRA_TAILNET_AUTH`: `admin`, `member` or `off`. Unset means `admin` when
 * a Tailscale `whois` backend is available. Unknown values disable it.
 */
export function parseTailnetAuthMode(
  value: string | undefined,
  whoisAvailable: boolean,
): { mode: TailnetAuthMode; warning?: string } {
  const text = value?.trim().toLowerCase();
  if (!text) return { mode: whoisAvailable ? "admin" : "off" };
  if (text === "off" || text === "0" || text === "false")
    return { mode: "off" };
  if (text === "admin" || text === "member") {
    return whoisAvailable
      ? { mode: text }
      : {
          mode: "off",
          warning: `THYRA_TAILNET_AUTH=${text} needs Tailscale whois; disabled`,
        };
  }
  return {
    mode: "off",
    warning: `ignoring unknown THYRA_TAILNET_AUTH value ${JSON.stringify(value)}; tailnet login disabled`,
  };
}

export type TailnetUser = { login: string; displayName?: string };

/**
 * The Tailscale user this request logs in as, or null. Only the `tailnet`
 * listener can produce one; a request on the public listener, or one that
 * carries Cloudflare edge headers, never does, whatever its forwarded
 * address. Lookup failures fail closed.
 */
export async function tailnetUser(args: {
  mode: TailnetAuthMode;
  access: RequestAccess;
  lookupUser: (address: string) => Promise<TailnetUser | null>;
}): Promise<TailnetUser | null> {
  const address = args.access.clientAddress;
  if (
    args.mode === "off" ||
    args.access.listener !== "tailnet" ||
    args.access.cloudflare ||
    !args.access.proxied ||
    !address ||
    !isTailnetAddress(address)
  ) {
    return null;
  }
  try {
    const user = await args.lookupUser(address);
    return user?.login ? user : null;
  } catch {
    return null;
  }
}

/** The Tailscale login that authenticates this request, or null. */
export async function tailnetLogin(
  args: Parameters<typeof tailnetUser>[0],
): Promise<string | null> {
  return (await tailnetUser(args))?.login ?? null;
}
