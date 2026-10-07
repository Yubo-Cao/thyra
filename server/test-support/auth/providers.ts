import { createHash, randomBytes } from "node:crypto";

/**
 * Stub Resend, GitHub and Google servers on loopback, for tests and manual
 * end-to-end runs (`THYRA_TEST_RESEND_URL`, `THYRA_TEST_GITHUB_URL`,
 * `THYRA_TEST_GOOGLE_URL` all point at `base`). The authorize endpoints
 * approve at once and redirect back with a code; the token endpoints check
 * the client secret, the redirect URI and the PKCE verifier.
 */

export type StubMail = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
};

export type GitHubProfile = {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  emails: { email: string; primary: boolean; verified: boolean }[];
};

export type GoogleProfile = {
  sub: string;
  email: string | null;
  email_verified: boolean;
  name: string | null;
  picture: string | null;
};

type Grant = {
  provider: "github" | "google";
  challenge: string;
  redirectUri: string;
  profile: GitHubProfile | GoogleProfile;
};

/** A 32x32 PNG, for picture imports. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAMUlEQVR4nGPQqDhBU8QwasFoEI2motF8MFpUjJamo/XBaJU52qoYbReNNh0rhkg+AACLl6BMqlXGYAAAAABJRU5ErkJggg==",
  "base64",
);

export async function startStubProviders(
  options: { apiKey?: string; clientSecret?: string } = {},
) {
  const apiKey = options.apiKey ?? "re_test_key";
  const clientSecret = options.clientSecret ?? "test-secret";
  const mail: StubMail[] = [];
  const grants = new Map<string, Grant>();
  const tokens = new Map<string, Grant>();
  const failures: string[] = [];
  let base = "";
  const state = {
    github: {
      id: 101,
      login: "octocat",
      name: "Octo Cat",
      avatar_url: "",
      emails: [{ email: "octo@example.com", primary: true, verified: true }],
    } as GitHubProfile,
    google: {
      sub: "google-sub-1",
      email: "person@example.com",
      email_verified: true,
      name: "Pat Person",
      picture: "",
    } as GoogleProfile,
    /** Answer the next Resend call with this status. */
    resendStatus: 200,
  };

  const json = (body: unknown, status = 200) => Response.json(body, { status });

  function authorize(provider: "github" | "google", url: URL): Response {
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (
      url.searchParams.get("code_challenge_method") !== "S256" ||
      !challenge ||
      !url.searchParams.get("state")
    ) {
      failures.push("authorize without PKCE or state");
      return new Response("PKCE and state required", { status: 400 });
    }
    const code = randomBytes(16).toString("hex");
    grants.set(code, {
      provider,
      challenge,
      redirectUri,
      profile: structuredClone(state[provider]),
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state")!);
    return Response.redirect(back.href, 302);
  }

  async function token(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const auth = req.headers.get("authorization") ?? "";
    const [, secret] = Buffer.from(auth.replace(/^Basic /, ""), "base64")
      .toString()
      .split(":");
    const grant = grants.get(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (
      !grant ||
      secret !== clientSecret ||
      grant.redirectUri !== form.get("redirect_uri") ||
      grant.challenge !== challenge
    ) {
      failures.push("token exchange refused");
      return json({ error: "invalid_grant" }, 400);
    }
    grants.delete(form.get("code")!);
    const access = randomBytes(16).toString("hex");
    tokens.set(access, grant);
    return json({
      access_token: access,
      token_type: "bearer",
      expires_in: 3600,
    });
  }

  function profile(req: Request, kind: "github" | "emails" | "google") {
    const grant = tokens.get(
      (req.headers.get("authorization") ?? "").replace(/^Bearer /, ""),
    );
    if (!grant) return json({ message: "Bad credentials" }, 401);
    if (kind === "google") return json(grant.profile);
    const github = grant.profile as GitHubProfile;
    if (kind === "emails") return json(github.emails);
    return json({
      id: github.id,
      login: github.login,
      name: github.name,
      avatar_url: github.avatar_url,
    });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      switch (`${req.method} ${url.pathname}`) {
        case "POST /emails": {
          if (req.headers.get("authorization") !== `Bearer ${apiKey}`)
            return json({ message: "invalid key" }, 401);
          if (state.resendStatus !== 200)
            return json({ message: "stub failure" }, state.resendStatus);
          const body = (await req.json()) as StubMail;
          mail.push(body);
          return json({ id: `email_${mail.length}` });
        }
        case "GET /login/oauth/authorize":
          return authorize("github", url);
        case "GET /o/oauth2/v2/auth":
          return authorize("google", url);
        case "POST /login/oauth/access_token":
        case "POST /token":
          return token(req);
        case "GET /user":
          return profile(req, "github");
        case "GET /user/emails":
          return profile(req, "emails");
        case "GET /v1/userinfo":
          return profile(req, "google");
        case "GET /avatar.png":
          return new Response(PNG, {
            headers: { "content-type": "image/png" },
          });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  state.github.avatar_url = `${base}/avatar.png`;
  state.google.picture = `${base}/avatar.png`;

  return {
    base,
    apiKey,
    clientSecret,
    mail,
    state,
    failures,
    /** The newest message to an address. */
    lastMailTo(address: string): StubMail | undefined {
      return mail.filter((entry) => entry.to.includes(address)).at(-1);
    },
    /** Environment that points Thyra at these stubs. */
    env(): Record<string, string> {
      return {
        THYRA_RESEND_API_KEY: apiKey,
        THYRA_EMAIL_FROM: "Thyra <login@example.com>",
        THYRA_TEST_RESEND_URL: base,
        THYRA_GITHUB_CLIENT_ID: "github-client",
        THYRA_GITHUB_CLIENT_SECRET: clientSecret,
        THYRA_TEST_GITHUB_URL: base,
        THYRA_GOOGLE_CLIENT_ID: "google-client",
        THYRA_GOOGLE_CLIENT_SECRET: clientSecret,
        THYRA_TEST_GOOGLE_URL: base,
      };
    },
    stop: () => server.stop(true),
  };
}

/** The 6-digit code and link secret in a sign-in message. */
export function mailedSecrets(mail: StubMail): {
  code: string;
  flow: string;
  link: string;
} {
  const code = mail.text.match(/\b(\d{6})\b/)?.[1] ?? "";
  const [flow = "", link = ""] = (
    mail.text.match(/\/auth\/email#([^\s]+)/)?.[1] ?? ""
  ).split(".");
  return { code, flow, link };
}
