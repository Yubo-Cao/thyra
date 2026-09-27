import { type Logger, silentLogger } from "../utils/logger";
import { parseTrustedProxies } from "./client-address";
import { createIdentityService } from "./identity-service";
import { createIdentityStore, identityStorePath } from "./identity-store";
import {
  createTailscaleWhois,
  tailscaleWhoisBackendFromEnv,
} from "./tailscale";

/**
 * Identity service configured from `THYRA_TRUSTED_PROXIES`,
 * `THYRA_TAILSCALE_IDENTITY`/`_SOCKET`/`_CLI` and `THYRA_IDENTITY_PATH`.
 */
export function createIdentityServiceFromEnv<Socket extends object>(args: {
  secureCookies: boolean;
  env?: Record<string, string | undefined>;
  logger?: Logger;
}) {
  const env = args.env ?? process.env;
  const logger = args.logger ?? silentLogger;
  const trustedProxies = parseTrustedProxies(env.THYRA_TRUSTED_PROXIES);
  if (trustedProxies.invalid.length > 0) {
    logger.warn("ignoring invalid THYRA_TRUSTED_PROXIES entries", {
      entries: trustedProxies.invalid.join(","),
    });
  }
  let path: string | null = null;
  try {
    path = identityStorePath(env);
  } catch (error) {
    logger.warn("identity store disabled; names will not persist", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const whoisBackend = tailscaleWhoisBackendFromEnv(env);
  logger.debug("identity sources", {
    tailscale: whoisBackend?.description ?? "unavailable",
  });
  return createIdentityService<Socket>({
    store: createIdentityStore({ path, logger }),
    whois: createTailscaleWhois({
      backend: whoisBackend?.backend ?? null,
      logger,
    }),
    trustedProxies,
    secureCookies: args.secureCookies,
    logger,
  });
}
