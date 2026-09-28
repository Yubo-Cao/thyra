import { useCallback, useEffect, useRef, useState } from "react";
import { AtSign, KeyRound, Laptop, Link2, Network } from "lucide-react";
import { logoutBrowserSession } from "../api";
import { avatarBlob } from "../avatarImage";
import { t } from "../i18n";
import { usePrincipal } from "../principal";
import { formatUiRelativeTime } from "../uiLocale";
import { Avatar } from "./ui/Avatar";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";
import "./AccountSettings.css";

type SessionInfo = {
  id: string;
  auth_method: string;
  user_agent: string | null;
  last_seen_at: number;
  current: boolean;
};

type PasskeyInfo = {
  id: string;
  name: string | null;
  rp_id: string;
  created_at: number;
  last_used_at: number | null;
};

type IdentityInfo = {
  provider: string;
  subject: string;
  label: string;
  verified: boolean;
  has_avatar: boolean;
};

type Methods = {
  user: { name: string; display_name: string; avatar_url: string | null };
  passkeys: PasskeyInfo[];
  identities: IdentityInfo[];
  method_count: number;
  providers: { email: boolean; github: boolean; google: boolean };
  can_link_oauth: boolean;
  tailnet_visible: boolean;
};

async function request<T>(
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

/** "Firefox on Linux" from a User-Agent, for the session list. */
function browserLabel(userAgent: string | null): string {
  if (!userAgent) return t("Unknown browser");
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : null;
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  if (browser && os) return t("{browser} on {os}", { browser, os });
  return browser ?? os ?? t("Unknown browser");
}

function since(timestamp: number): string {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) return formatUiRelativeTime(seconds, "second");
  if (absolute < 3600)
    return formatUiRelativeTime(Math.round(seconds / 60), "minute");
  if (absolute < 86400)
    return formatUiRelativeTime(Math.round(seconds / 3600), "hour");
  return formatUiRelativeTime(Math.round(seconds / 86400), "day");
}

const PROVIDER_NAMES: Record<string, string> = {
  github: "GitHub",
  google: "Google",
  tailscale: "Tailscale",
};

/** How a session signed in; the tailnet is named only to those who see it. */
function methodLabel(method: string, tailnetVisible: boolean): string {
  switch (method) {
    case "passkey":
    case "enrollment":
      return t("Passkey");
    case "email":
    case "invite":
      return t("Email");
    case "github":
    case "google":
      return PROVIDER_NAMES[method]!;
    case "tailscale":
    case "tailnet-sso":
      return tailnetVisible ? "Tailscale" : t("Automatic");
    default:
      return method;
  }
}

/**
 * The Account tab: profile (name and picture), sign-in methods (passkeys,
 * GitHub, Google, email addresses), and login sessions.
 */
export function AccountSettings() {
  const principal = usePrincipal();
  const [methods, setMethods] = useState<Methods | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [email, setEmail] = useState("");
  const [emailFlow, setEmailFlow] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [methodList, sessionList] = await Promise.all([
        request<Methods>("/api/auth/methods"),
        request<{ sessions: SessionInfo[] }>("/api/auth/sessions"),
      ]);
      setMethods(methodList);
      setName(methodList.user.display_name);
      setSessions(sessionList.sessions);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);
  useEffect(() => {
    if (principal?.user) void load();
  }, [load, principal?.user]);

  const act = async (action: () => Promise<unknown>, done = "") => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await load();
      if (done) setNotice(done);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  if (!principal?.user) {
    return (
      <div className="account-settings">
        <p className="account-note">
          {t(
            "This browser uses Thyra directly on the host, without an account. Create accounts with `thyra user add` on the host.",
          )}
        </p>
      </div>
    );
  }
  const user = principal.user;
  const lastMethod = (methods?.method_count ?? 2) <= 1;
  const uploadAvatar = (blob: Blob) =>
    act(async () => {
      await request("/api/auth/avatar", await avatarBlob(blob));
    });
  const importAvatar = (provider: string) =>
    act(async () => {
      const response = await fetch(
        `/api/auth/avatar/source?provider=${provider}`,
        { credentials: "same-origin", cache: "no-store" },
      );
      if (!response.ok) throw new Error(t("Could not load that picture."));
      await request(
        "/api/auth/avatar",
        await avatarBlob(await response.blob()),
      );
    });
  const linkProvider = (provider: string) =>
    act(async () => {
      const start = await request<{ url: string }>(
        `/auth/oauth/${provider}/start`,
        { intent: "link" },
      );
      location.assign(start.url);
    });
  const identities = methods?.identities ?? [];
  const linked = (provider: string) =>
    identities.filter((identity) => identity.provider === provider);
  const removeIdentity = (identity: IdentityInfo) =>
    act(() =>
      request("/api/auth/identities/remove", {
        provider: identity.provider,
        subject: identity.subject,
      }),
    );
  const pictureSources = identities.filter(
    (identity) =>
      identity.has_avatar &&
      (identity.provider === "github" || identity.provider === "google"),
  );

  return (
    <div className="account-settings">
      <div className="config-title">{t("Profile")}</div>
      <div className="account-profile">
        <Avatar
          className="account-avatar"
          name={methods?.user.display_name ?? user.display_name}
          src={methods?.user.avatar_url ?? undefined}
        />
        <div className="account-profile-actions">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadAvatar(file);
            }}
          />
          <Button disabled={busy} onClick={() => fileRef.current?.click()}>
            {t("Upload picture")}
          </Button>
          {pictureSources.map((identity) => (
            <Button
              key={identity.provider}
              disabled={busy}
              onClick={() => void importAvatar(identity.provider)}
            >
              {t("Use {provider} picture", {
                provider: PROVIDER_NAMES[identity.provider]!,
              })}
            </Button>
          ))}
          {methods?.user.avatar_url ? (
            <Button
              disabled={busy}
              onClick={() =>
                void act(() => request("/api/auth/avatar/remove", {}))
              }
            >
              {t("Remove picture")}
            </Button>
          ) : null}
        </div>
      </div>
      <form
        className="account-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          const next = name.trim();
          if (next)
            void act(
              () => request("/api/auth/profile", { display_name: next }),
              t("Saved"),
            );
        }}
      >
        <TextField
          label={t("Display name")}
          value={name}
          onValueChange={setName}
          maxLength={80}
          fullWidth
        />
        <Button
          type="submit"
          disabled={busy || !name.trim() || name.trim() === user.display_name}
        >
          {t("Save")}
        </Button>
      </form>
      <div className="config-preference-row">
        <div className="config-item-copy">
          <strong>{user.name}</strong>
          <span>
            {user.role === "admin" ? t("Instance admin") : t("Member")}
          </span>
        </div>
        <Button
          disabled={busy}
          onClick={() => void act(() => logoutBrowserSession())}
        >
          {t("Log out")}
        </Button>
      </div>

      <div className="config-title">{t("Sign-in methods")}</div>
      {methods?.passkeys.map((passkey) => (
        <div className="config-preference-row" key={passkey.id}>
          <span className="config-item-icon">
            <KeyRound size={15} />
          </span>
          {renaming?.id === passkey.id ? (
            <form
              className="account-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void act(() =>
                  request("/api/auth/passkeys/rename", {
                    id: passkey.id,
                    name: renaming.name,
                  }),
                ).then(() => setRenaming(null));
              }}
            >
              <TextField
                aria-label={t("Passkey name")}
                value={renaming.name}
                onValueChange={(next) =>
                  setRenaming({ id: passkey.id, name: next })
                }
                maxLength={80}
                autoFocus
                fullWidth
              />
              <Button type="submit" disabled={busy}>
                {t("Save")}
              </Button>
            </form>
          ) : (
            <>
              <div className="config-item-copy">
                <strong>{passkey.name || t("Passkey")}</strong>
                <span>
                  {passkey.rp_id} ·{" "}
                  {passkey.last_used_at
                    ? t("Used {time}", { time: since(passkey.last_used_at) })
                    : t("Never used")}
                </span>
              </div>
              <Button
                disabled={busy}
                onClick={() =>
                  setRenaming({ id: passkey.id, name: passkey.name ?? "" })
                }
              >
                {t("Rename")}
              </Button>
              <Button
                disabled={busy || lastMethod}
                title={
                  lastMethod ? t("Add another way to sign in first") : undefined
                }
                onClick={() =>
                  void act(() =>
                    request("/api/auth/passkeys/remove", { id: passkey.id }),
                  )
                }
              >
                {t("Remove")}
              </Button>
            </>
          )}
        </div>
      ))}
      <Button
        className="account-add-method"
        disabled={busy || !window.isSecureContext}
        title={
          window.isSecureContext
            ? undefined
            : t("Passkeys need HTTPS or localhost")
        }
        onClick={() => location.assign("/enroll")}
      >
        <KeyRound size={14} />
        <span>
          {t("Add a passkey for {host}", { host: location.hostname })}
        </span>
      </Button>

      {(["google", "github"] as const).map((provider) => {
        const accounts = linked(provider);
        if (!methods?.providers[provider] && accounts.length === 0) return null;
        return (
          <div className="account-provider" key={provider}>
            {accounts.map((identity) => (
              <div
                className="config-preference-row"
                key={`${identity.provider}:${identity.subject}`}
              >
                <span className="config-item-icon">
                  <Link2 size={15} />
                </span>
                <div className="config-item-copy">
                  <strong>{PROVIDER_NAMES[provider]}</strong>
                  <span>{identity.label}</span>
                </div>
                <Button
                  disabled={busy || lastMethod}
                  title={
                    lastMethod
                      ? t("Add another way to sign in first")
                      : undefined
                  }
                  onClick={() => void removeIdentity(identity)}
                >
                  {t("Unlink")}
                </Button>
              </div>
            ))}
            {accounts.length === 0 &&
            methods?.providers[provider] &&
            methods.can_link_oauth ? (
              <Button
                className="account-add-method"
                disabled={busy}
                onClick={() => void linkProvider(provider)}
              >
                <Link2 size={14} />
                <span>
                  {t("Link {provider}", {
                    provider: PROVIDER_NAMES[provider]!,
                  })}
                </span>
              </Button>
            ) : null}
          </div>
        );
      })}

      {linked("email").map((identity) => (
        <div
          className="config-preference-row"
          key={`email:${identity.subject}`}
        >
          <span className="config-item-icon">
            <AtSign size={15} />
          </span>
          <div className="config-item-copy">
            <strong>{identity.label}</strong>
            <span>
              {identity.verified ? t("Email") : t("Not verified yet")}
            </span>
          </div>
          <Button
            disabled={busy || (lastMethod && identity.verified)}
            title={
              lastMethod && identity.verified
                ? t("Add another way to sign in first")
                : undefined
            }
            onClick={() => void removeIdentity(identity)}
          >
            {t("Remove")}
          </Button>
        </div>
      ))}
      {methods?.providers.email ? (
        emailFlow ? (
          <form
            className="account-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act(
                () =>
                  request("/api/auth/email/confirm", {
                    flow: emailFlow,
                    code: emailCode.trim(),
                  }),
                t("Email address added"),
              ).then(() => {
                setEmailFlow(null);
                setEmail("");
                setEmailCode("");
              });
            }}
          >
            <TextField
              label={t("Code sent to {email}", { email })}
              value={emailCode}
              onValueChange={setEmailCode}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              fullWidth
            />
            <Button
              type="submit"
              disabled={busy || emailCode.trim().length !== 6}
            >
              {t("Verify")}
            </Button>
          </form>
        ) : (
          <form
            className="account-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                const sent = await request<{ flow: string }>(
                  "/api/auth/email/add",
                  { email: email.trim() },
                );
                setEmailFlow(sent.flow);
              });
            }}
          >
            <TextField
              label={t("Add an email address")}
              type="email"
              value={email}
              onValueChange={setEmail}
              autoComplete="email"
              placeholder="you@example.com"
              fullWidth
            />
            <Button type="submit" disabled={busy || !email.includes("@")}>
              {t("Send code")}
            </Button>
          </form>
        )
      ) : null}

      {methods?.tailnet_visible
        ? linked("tailscale").map((identity) => (
            <div
              className="config-preference-row"
              key={`tailscale:${identity.subject}`}
            >
              <span className="config-item-icon">
                <Network size={15} />
              </span>
              <div className="config-item-copy">
                <strong>Tailscale</strong>
                <span>{identity.label}</span>
              </div>
            </div>
          ))
        : null}

      <div className="account-heading-row">
        <div className="config-title">{t("Login sessions")}</div>
        {sessions && sessions.length > 1 ? (
          <Button
            disabled={busy}
            onClick={() =>
              void act(() => request("/api/auth/sessions/revoke-others", {}))
            }
          >
            {t("Sign out everywhere else")}
          </Button>
        ) : null}
      </div>
      {sessions?.map((session) => (
        <div className="config-preference-row" key={session.id}>
          <span className="config-item-icon">
            <Laptop size={15} />
          </span>
          <div className="config-item-copy">
            <strong>
              {browserLabel(session.user_agent)}
              {session.current ? ` · ${t("This device")}` : ""}
            </strong>
            <span>
              {methodLabel(
                session.auth_method,
                Boolean(methods?.tailnet_visible),
              )}{" "}
              · {since(session.last_seen_at)}
            </span>
          </div>
          {session.current ? null : (
            <Button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  request("/api/auth/sessions/revoke", { id: session.id }),
                )
              }
            >
              {t("Sign out")}
            </Button>
          )}
        </div>
      ))}
      {notice ? (
        <p className="account-note" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
