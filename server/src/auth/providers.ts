/**
 * Optional sign-in providers, each on only when its variables are set
 * (typically from `~/.config/thyra/auth-providers.env`, loaded by the
 * service's `EnvironmentFile`):
 *
 * - Email (Resend): `THYRA_RESEND_API_KEY` and `THYRA_EMAIL_FROM`.
 * - GitHub: `THYRA_GITHUB_CLIENT_ID` and `THYRA_GITHUB_CLIENT_SECRET`.
 * - Google: `THYRA_GOOGLE_CLIENT_ID` and `THYRA_GOOGLE_CLIENT_SECRET`.
 * - Microsoft (personal, work and school accounts):
 *   `THYRA_MICROSOFT_CLIENT_ID` and `THYRA_MICROSOFT_CLIENT_SECRET`, and
 *   optionally `THYRA_MICROSOFT_TENANT` (default `common`).
 * - Any other OpenID Connect provider (Okta, Auth0, Keycloak, Authentik,
 *   GitLab, ...): `THYRA_OIDC_ISSUER`, `THYRA_OIDC_CLIENT_ID` and
 *   `THYRA_OIDC_CLIENT_SECRET`; `THYRA_OIDC_NAME` labels its button
 *   (default "SSO") and `THYRA_OIDC_SCOPES` overrides `openid email profile`.
 *   Its endpoints come from the issuer's discovery document.
 * - `THYRA_SIGNUP`: `invite` (default; unknown identities get no account)
 *   or `open` (they become members without grants).
 * - `THYRA_SIGNUP_DOMAINS`: comma-separated email domains; an unknown
 *   identity whose verified address is in one becomes a member without
 *   grants even when sign-up is invite-only.
 *
 * The server reads that file too (`providerEnvironment`); variables already
 * in the environment win.
 *
 * `THYRA_TEST_RESEND_URL`, `THYRA_TEST_GITHUB_URL`, `THYRA_TEST_GOOGLE_URL`
 * and `THYRA_TEST_MICROSOFT_URL` point a provider at a local stub server;
 * they are accepted only for loopback HTTP(S) URLs, so they can never
 * redirect real credentials elsewhere. The OIDC issuer must be HTTPS, or
 * HTTP on loopback.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "../config/data-paths";
import { parseEnvironmentFile } from "../config/environment";

export type SignupPolicy = "invite" | "open";

export const AUTH_PROVIDERS_FILE = "auth-providers.env";

/**
 * The process environment over `auth-providers.env` in the data directory,
 * so providers work whether or not the service manager loaded the file.
 * The file holds secrets: a copy readable by others is refused.
 */
export function providerEnvironment(
  env: Record<string, string | undefined> = process.env,
  path = join(dataRoot(), AUTH_PROVIDERS_FILE),
): { env: Record<string, string | undefined>; warnings: string[] } {
  const warnings: string[] = [];
  if (!existsSync(path)) return { env, warnings };
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    warnings.push(
      `ignoring ${path}: it is readable by other users; run chmod 600 on it`,
    );
    return { env, warnings };
  }
  const merged: Record<string, string | undefined> = {
    ...parseEnvironmentFile(readFileSync(path, "utf8")),
  };
  for (const [key, value] of Object.entries(env))
    if (value !== undefined) merged[key] = value;
  return { env: merged, warnings };
}

export type EmailConfig = {
  apiKey: string;
  from: string;
  /** Resend's `POST /emails` endpoint. */
  endpoint: string;
};

export const OAUTH_PROVIDER_IDS = [
  "github",
  "google",
  "microsoft",
  "oidc",
] as const;

export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

export function isOAuthProviderId(value: unknown): value is OAuthProviderId {
  return OAUTH_PROVIDER_IDS.includes(value as OAuthProviderId);
}

export type OAuthProviderConfig = {
  id: OAuthProviderId;
  /** What buttons and pages call it: "Google", or `THYRA_OIDC_NAME`. */
  label: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** GitHub `/user`, or the OpenID Connect userinfo endpoint. */
  userUrl: string;
  /** GitHub `/user/emails` (primary and verified flags). */
  emailsUrl?: string;
  /**
   * An OpenID Connect issuer whose discovery document supplies the three
   * endpoints above (left empty until then); identities are bound to it.
   */
  issuer?: string;
  scopes: string[];
  /** Hosts profile pictures may be imported from; null: none. */
  avatarHosts: RegExp | null;
};

export type AuthProviders = {
  email: EmailConfig | null;
  github: OAuthProviderConfig | null;
  google: OAuthProviderConfig | null;
  microsoft: OAuthProviderConfig | null;
  oidc: OAuthProviderConfig | null;
  signup: SignupPolicy;
  /** Verified email domains that may sign up whatever `signup` says. */
  signupDomains: string[];
  warnings: string[];
};

type Env = Record<string, string | undefined>;

/** A loopback stub base URL, or null (with a warning) for anything else. */
function testBase(env: Env, name: string, warnings: string[]): string | null {
  const value = env[name]?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "[::1]")
    )
      return url.origin;
  } catch {}
  warnings.push(`ignoring ${name}: only loopback test servers are allowed`);
  return null;
}

function pair(
  env: Env,
  idName: string,
  secretName: string,
  label: string,
  warnings: string[],
): { id: string; secret: string } | null {
  const id = env[idName]?.trim();
  const secret = env[secretName]?.trim();
  if (id && secret) return { id, secret };
  if (id || secret)
    warnings.push(
      `${label} sign-in needs both ${idName} and ${secretName}; it stays off`,
    );
  return null;
}

/** An issuer URL without a trailing slash: HTTPS, or HTTP on loopback. */
function issuerUrl(value: string, warnings: string[]): string | null {
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]";
    if (
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && loopback))
    )
      return url.href.replace(/\/+$/, "");
  } catch {}
  warnings.push(
    "ignoring THYRA_OIDC_ISSUER: it must be an https:// URL without a query; OIDC sign-in stays off",
  );
  return null;
}

function signupDomains(env: Env, warnings: string[]): string[] {
  const domains: string[] = [];
  for (const entry of (env.THYRA_SIGNUP_DOMAINS ?? "").split(",")) {
    const domain = entry.trim().toLowerCase().replace(/^@/, "");
    if (!domain) continue;
    if (/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain))
      domains.push(domain);
    else
      warnings.push(
        `ignoring THYRA_SIGNUP_DOMAINS entry ${JSON.stringify(entry.trim())}: not a domain name`,
      );
  }
  return [...new Set(domains)];
}

export function loadAuthProviders(env: Env = process.env): AuthProviders {
  const warnings: string[] = [];
  const signupText = env.THYRA_SIGNUP?.trim().toLowerCase() || "invite";
  const signup: SignupPolicy = signupText === "open" ? "open" : "invite";
  if (signupText !== "open" && signupText !== "invite")
    warnings.push(
      `ignoring unknown THYRA_SIGNUP ${JSON.stringify(env.THYRA_SIGNUP)}; sign-up stays invite-only`,
    );

  let email: EmailConfig | null = null;
  const apiKey = env.THYRA_RESEND_API_KEY?.trim();
  const from = env.THYRA_EMAIL_FROM?.trim();
  if (apiKey && from) {
    const base = testBase(env, "THYRA_TEST_RESEND_URL", warnings);
    email = {
      apiKey,
      from,
      endpoint: `${base ?? "https://api.resend.com"}/emails`,
    };
  } else if (apiKey || from) {
    warnings.push(
      "email sign-in needs both THYRA_RESEND_API_KEY and THYRA_EMAIL_FROM; it stays off",
    );
  }

  let github: OAuthProviderConfig | null = null;
  const githubKeys = pair(
    env,
    "THYRA_GITHUB_CLIENT_ID",
    "THYRA_GITHUB_CLIENT_SECRET",
    "GitHub",
    warnings,
  );
  if (githubKeys) {
    const base = testBase(env, "THYRA_TEST_GITHUB_URL", warnings);
    github = {
      id: "github",
      label: "GitHub",
      clientId: githubKeys.id,
      clientSecret: githubKeys.secret,
      authorizeUrl: `${base ?? "https://github.com"}/login/oauth/authorize`,
      tokenUrl: `${base ?? "https://github.com"}/login/oauth/access_token`,
      userUrl: `${base ?? "https://api.github.com"}/user`,
      emailsUrl: `${base ?? "https://api.github.com"}/user/emails`,
      scopes: ["read:user", "user:email"],
      avatarHosts: base
        ? /^(?:127\.0\.0\.1|localhost)$/
        : /^avatars\.githubusercontent\.com$/,
    };
  }

  let google: OAuthProviderConfig | null = null;
  const googleKeys = pair(
    env,
    "THYRA_GOOGLE_CLIENT_ID",
    "THYRA_GOOGLE_CLIENT_SECRET",
    "Google",
    warnings,
  );
  if (googleKeys) {
    const base = testBase(env, "THYRA_TEST_GOOGLE_URL", warnings);
    google = {
      id: "google",
      label: "Google",
      clientId: googleKeys.id,
      clientSecret: googleKeys.secret,
      authorizeUrl: base
        ? `${base}/o/oauth2/v2/auth`
        : "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: base ? `${base}/token` : "https://oauth2.googleapis.com/token",
      userUrl: base
        ? `${base}/v1/userinfo`
        : "https://openidconnect.googleapis.com/v1/userinfo",
      scopes: ["openid", "email", "profile"],
      avatarHosts: base
        ? /^(?:127\.0\.0\.1|localhost)$/
        : /^[a-z0-9-]+\.googleusercontent\.com$/,
    };
  }

  let microsoft: OAuthProviderConfig | null = null;
  const microsoftKeys = pair(
    env,
    "THYRA_MICROSOFT_CLIENT_ID",
    "THYRA_MICROSOFT_CLIENT_SECRET",
    "Microsoft",
    warnings,
  );
  if (microsoftKeys) {
    const base = testBase(env, "THYRA_TEST_MICROSOFT_URL", warnings);
    let tenant = env.THYRA_MICROSOFT_TENANT?.trim() || "common";
    if (!/^[A-Za-z0-9.-]{1,100}$/.test(tenant)) {
      warnings.push(
        "ignoring THYRA_MICROSOFT_TENANT: expected a tenant id, a domain, common, organizations or consumers",
      );
      tenant = "common";
    }
    const login = `${base ?? "https://login.microsoftonline.com"}/${tenant}/oauth2/v2.0`;
    microsoft = {
      id: "microsoft",
      label: "Microsoft",
      clientId: microsoftKeys.id,
      clientSecret: microsoftKeys.secret,
      authorizeUrl: `${login}/authorize`,
      tokenUrl: `${login}/token`,
      userUrl: `${base ?? "https://graph.microsoft.com"}/oidc/userinfo`,
      scopes: ["openid", "email", "profile"],
      // Its pictures need the access token; upload one instead.
      avatarHosts: null,
    };
  }

  let oidc: OAuthProviderConfig | null = null;
  const oidcKeys = pair(
    env,
    "THYRA_OIDC_CLIENT_ID",
    "THYRA_OIDC_CLIENT_SECRET",
    "OIDC",
    warnings,
  );
  const issuerText = env.THYRA_OIDC_ISSUER?.trim();
  if (oidcKeys && !issuerText)
    warnings.push("OIDC sign-in needs THYRA_OIDC_ISSUER; it stays off");
  else if (issuerText && !oidcKeys && !env.THYRA_OIDC_CLIENT_ID?.trim())
    warnings.push(
      "OIDC sign-in needs THYRA_OIDC_CLIENT_ID and THYRA_OIDC_CLIENT_SECRET; it stays off",
    );
  const issuer =
    oidcKeys && issuerText ? issuerUrl(issuerText, warnings) : null;
  if (oidcKeys && issuer) {
    const scopes = (env.THYRA_OIDC_SCOPES?.trim() || "openid email profile")
      .split(/[\s,]+/)
      .filter(Boolean);
    if (!scopes.includes("openid")) scopes.unshift("openid");
    oidc = {
      id: "oidc",
      label: env.THYRA_OIDC_NAME?.trim().slice(0, 40) || "SSO",
      clientId: oidcKeys.id,
      clientSecret: oidcKeys.secret,
      authorizeUrl: "",
      tokenUrl: "",
      userUrl: "",
      issuer,
      scopes,
      avatarHosts: null,
    };
  }

  return {
    email,
    github,
    google,
    microsoft,
    oidc,
    signup,
    signupDomains: signupDomains(env, warnings),
    warnings,
  };
}

/** The configured OAuth or OpenID Connect provider with this id. */
export function oauthProvider(
  providers: AuthProviders,
  id: unknown,
): OAuthProviderConfig | null {
  return isOAuthProviderId(id) ? providers[id] : null;
}

/** Which providers the login page and account page may offer. */
export function providerFlags(providers: AuthProviders) {
  return {
    email: Boolean(providers.email),
    github: Boolean(providers.github),
    google: Boolean(providers.google),
    microsoft: Boolean(providers.microsoft),
    oidc: Boolean(providers.oidc),
    /** The OIDC provider's button name. */
    oidc_name: providers.oidc?.label ?? "SSO",
  };
}

export type ProviderFlags = ReturnType<typeof providerFlags>;
