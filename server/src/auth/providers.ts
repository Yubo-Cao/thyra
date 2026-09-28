/**
 * Optional sign-in providers, each on only when its variables are set
 * (typically from `~/.config/thyra/auth-providers.env`, loaded by the
 * service's `EnvironmentFile`):
 *
 * - Email (Resend): `THYRA_RESEND_API_KEY` and `THYRA_EMAIL_FROM`.
 * - GitHub: `THYRA_GITHUB_CLIENT_ID` and `THYRA_GITHUB_CLIENT_SECRET`.
 * - Google: `THYRA_GOOGLE_CLIENT_ID` and `THYRA_GOOGLE_CLIENT_SECRET`.
 * - `THYRA_SIGNUP`: `invite` (default; unknown identities get no account)
 *   or `open` (they become members without grants).
 *
 * The server reads that file too (`providerEnvironment`); variables already
 * in the environment win.
 *
 * `THYRA_TEST_RESEND_URL`, `THYRA_TEST_GITHUB_URL` and
 * `THYRA_TEST_GOOGLE_URL` point a provider at a local stub server; they are
 * accepted only for loopback HTTP(S) URLs, so they can never redirect real
 * credentials elsewhere.
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

export type OAuthProviderId = "github" | "google";

export type OAuthProviderConfig = {
  id: OAuthProviderId;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** GitHub `/user` or Google's OpenID Connect userinfo. */
  userUrl: string;
  /** GitHub `/user/emails` (primary and verified flags). */
  emailsUrl?: string;
  scopes: string[];
  /** Hosts profile pictures may be imported from. */
  avatarHosts: RegExp;
};

export type AuthProviders = {
  email: EmailConfig | null;
  github: OAuthProviderConfig | null;
  google: OAuthProviderConfig | null;
  signup: SignupPolicy;
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
  return { email, github, google, signup, warnings };
}

/** Which providers the login page and account page may offer. */
export function providerFlags(providers: AuthProviders) {
  return {
    email: Boolean(providers.email),
    github: Boolean(providers.github),
    google: Boolean(providers.google),
  };
}
